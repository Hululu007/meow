import Foundation
import Network

/// 极简静态文件服务：把 App 内的 web/dist 通过 http://127.0.0.1:<port>/ 暴露给 WKWebView。
///
/// 为什么不用 file://：ES module / localStorage / fetch 在 file:// 下受限（TV 的
/// build.gradle 与本仓库文档都记过同款坑）。这里只做 GET/HEAD，一次连接一个请求，
/// 足够 Vite 产物使用；业务请求走 9978 的 Java 宿主。
final class StaticServer {
    private let queue = DispatchQueue(label: "com.meow.ios.static", qos: .userInitiated)
    private var listener: NWListener?
    private var root: URL?
    /** 记住端口：监听失效后要在同一端口重建（页面里的相对地址不会变）。 */
    private var port: UInt16 = 9979
    private var restarting = false

    func start(root: URL, port: UInt16) async throws {
        self.root = root.standardizedFileURL
        self.port = port

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "MeowStatic", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "端口非法"])
        }
        params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: nwPort)

        let listener = try NWListener(using: params)
        self.listener = listener

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if !resumed { resumed = true; continuation.resume() }
                case .failed(let error):
                    if !resumed { resumed = true; continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: self.queue)
        }
    }

    deinit { listener?.cancel() }

    /// 停掉监听（开屏页「重试」时用：同一端口必须先释放才能重建）。
    func stop() {
        listener?.cancel()
        listener = nil
    }

    /// 探一次入口页；不通就在原端口重建监听。
    ///
    /// <p>为什么必须有（2026-11-25 真机）：iOS 切后台/内存压力下 NWListener 可能
    /// 悄悄失效（不再 accept），而 Java 网关还活着 —— 于是 API 正常、懒加载路由的
    /// chunk 全部拉不到。用户看到的正是「顶栏搜索 / 详情剧集点了没反应」，
    /// 而当前页里的纯前端按钮（切播放源胶囊）照常工作。
    /// <p>路由 chunk 已经预热过的（见 main.ts warmLazyRoutes）不受影响；这里负责
    /// 把「下一次启动/还没加载的页面」救回来。
    func ensureServing() async {
        guard let root else { return }
        if await probe() { return }
        if restarting { return }
        restarting = true
        defer { restarting = false }
        LaunchLog.write("static server unhealthy; restarting on \(port)")
        stop()
        do {
            try await start(root: root, port: port)
            LaunchLog.write("static server restarted")
        } catch {
            LaunchLog.write("static server restart failed: \(error)")
        }
    }

    private func probe() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/index.html") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - connection

    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            if case .ready = state {
                self.read(connection, buffer: Data())
            }
        }
        connection.start(queue: queue)
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var accumulated = buffer
            if let data { accumulated.append(data) }

            if accumulated.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(connection, requestHead: accumulated)
                return
            }
            if accumulated.count > 256 * 1024 || complete || error != nil {
                connection.cancel()
                return
            }
            self.read(connection, buffer: accumulated)
        }
    }

    private func respond(_ connection: NWConnection, requestHead: Data) {
        let head = String(decoding: requestHead, as: UTF8.self)
        let firstLine = head.components(separatedBy: "\r\n").first ?? ""
        let fields = firstLine.split(separator: " ")
        guard fields.count >= 2 else {
            send(connection, status: 400, reason: "Bad Request", type: "text/plain; charset=utf-8",
                 body: Data("bad request".utf8), headOnly: false)
            return
        }
        let method = String(fields[0]).uppercased()
        let headOnly = method == "HEAD"
        guard method == "GET" || headOnly else {
            send(connection, status: 405, reason: "Method Not Allowed", type: "text/plain; charset=utf-8",
                 body: Data(), headOnly: true)
            return
        }

        var path = String(fields[1])
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        if let h = path.firstIndex(of: "#") { path = String(path[..<h]) }
        path = path.removingPercentEncoding ?? path
        if path.isEmpty || path == "/" { path = "/index.html" }
        if !path.hasPrefix("/") { path = "/" + path }

        guard let root = root else { connection.cancel(); return }
        let relative = String(path.dropFirst())
        let candidate = root.appendingPathComponent(relative).standardizedFileURL
        let rootPath = root.path.hasSuffix("/") ? String(root.path.dropLast()) : root.path

        guard candidate.path == rootPath || candidate.path.hasPrefix(rootPath + "/") else {
            send(connection, status: 403, reason: "Forbidden", type: "text/plain; charset=utf-8",
                 body: Data(), headOnly: true)
            return
        }

        var isDirectory: ObjCBool = false
        var file = candidate
        if !FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) || isDirectory.boolValue {
            // 无扩展名的路径回退到 SPA 入口；带扩展名的缺失资源直接 404。
            if (path as NSString).pathExtension.isEmpty {
                file = root.appendingPathComponent("index.html")
            } else {
                send(connection, status: 404, reason: "Not Found", type: "text/plain; charset=utf-8",
                     body: Data("not found".utf8), headOnly: headOnly)
                return
            }
        }

        guard let body = FileManager.default.contents(atPath: file.path) else {
            send(connection, status: 404, reason: "Not Found", type: "text/plain; charset=utf-8",
                 body: Data("not found".utf8), headOnly: headOnly)
            return
        }

        send(connection, status: 200, reason: "OK",
             type: mimeType(file.pathExtension), body: body, headOnly: headOnly)
    }

    private func send(_ connection: NWConnection, status: Int, reason: String,
                      type: String, body: Data, headOnly: Bool) {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: \(type)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        if !headOnly { out.append(body) }
        connection.send(content: out, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "mp4": return "video/mp4"
        case "m3u8": return "application/vnd.apple.mpegurl"
        case "ts": return "video/mp2t"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
