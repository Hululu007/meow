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
            if crashLooping() { return }
            bootstrap()
        }
    }

    // MARK: - 崩溃环保护
    //
    // node 跑在 App 进程里，任何带走 node 的问题（native abort / 我们没拦住的
    // 退出）都会让 App 一起退。真机上出现过「启动几秒后自动退出」：如果每次
    // 启动都照起 node，用户会陷进「打开就退」的死循环，连设置页都进不去。
    // 这里记「上次启动时间 + 连续快速重启次数」，>=2 次就本轮跳过 node
    // （日志里留一行），App 至少能正常用，弹幕走内置源。

    private static let bootAtKey = "meow.node.bootAt"
    private static let bootCountKey = "meow.node.bootCount"
    /// 两次启动间隔小于这个值才算「快速重启」
    private static let crashWindow: TimeInterval = 30

    private static func crashLooping() -> Bool {
        let d = UserDefaults.standard
        let now = Date().timeIntervalSince1970
        let last = d.double(forKey: bootAtKey)
        var count = d.integer(forKey: bootCountKey)
        if last > 0, now - last < crashWindow {
            count += 1
        } else {
            count = 1
        }
        d.set(now, forKey: bootAtKey)
        d.set(count, forKey: bootCountKey)
        if count >= 2 {
            LaunchLog.write("[node] rapid restart detected (count=\(count)); skip node this launch")
            return true
        }
        return false
    }

    /// 活了 5 分钟算「稳定」，清掉崩溃环计数（下次正常起）。
    private static func scheduleStableReset() {
        let t = Thread {
            Thread.sleep(forTimeInterval: 300)
            UserDefaults.standard.set(0, forKey: bootCountKey)
        }
        t.name = "meow-node-stable"
        t.start()
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

        /*
         * ★ 必须用入口包装，不能直接跑 server.js（2026-11-24 真机实测：启动
         *   几秒后 App「自动退出」——node 的 stderr 里是
         *   `ReferenceError: WebAssembly is not defined`（nodejs-mobile 的 V8 没编
         *   WASM，内置 fetch/undici 一初始化就抛），未捕获 → node 退出 →
         *   因为 node 跑在 App 进程里，App 跟着退）。
         *
         * 包装层做三件事：
         *   1) 把全局 fetch 换成 node-fetch（不依赖 WASM）；
         *   2) 拦下 uncaughtException / unhandledRejection，只记日志；
         *   3) 屏蔽 process.exit —— 任何 JS 侧退出都不许带走 App。
         */
        let entry = writeEntryWrapper(in: dir, serverScript: script)
        let entryPath = entry?.path ?? script

        let nodeThread = Thread {
            LaunchLog.write("[node] node_start begin")
            // argv 必须活到 node 退出：malloc 出来不释放（进程级只有一个 node）
            let argv: [UnsafeMutablePointer<CChar>?] = [
                strdup("node"),
                strdup("--unhandled-rejections=warn"),
                strdup(entryPath),
                nil,
            ]
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

    /// 写入口包装 `meow-entry.cjs`（每次覆盖，内容跟壳版本走）。
    private static func writeEntryWrapper(in dir: URL, serverScript: String) -> URL? {
        let rel = serverScript.hasPrefix(dir.path)
            ? String(serverScript.dropFirst(dir.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            : "danmu_api/server.js"
        let js = """
        // 猫窝 iOS 壳生成的入口（勿手改）。nodejs-mobile 跑在 App 进程里，
        // node 一退 App 就退 —— 这里把所有 JS 侧退出拦住，并把 fetch 换成 node-fetch。
        const LOG = (m, e) => { try { console.error('[meow-guard] ' + m, (e && (e.stack || e.message)) || e || ''); } catch (_) {} };
        process.on('unhandledRejection', (e) => LOG('unhandledRejection', e));
        process.on('uncaughtException', (e) => LOG('uncaughtException', e));
        process.exit = (code) => { LOG('blocked process.exit(' + code + ')'); };
        if (typeof process.reallyExit === 'function') {
          process.reallyExit = (code) => { LOG('blocked reallyExit(' + code + ')'); };
        }
        (async () => {
          try {
            const m = await import('node-fetch');
            const f = m && (m.default || m);
            // ★ 必须用 defineProperty 覆盖：Node 18 的 globalThis.fetch 是
            //   「惰性 getter」，直接赋值可能触发 getter 去加载内置 undici，
            //   而那正是没有 WebAssembly 会炸的东西。
            if (typeof f === 'function') {
              Object.defineProperty(globalThis, 'fetch', { value: f, configurable: true, writable: true });
            }
            if (m && m.Headers && typeof globalThis.Headers === 'undefined') globalThis.Headers = m.Headers;
            if (m && m.Request && typeof globalThis.Request === 'undefined') globalThis.Request = m.Request;
            if (m && m.Response && typeof globalThis.Response === 'undefined') globalThis.Response = m.Response;
            LOG('fetch -> node-fetch');
          } catch (e) {
            LOG('node-fetch unavailable', e);
          }
          try {
            await import('./\(rel)');
          } catch (e) {
            LOG('server import failed', e);
          }
        })();
        """
        let f = dir.appendingPathComponent("meow-entry.cjs")
        do {
            try js.write(to: f, atomically: true, encoding: .utf8)
            return f
        } catch {
            LaunchLog.write("[node] entry wrapper failed: \(error.localizedDescription)")
            return nil
        }
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
    ///
    /// ★ 只探根路径「有没有 HTTP 响应」，**不拿 ?name=test 打真实搜索**。
    ///   真机实测（2026-11-24）：首启那次搜索会点着 danmu_api 的 fetch 路径，
    ///   nodejs-mobile 的 V8 没有 WebAssembly → undici 抛 ReferenceError →
    ///   node 退出 → App 跟着退（表现为「启动几秒后自动退出」）。
    ///   根路径 404 也算活着，弹幕请求等真播放时再发。
    private static func waitHealthyThenInject() {
        let probe = "http://127.0.0.1:\(port)/"
        let deadline = Date().addingTimeInterval(240)
        while Date() < deadline {
            if httpAlive(probe) {
                let tpl = "http://127.0.0.1:\(port)/api/v2/fongmi/danmaku?name={name}&episode={episode}"
                let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let f = docs.appendingPathComponent("gateway/danmaku-host.txt")
                do {
                    try tpl.write(to: f, atomically: true, encoding: .utf8)
                    LaunchLog.write("[node] healthy; danmaku host injected")
                    scheduleStableReset()
                } catch {
                    LaunchLog.write("[node] write host failed: \(error.localizedDescription)")
                }
                return
            }
            Thread.sleep(forTimeInterval: 3)
        }
        LaunchLog.write("[node] health timeout (built-in danmaku stays)")
    }

    /// 同步 GET：拿到任何 HTTP 响应（状态 < 500）就算「服务活着」。
    ///
    /// 不要求 200：danmu_api 没有根路由（404 很正常），而 5xx 说明它虽然监听了
    /// 但坏了，注入进去只会让每次弹幕请求都报错 —— 宁可等下次启动再试。
    private static func httpAlive(_ url: String) -> Bool {
        guard let u = URL(string: url) else { return false }
        var alive = false
        let sem = DispatchSemaphore(value: 0)
        var req = URLRequest(url: u)
        req.timeoutInterval = 10
        req.setValue("meow-ios", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse {
                alive = http.statusCode < 500
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 15)
        return alive
    }
}

#endif
