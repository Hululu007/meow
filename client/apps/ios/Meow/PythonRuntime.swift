#if !targetEnvironment(simulator)
import Foundation

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
        let scripts = docs.appendingPathComponent("py-scripts", isDirectory: true)
        try? fm.createDirectory(at: scripts, withIntermediateDirectories: true)
        try? fm.createDirectory(at: scripts.appendingPathComponent("py"), withIntermediateDirectories: true)

        // C 扩展在 App.app/Frameworks/pyext（侧载器只对 Frameworks 递归签名；
        // 放 resources 里的 Mach-O 会因无签名 dlopen 失败）
        let pyext = Bundle.main.bundlePath + "/Frameworks/pyext"
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
        // 标记裁剪版运行时：pyrt 遇到 lxml/pyquery ImportError 时给出准确提示
        setenv("MEOW_PY_TRIM", "1", 1)

        let logPath = docs.appendingPathComponent("py.log")
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
    static func waitHealthy(timeout: TimeInterval) -> Bool {
        guard started else { return false }
        let deadline = Date().addingTimeInterval(timeout)
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        while Date() < deadline {
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
            Thread.sleep(forTimeInterval: 0.4)
        }
        let tail = logTail()
        record("failed", tail.isEmpty ? "25 秒内 /health 未就绪（Documents/py.log 为空）" : tail)
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
            // 面板只展示前 400 字；更长的回溯在 Documents/py.log
            st["error"] = String(error.suffix(400))
        }
        obj["pyRuntime"] = st
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted]) {
            try? fm.createDirectory(at: f.deletingLastPathComponent(),
                                    withIntermediateDirectories: true)
            try? data.write(to: f, options: .atomic)
        }
    }

    /// 读 py.log 尾部（启动失败的 traceback 通常就在最后几行）。
    private static func logTail() -> String {
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let f = docs.appendingPathComponent("py.log")
        guard let data = try? Data(contentsOf: f), !data.isEmpty else { return "" }
        let text = String(decoding: data, as: UTF8.self)
        return String(text.suffix(800))
    }
}
#endif
