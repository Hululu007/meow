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

        started = meow_py_start(script.path) == 0
        LaunchLog.write("[py] start \(started ? "ok" : "failed") home=\(home.lastPathComponent)")
    }

    /// 探活：GET /health 返回 200 即就绪。
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
            if ok { return true }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return false
    }
}
#endif
