import UserNotifications

/// 系统通知（导入源包这类后台长任务完成时提醒）。
///
/// <p>场景（2026-11-25 用户要求）：导入配置/dex 转换要几十秒，用户切走后
/// 完全不知道完成没。用 `UNUserNotificationCenter` 发一条本地通知。
///
/// <p>细节：
///  - App 在前台时也显示横幅（`willPresent` 里返回 .banner），否则"完成"提示
///    只能靠页面内文案；
///  - 授权只在首次真正要发通知时请求（不在启动时弹）；
///  - 侧载未签名包也能用，和推送证书无关。
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    func setup() {
        UNUserNotificationCenter.current().delegate = self
    }

    func notify(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, err in
            if let err = err {
                LaunchLog.write("notify auth failed: \(err.localizedDescription)")
                return
            }
            guard granted else {
                LaunchLog.write("notify denied by user")
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let req = UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(req) { error in
                if let error = error {
                    LaunchLog.write("notify add failed: \(error.localizedDescription)")
                } else {
                    LaunchLog.write("notify sent: \(title)")
                }
            }
        }
    }

    // 前台也显示横幅
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                    @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
