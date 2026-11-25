import UIKit

/// 系统屏幕亮度（iOS）。
///
/// <p>WKWebView 里 `filter: brightness()` 只能把画面压暗，调不亮。播放页竖滑
/// 要的是"调屏幕"，和 B 站/爱奇艺一致，所以这里直接写 `UIScreen.main.brightness`
/// （公开 API，0...1）。
///
/// <p>第一次改之前记下原值，播放页销毁时页面调 `set(-1)` 还原 ——
/// 否则用户看完退出，整个手机屏幕还是被调过的亮度，很突兀。
enum SystemBrightness {
    private static var saved: CGFloat?

    /// 当前亮度 0–100
    static func current() -> Int {
        Int((UIScreen.main.brightness * 100).rounded())
    }

    /// 设亮度 0–100；传负数表示还原到进入播放页前的值
    static func set(_ pct: Int) {
        if pct < 0 {
            if let s = saved {
                UIScreen.main.brightness = s
                saved = nil
                LaunchLog.write("brightness restored")
            }
            return
        }
        if saved == nil { saved = UIScreen.main.brightness }
        UIScreen.main.brightness = CGFloat(max(0, min(100, pct))) / 100
    }
}
