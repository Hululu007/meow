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
    @Published var message = "正在启动本地宿主…"
    @Published var webReady = false

    /// 不参与观察：webURL 变化时 RootView 已经会重建 WebView。
    var bootScript = ""

    private let staticServer = StaticServer()
    private var started = false

    nonisolated init() {}

    func start() {
        guard !started else { return }
        started = true
        Task { await boot() }
    }

    private func boot() async {
        LaunchLog.write("boot start")
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dataDir = docs.appendingPathComponent("gateway", isDirectory: true)
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        LaunchLog.write("data dir ready: \(dataDir.path)")

        // 首次启动：拷一份空配置（0 站）。用户从设置页导入源包后覆盖。
        let config = dataDir.appendingPathComponent("config.sites.json")
        if !fm.fileExists(atPath: config.path),
           let seed = Bundle.main.url(forResource: "config.sites.example", withExtension: "json") {
            try? fm.copyItem(at: seed, to: config)
        }

        guard let webRoot = Bundle.main.resourceURL?.appendingPathComponent("web"),
              fm.fileExists(atPath: webRoot.appendingPathComponent("index.html").path) else {
            message = "缺少 web 资源（先构建 client/apps/web）"
            LaunchLog.write("web resources missing")
            return
        }

        do {
            try await staticServer.start(root: webRoot, port: 9979)
            LaunchLog.write("static server on 9979")
        } catch {
            message = "静态服务启动失败：\(error.localizedDescription)"
            LaunchLog.write("static server failed: \(error.localizedDescription)")
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
            message = "正在启动 Java 宿主…"
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
                message = "等待 API 就绪…"
                if !(await Self.waitHealth(base: base, attempts: 120)) {
                    message = "Java 宿主已启动但 /api/health 未就绪" + Self.logTailHint()
                    LaunchLog.write("health wait failed")
                } else {
                    LaunchLog.write("health ok")
                }
            } else {
                message = "Java 宿主启动失败" + Self.logTailHint()
                LaunchLog.write("jvm start failed")
            }
        } else {
            message = "未内置 Java 运行时（本地网关不可用，界面仍可浏览）"
            LaunchLog.write("jvm resources missing; loading web without backend")
        }
        #endif

        let site = Self.argValue("--site") ?? ""
        bootScript = Self.makeBootScript(base: base, site: site)
        webURL = URL(string: "http://127.0.0.1:9979/")
        LaunchLog.write("web url set (base=\(base.isEmpty ? "none" : base))")
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
