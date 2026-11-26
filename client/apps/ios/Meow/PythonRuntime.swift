#if !targetEnvironment(simulator)
import Foundation
import UIKit

/// 端内 CPython（Python 3.12）+ pyrt：让 `.py` 源完全离线，和 PC/Docker 同构。
///
/// <p>形态：Python 以动态库形式跑在 App 进程里（`Python.framework`，embed），
/// 在后台线程 `Py_Initialize` 后执行包内的 `runtime/pyrt.py`，pyrt 监听
/// 127.0.0.1:19331；`.js` 请求由 pyrt 转发给同进程的 drpy（19330）。
///
/// <p>宿主只认 `policy.json` 的 `jsRuntime` 一个地址：Python 可用时指向 pyrt，
/// 不可用时退回 drpy（NodeBridge 负责写）。这样 `.py`/`.js` 都是本地执行，
/// 不需要局域网里再有一台 PC。
///
/// <p>★ 启动状态写进 `policy.json` 的 `pyRuntime`（state/error/at）：
/// 设置页通过 `/api/policy` 就能拿到，不再靠"地址是不是 19331"猜 ——
/// 之前用户看到的是「CPython 未知」，既不知道是没打包、没签名还是 import 失败。
/// 真正的 traceback 在 `Documents/py.log`（Python 的 stdout/stderr 被 C 桥重定向）。
///
/// <p>包体（2026-11-26 实测裁剪后）：framework 2.1MB + runtime 6.9MB（zip 后）。
enum PythonRuntime {
    static let port = 19331

    private static var started = false
    private static let lock = NSLock()
    /** 后台启动被推迟时挂的回前台观察者（只挂一次） */
    private static var foregroundObserver: NSObjectProtocol?

    /// 后台时把启动推迟到回前台（见 startIfPossible 的注释）。
    private static func scheduleOnForeground() {
        guard foregroundObserver == nil else { return }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main,
        ) { _ in
            if let ob = foregroundObserver {
                NotificationCenter.default.removeObserver(ob)
                foregroundObserver = nil
            }
            startIfPossible()
        }
        LaunchLog.write("[py] start deferred until foreground")
    }

    /// 启动一次（幂等）。由 NodeBridge 在 drpy 起来后调用。
    static func startIfPossible() {
        lock.lock()
        defer { lock.unlock() }
        guard !started else { return }
        let fm = FileManager.default
        guard let res = Bundle.main.resourceURL else { return }
        // project.yml 把 build/python/runtime 作为 folder 资源整目录拷进 bundle
        let home = res.appendingPathComponent("runtime", isDirectory: true)
        let script = home.appendingPathComponent("pyrt.py")
        guard fm.fileExists(atPath: script.path),
              fm.fileExists(atPath: home.appendingPathComponent("lib/python3.12/encodings/__init__.py").path)
        else {
            LaunchLog.write("[py] payload not bundled; py sources stay remote-only")
            record("unavailable", "安装包里没有 runtime/pyrt.py（旧版包或构建漏拷）")
            return
        }
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        /*
         * ★ 后台不启动：App 一进后台，整个进程被系统挂起，25 秒探活窗口会被
         *   墙钟耗光；回前台时 Python 线程甚至还没拿到 CPU，这里就先记成
         *   failed 并把 jsRuntime 永久留在 drpy（2026-11-26 真机实测：
         *   13:23:36 node 就绪、13:23:39 切后台，py.log 里连
         *   "[meow-py] start" 都还没出现）。改为回前台再起。
         */
        if UIApplication.shared.applicationState == .background {
            record("pending", "等回前台再启动（后台挂起会耗光初始化窗口）")
            scheduleOnForeground()
            return
        }
        let scripts = docs.appendingPathComponent("py-scripts", isDirectory: true)
        try? fm.createDirectory(at: scripts, withIntermediateDirectories: true)
        try? fm.createDirectory(at: scripts.appendingPathComponent("py"), withIntermediateDirectories: true)

        // C 扩展在 App.app/Frameworks/pyext（侧载器只对 Frameworks 递归签名；
        // 放 resources 里的 Mach-O 会因无签名 dlopen 失败）
        let pyext = Bundle.main.bundlePath + "/Frameworks/pyext"
        let logPath = docs.appendingPathComponent("py.log")
        setenv("PYTHONHOME", home.path, 1)
        setenv("PYTHONPATH",
               pyext + ":"
               + home.appendingPathComponent("lib/python3.12").path + ":"
               + home.appendingPathComponent("lib/python3.12/site-packages").path, 1)
        // bundle 只读：不写 __pycache__（否则每次启动都在只读卷上失败刷日志）
        setenv("PYTHONDONTWRITEBYTECODE", "1", 1)
        setenv("PYRT_PORT", "\(port)", 1)
        setenv("PYRT_BIND", "127.0.0.1", 1)
        setenv("PYRT_DRPY", "http://127.0.0.1:\(NodeBridge.drpyPort)", 1)
        setenv("PYRT_SCRIPTS", scripts.path, 1)
        setenv("PYTHONUNBUFFERED", "1", 1)
        /*
         * pyrt.py 用它兜底 sys.stdout/stderr：端内 CPython 默认不配置 C stdio，
         * 流是 None 时第一次 print 就抛 AttributeError，且 traceback 无处可写。
         * pyrt 的 __main__ 也会把致命异常直接写进这个文件。
         */
        setenv("MEOW_PY_LOG", logPath.path, 1)
        // 标记裁剪版运行时：pyrt 遇到 lxml/pyquery ImportError 时给出准确提示
        setenv("MEOW_PY_TRIM", "1", 1)

        // 每次启动保留上一轮的回溯（追加写），但别无限长：超过 64KB 直接重开
        if let attrs = try? fm.attributesOfItem(atPath: logPath.path),
           let sz = attrs[.size] as? NSNumber, sz.intValue > 64 * 1024 {
            try? fm.removeItem(at: logPath)
        }
        record("starting", "")
        started = meow_py_start(script.path, logPath.path) == 0
        LaunchLog.write("[py] start \(started ? "ok" : "failed") home=\(home.lastPathComponent)")
        if !started {
            record("failed", "pthread 创建失败（日志见 Documents/py.log）")
        }
    }

    /// 探活：GET /health 返回 200 即就绪。结果同时写回 policy.pyRuntime。
    ///
    /// <p>★ 只累计**前台时间**：App 在后台时进程被挂起，墙钟照样走但 Python
    /// 线程一步也跑不了。按墙钟计时会把「刚启动就切后台」误判成启动失败。
    static func waitHealthy(timeout: TimeInterval) -> Bool {
        guard started else { return false }
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        var waited: TimeInterval = 0
        while waited < timeout {
            if UIApplication.shared.applicationState == .background {
                Thread.sleep(forTimeInterval: 0.5)
                continue
            }
            let began = Date()
            var ok = false
            var req = URLRequest(url: url)
            req.timeoutInterval = 2
            let sem = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                if let http = resp as? HTTPURLResponse { ok = http.statusCode == 200 }
                sem.signal()
            }.resume()
            _ = sem.wait(timeout: .now() + 3)
            if ok {
                record("running", "")
                return true
            }
            waited += Date().timeIntervalSince(began) + 0.4
            Thread.sleep(forTimeInterval: 0.4)
        }
        let tail = logTail()
        record("failed", tail.isEmpty ? "\(Int(timeout)) 秒内 /health 未就绪（Documents/py.log 为空）" : tail)
        LaunchLog.write("[py] log tail: \(tail.suffix(300))")
        return false
    }

    // MARK: - 状态落盘

    private static func record(_ state: String, _ error: String) {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let f = docs.appendingPathComponent("gateway/policy.json")
        var obj: [String: Any] = [:]
        if let data = try? Data(contentsOf: f),
           let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            obj = j
        }
        var st: [String: Any] = [
            "state": state,
            "port": port,
            "at": Int(Date().timeIntervalSince1970),
        ]
        if !error.isEmpty {
            /*
             * 面板只展示最后几行，但**存**要留够：上一版只存 400 字，结果把
             * `[meow-py] start` / traceback 全截掉了，只剩后续 NSLog，白瞎一次
             * 真机验证（2026-11-26）。
             */
            st["error"] = String(error.suffix(1600))
        }
        obj["pyRuntime"] = st
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
            try? fm.createDirectory(at: f.deletingLastPathComponent(),
                                    withIntermediateDirectories: true)
            try? data.write(to: f, options: .atomic)
        }
    }

    /// 读 py.log 里**本轮 Python 启动**那一段。
    ///
    /// <p>py.log 是进程级 stderr 重定向，LaunchLog 的 NSLog 也会混进来。
    /// 直接取文件尾巴会只剩后面的日志；从最后一个 `[meow-py]` 标记开始截，
    /// 才能拿到 `start` / `initialized` / traceback。没有标记说明 C 线程
    /// 一步都没跑（后台挂起或线程创建后未调度），要显式说出来。
    private static func logTail() -> String {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let f = docs.appendingPathComponent("py.log")
        guard let data = try? Data(contentsOf: f), !data.isEmpty else { return "" }
        let text = String(decoding: data, as: UTF8.self)
        if let r = text.range(of: "[meow-py]", options: .backwards) {
            return String(text[r.lowerBound...].suffix(1600))
        }
        return "（py.log 里没有 [meow-py] 记录：Python 线程尚未执行，通常是启动后立刻切后台）\n"
            + String(text.suffix(600))
    }
}
#endif
