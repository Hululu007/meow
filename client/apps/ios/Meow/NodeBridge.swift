import Foundation

#if !targetEnvironment(simulator)

/// 端内 Node 运行时（nodejs-mobile）—— 对齐 TV 的「运行时模块 + danmu_api 载荷」。
///
/// <p>形态不同、功能相同：TV 是一个独立的 `:node` 进程，iOS 不允许 fork/exec，
/// 只能把 node 以**库**的形式跑在 App 进程里（nodejs-mobile 的 V8 启动即关 JIT）。
///
/// <p>载荷（danmu_api 的 ~40MB 运行期文件）打进 IPA，首次启动拷到 Documents，
/// 之后直接跑那份；包里的版本升级（`.payload-version` 变化）会重拷。
///
/// <p>**失败不影响主流程**：没载荷 / node 起不来 / 端口没通 → 只写日志，
/// JVM 宿主继续用内置弹幕源（弹弹play + 镜像）。
enum NodeBridge {
    /// 固定端口：TV 的 manifest 默认 9321，这里挪到 19321 避免与 PC 插件/别的壳撞。
    private static let port = 19321

    private static let lock = NSLock()
    private static var started = false

    /// nodejs-mobile 唯一对外的 C 接口：`int node_start(int argc, char *argv[])`。
    /// 用 @_silgen_name 直接声明，避免依赖框架的 modulemap。
    @_silgen_name("node_start")
    private static func node_start(_ argc: Int32,
                                   _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> Int32

    /// 在后台起 node；只生效一次。
    static func startIfPossible() {
        DispatchQueue.global(qos: .utility).async {
            lock.lock()
            if started {
                lock.unlock()
                return
            }
            started = true
            lock.unlock()
            bootstrap()
        }
    }

    private static func bootstrap() {
        guard let dir = installPayloadIfNeeded() else { return }
        let script = dir.appendingPathComponent("danmu_api/server.js").path
        guard FileManager.default.fileExists(atPath: script) else {
            LaunchLog.write("[node] server.js missing")
            return
        }
        // 进程级环境变量：danmu_api 读的就是这些（与 TV 的 manifest 一致）
        setenv("DANMU_API_PORT", "\(port)", 1)
        setenv("DANMU_API_BIND", "127.0.0.1", 1)
        setenv("DANMU_API_PROXY_PORT", "0", 1)
        setenv("SOURCE_ORDER", "360,bilibili,tencent,iqiyi,youku,mango,migu,sohu", 1)
        setenv("NODE_ENV", "production", 1)
        chdir(dir.path)

        let nodeThread = Thread {
            LaunchLog.write("[node] node_start begin")
            // argv 必须活到 node 退出：malloc 出来不释放（进程级只有一个 node）
            let argv: [UnsafeMutablePointer<CChar>?] = [strdup("node"), strdup(script), nil]
            var ptr = argv
            let rc = ptr.withUnsafeMutableBufferPointer { buf in
                node_start(Int32(buf.count - 1), buf.baseAddress)
            }
            LaunchLog.write("[node] node_start returned \(rc)")
        }
        nodeThread.name = "meow-node"
        nodeThread.stackSize = 8 * 1024 * 1024
        nodeThread.start()

        let waiter = Thread { waitHealthyThenInject() }
        waiter.name = "meow-node-health"
        waiter.start()
    }

    /// 包内载荷 → Documents（版本变了重拷）。返回可写的载荷目录。
    private static func installPayloadIfNeeded() -> URL? {
        let fm = FileManager.default
        guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("danmu-api"),
              fm.fileExists(atPath: bundled.appendingPathComponent("danmu_api/server.js").path) else {
            LaunchLog.write("[node] payload not bundled; keep built-in danmaku")
            return nil
        }
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dest = docs.appendingPathComponent("danmu-api", isDirectory: true)
        let want = version(at: bundled)
        let have = version(at: dest)
        if !want.isEmpty, want == have,
           fm.fileExists(atPath: dest.appendingPathComponent("danmu_api/server.js").path) {
            return dest
        }
        do {
            try? fm.removeItem(at: dest)
            try fm.copyItem(at: bundled, to: dest)
            LaunchLog.write("[node] payload installed \(want)")
            return dest
        } catch {
            LaunchLog.write("[node] payload copy failed: \(error.localizedDescription)")
            return nil
        }
    }

    private static func version(at dir: URL) -> String {
        let f = dir.appendingPathComponent(".payload-version")
        let text = (try? String(contentsOf: f, encoding: .utf8)) ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 探活 → 把地址写进 `gateway/danmaku-host.txt`（宿主每次请求读它）。
    private static func waitHealthyThenInject() {
        let probe = "http://127.0.0.1:\(port)/api/v2/fongmi/danmaku?name=test&episode=1"
        let deadline = Date().addingTimeInterval(240)
        while Date() < deadline {
            if httpOK(probe) {
                let tpl = "http://127.0.0.1:\(port)/api/v2/fongmi/danmaku?name={name}&episode={episode}"
                let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let f = docs.appendingPathComponent("gateway/danmaku-host.txt")
                do {
                    try tpl.write(to: f, atomically: true, encoding: .utf8)
                    LaunchLog.write("[node] healthy; danmaku host injected")
                } catch {
                    LaunchLog.write("[node] write host failed: \(error.localizedDescription)")
                }
                return
            }
            Thread.sleep(forTimeInterval: 3)
        }
        LaunchLog.write("[node] health timeout (built-in danmaku stays)")
    }

    /// 同步 GET：成功 = 200 且非空。node 刚起来时端口可能还没监听，用短超时。
    private static func httpOK(_ url: String) -> Bool {
        guard let u = URL(string: url) else { return false }
        var ok = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: u)
        req.timeoutInterval = 25
        req.setValue("meow-ios", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            if let http = resp as? HTTPURLResponse {
                ok = http.statusCode == 200 && (data?.count ?? 0) > 0
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 30)
        return ok
    }
}

#endif
