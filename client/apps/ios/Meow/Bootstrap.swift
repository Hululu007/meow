import Foundation

/// 启动顺序：
///  1. 准备沙盒数据目录（首次启动播种空配置）
///  2. 在 9979 起静态文件服务（web/dist）
///  3. 真机：静态链接的 OpenJDK 9 Zero 起在进程内，ApiServer 监听 9978
///     模拟器：不内嵌 JVM，用 `--api-base` 指向 macOS 上的 ApiServer 做 UI 验证
///  4. WebView 打开 http://127.0.0.1:9979/，注入 localStorage['meow.api']
@MainActor
final class Bootstrap: ObservableObject {
    @Published var webURL: URL?
    @Published var webReady = false
    /// 只有"连界面都起不来"才算失败；进度不再往界面上写文字 ——
    /// 开屏页（品牌图标）负责盖住整个启动过程（2026-11-24 用户要求）。
    @Published var failed = false
    @Published var failText = ""

    /// 不参与观察：webURL 变化时 RootView 已经会重建 WebView。
    var bootScript = ""

    private let staticServer = StaticServer()
    private var started = false
    private var staticWatchdog: Timer?

    nonisolated init() {}

    func start() {
        guard !started else { return }
        started = true
        Task { await boot() }
    }

    /** 开屏页上的「重试」：整条启动链路重跑（静态服务先停掉，端口才回得来）。 */
    func retry() {
        guard failed else { return }
        failed = false
        failText = ""
        webURL = nil
        webReady = false
        staticServer.stop()
        started = false
        start()
    }

    private func fail(_ text: String) {
        failed = true
        failText = text
        LaunchLog.write("boot failed: \(text)")
    }

    private func boot() async {
        LaunchLog.write("boot start")
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dataDir = docs.appendingPathComponent("gateway", isDirectory: true)
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        LaunchLog.write("data dir ready: \(dataDir.path)")

        // 远程调试要求屏幕别自动锁：息屏 = App 挂起 = 网关端口消失（重启后自动恢复上次选择）
        ScreenAwake.restore()

        // 首次启动：拷一份空配置（0 站）。用户从设置页导入源包后覆盖。
        let config = dataDir.appendingPathComponent("config.sites.json")
        if !fm.fileExists(atPath: config.path),
           let seed = Bundle.main.url(forResource: "config.sites.example", withExtension: "json") {
            try? fm.copyItem(at: seed, to: config)
        }

        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"),
              fm.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            fail("缺少 web 资源（先构建 client/apps/web）")
            return
        }

        do {
            try await staticServer.start(root: webRoot, port: 9979)
            LaunchLog.write("static server on 9979")
        } catch {
            fail("静态服务启动失败：\(error.localizedDescription)")
            return
        }

        var base = ""
        #if targetEnvironment(simulator)
        base = Self.argValue("--api-base") ?? ""
        #else
        // ★ JVM 不可用时**不要 return**：界面（网页）照常加载，只是本地网关不可用。
        //   之前这里 return 会让 webURL 永远是 nil → 用户只看到转圈 + 一句提示，
        //   连首页/设置页都进不去（C 包实测）。
        if JvmBridge.isAvailable() {
            let javaHome = Bundle.main.resourceURL!.appendingPathComponent("openjdk").path
            let classPath = Self.hostClassPath()
            LaunchLog.write("jvm start (classpath \(classPath.count) chars)")
            let ok: Bool = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                JvmBridge.start(withJavaHome: javaHome,
                                classPath: classPath,
                                dataDir: dataDir.path,
                                port: 9978) { started, why in
                    LaunchLog.write("jvm start returned ok=\(started) why=\(why ?? "-")")
                    continuation.resume(returning: started)
                }
            }
            if ok {
                base = "http://127.0.0.1:9978"
                if !(await Self.waitHealth(base: base, attempts: 120)) {
                    // 不算致命：网页照样能进，首页自己会显示「后端未连接」并提供刷新
                    LaunchLog.write("health wait failed" + Self.logTailHint())
                } else {
                    LaunchLog.write("health ok")
                }
            } else {
                LaunchLog.write("jvm start failed" + Self.logTailHint())
            }
        } else {
            LaunchLog.write("jvm resources missing; loading web without backend")
        }
        #endif

        let site = Self.argValue("--site") ?? ""
        bootScript = Self.makeBootScript(base: base, site: site)
        webURL = URL(string: "http://127.0.0.1:9979/")
        LaunchLog.write("web url set (base=\(base.isEmpty ? "none" : base))")
        startStaticWatchdog()

        #if !targetEnvironment(simulator)
        /*
         * 端内弹幕载荷（nodejs-mobile + danmu_api）：后台起，不挡界面。
         * 起不来只写日志 —— JVM 宿主会继续用内置弹幕源。
         */
        NodeBridge.startIfPossible()
        #endif
    }

    /// 静态服务 15s 探活：失效就在原端口重建（见 StaticServer.ensureServing）。
    ///
    /// <p>2026-11-25 真机：切后台回来后 Java 网关被看门狗救活了，但 9979 的
    /// NWListener 没人管 —— 表现是「API 正常，点搜索/剧集没反应」（懒加载 chunk
    /// 全拉不到）。这个定时器把静态服务也纳入保活。
    private func startStaticWatchdog() {
        staticWatchdog?.invalidate()
        staticWatchdog = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { await self.staticServer.ensureServing() }
        }
    }

    /// 回前台：立刻补一次静态服务探活 + 唤醒 Java 看门狗。
    func appBecameActive() {
        LaunchLog.write("scene active; ensure static server + kick watchdog")
        JvmBridge.kickWatchdog()
        Task { await staticServer.ensureServing() }
    }

    // MARK: - helpers

    private static func hostClassPath() -> String {
        guard let res = Bundle.main.resourceURL else { return "" }
        var parts = [res.appendingPathComponent("jvm/host.jar").path]
        let libs = res.appendingPathComponent("jvm/libs", isDirectory: true)
        if let files = try? FileManager.default.contentsOfDirectory(at: libs,
                                                                    includingPropertiesForKeys: nil) {
            for f in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
            where f.pathExtension.lowercased() == "jar" {
                parts.append(f.path)
            }
        }
        return parts.joined(separator: ":")
    }

    private static func makeBootScript(base: String, site: String) -> String {
        var js: [String] = []
        // 壳身份：前端 compat/shell.ts 只认桥对象（不看 UA —— Safari 打开同一页面
        // 仍必须是 web 壳）。桥在 WKUserScript(.atDocumentStart) 注入，早于页面脚本。
        js.append("window.meowIos={platform:'ios',version:'\(Self.appVersion())',"
                  + "build:'\(Self.buildId())',"
                  + "apiBase:'\(Self.jsString(base))',"
                  + "runtime:'OpenJDK 9 Zero（静态链接 · -Xint）'}")
        /*
         * 转屏桥：播放页全屏要横屏。WKWebView 里没有 Screen Orientation API 的
         * lock（非全屏上下文一律拒绝），只能让原生转；前端 shellSetOrientation
         * 会同时试 meowTv / meowIos 两个桥。
         */
        js.append("window.meowIos.setOrientation=function(m){try{"
                  + "window.webkit.messageHandlers.meowIos.postMessage({op:'orientation',value:String(m||'')})"
                  + "}catch(e){}}")
        /*
         * 保持亮屏桥：iOS 息屏 = App 挂起 = 网关端口消失，远程调试直接断。
         * 界面上给一个开关（维护 → 调试），状态持久化在 UserDefaults。
         */
        js.append("window.meowIos.keepAwake=\(ScreenAwake.isOn ? "true" : "false")")
        js.append("window.meowIos.setKeepAwake=function(on){try{"
                  + "window.webkit.messageHandlers.meowIos.postMessage({op:'keepAwake',value:!!on})"
                  + "}catch(e){}}")
        if base.isEmpty {
            js.append("localStorage.removeItem('meow.api');localStorage.removeItem('meow.api.scope')")
        } else {
            let escaped = base
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            // 前端 resolveBase()：裸 meow.api 需要 scope 标记才可信（与桌面端同判据）。
            js.append("localStorage.setItem('meow.api','\(escaped)');" +
                      "localStorage.setItem('meow.api.scope','ios')")
        }
        if !site.isEmpty {
            let escapedSite = site
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            js.append("localStorage.setItem('meow.site','\(escapedSite)')")
        }
        return "try{" + js.joined(separator: ";") + "}catch(e){}"
    }

    /// 注入到页面里的字符串要转义单引号（值来自 Bundle，不来自用户输入，但统一处理）。
    private static func jsString(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\")
         .replacingOccurrences(of: "'", with: "\\'")
    }

    private static func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    /// 构建标识（CI 注入的 git SHA + 时间）：设置页显示它，用户装完能确认是哪个包。
    private static func buildId() -> String {
        Bundle.main.infoDictionary?["MeowBuild"] as? String ?? "dev"
    }

    /// 启动失败时把 JVM 日志与启动日志的尾部带出来（否则用户只看到「闪退」两个字）。
    private static func logTailHint() -> String {
        var parts: [String] = []
        if let jvm = JvmBridge.logTail(), !jvm.isEmpty { parts.append(jvm) }
        let launch = LaunchLog.tail(12)
        if !launch.isEmpty { parts.append(launch) }
        return parts.isEmpty ? "" : "\n\n" + parts.joined(separator: "\n----\n")
    }

    private static func argValue(_ key: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        for (i, a) in args.enumerated() {
            if a == key, i + 1 < args.count { return args[i + 1] }
            if a.hasPrefix(key + "=") { return String(a.dropFirst(key.count + 1)) }
        }
        return nil
    }

    private static func waitHealth(base: String, attempts: Int) async -> Bool {
        guard let url = URL(string: base + "/api/health") else { return false }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 2
        cfg.timeoutIntervalForResource = 2
        let session = URLSession(configuration: cfg)
        for _ in 0..<attempts {
            do {
                let (data, resp) = try await session.data(from: url)
                if let http = resp as? HTTPURLResponse, http.statusCode == 200, !data.isEmpty {
                    return true
                }
            } catch {
                // JVM 还没监听：继续等
            }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return false
    }
}
