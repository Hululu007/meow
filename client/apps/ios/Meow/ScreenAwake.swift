import UIKit

/// 远程调试时保持亮屏（2026-11-24 用户要求）。
///
/// <p><b>为什么必须这么做</b>：iOS 息屏 = App 被系统挂起 = 端内网关（9978）的监听
/// 套接字全部消失，远程调试立刻断。iOS 没有「后台常驻监听」的合法通道
/// （`beginBackgroundTask` 只有 ~30 秒，静音音频后台模式会被系统回收且极耗电），
/// 所以唯一可靠的办法就是**别让屏幕自动锁**。
///
/// <p>用 `isIdleTimerDisabled`（系统级「不要自动锁屏」）：不改亮度、不写系统设置，
/// App 退到后台时系统自己恢复默认行为。设置持久化在 UserDefaults，装一次即可。
enum ScreenAwake {
    /// UserDefaults 键：`true` = 保持亮屏。
    private static let key = "meow.keepAwake"

    /// 当前选择。第一次运行（没有存过）默认**开** —— 这个开关就是为远程调试准备的，
    /// 用户随时可以在「维护 → 调试」里关掉。
    static var isOn: Bool {
        let d = UserDefaults.standard
        if d.object(forKey: key) == nil { return true }
        return d.bool(forKey: key)
    }

    /// 写入并立即生效。必须在主线程碰 `UIApplication.shared`。
    static func apply(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: key)
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            LaunchLog.write("[screen] idle timer \(on ? "disabled (keep awake)" : "enabled")")
        }
    }

    /// 启动时套用上次选择。
    static func restore() {
        let on = isOn
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            LaunchLog.write("[screen] restore keepAwake=\(on)")
        }
    }
}
