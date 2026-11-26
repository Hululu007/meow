import Foundation

/// 进程内存快照：写 `gateway/mem.json`，宿主 `/api/health` 与 AI 诊断工具直接读。
///
/// <p>为什么由原生写：iOS 没有 `/proc`，Java 侧拿不到本进程 RSS；
/// 而「切后台回来进程没了」到底是内存压力（jetsam）还是别的原因，
/// 只有 RSS + 系统剩余配额能区分。30 秒一次，两次 syscall，开销可忽略。
///
/// <p>字段：
///   - `rssMB`：当前常驻内存
///   - `availMB`：系统还允许本进程申请的量（<200 视为危险区，会写一条 launch.log）
///   - `at`：unix 秒
enum MemoryProbe {
    private static var timer: Timer?

    static func start() {
        write()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            write()
        }
    }

    static func write() {
        let rssMB = Int((Double(meow_mem_rss()) / 1048576.0).rounded())
        let availRaw = meow_mem_available()
        let availMB = availRaw >= 0 ? Int((Double(availRaw) / 1048576.0).rounded()) : -1
        let obj: [String: Any] = [
            "rssMB": rssMB,
            "availMB": availMB,
            "at": Int(Date().timeIntervalSince1970),
        ]
        let fm = FileManager.default
        let docs = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let f = docs.appendingPathComponent("gateway/mem.json")
        try? fm.createDirectory(at: f.deletingLastPathComponent(),
                                withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: obj) {
            try? data.write(to: f, options: .atomic)
        }
        LaunchLog.write("[mem] rss=\(rssMB)MB avail=\(availMB)MB")
        if availMB >= 0 && availMB < 200 {
            LaunchLog.write("[mem] low available memory: \(availMB)MB")
        }
    }
}
