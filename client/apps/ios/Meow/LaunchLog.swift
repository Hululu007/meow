import Foundation

/// 启动日志（`Documents/launch.log`）。
///
/// 为什么单独存在：`jvm.log` 只有在 JVM 线程里才会被创建，而「装完就闪退」
/// 往往死在更早（dyld/签名/静态初始化）。这里把 App 从 `init` 开始的关键步骤
/// 逐条落盘，**同步写**（写完才返回，保证崩溃前那几行已经在磁盘上），
/// 配合 `UIFileSharingEnabled` 可以直接从「文件」App 里取走。
///
/// 只写步骤名与错误文本，不写配置内容、不写令牌。
enum LaunchLog {
    private static let fileName = "launch.log"

    static var url: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent(fileName)
    }

    static func write(_ line: String) {
        let ts = ISO8601DateFormatter().string(from: Date())
        let text = "[\(ts)] \(line)\n"
        guard let data = text.data(using: .utf8) else { return }
        let path = url.path
        // 同步 append：闪退随时可能发生，异步队列里没落盘就等于没写。
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile()
            fh.write(data)
            try? fh.synchronize()
            fh.closeFile()
        } else {
            try? data.write(to: url, options: .atomic)
        }
        NSLog("[meow-launch] %@", line)
    }

    /// 最后几行（启动失败时显示在界面上）。
    static func tail(_ keep: Int = 20) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        return lines.suffix(keep).joined(separator: "\n")
    }
}
