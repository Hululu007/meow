import MediaPlayer
import UIKit

/// 系统媒体音量（iOS）。
///
/// <p>WKWebView 里 `video.volume = x` 是**静默无效**的（iOS 不允许网页控制音量），
/// 所以播放页的右侧竖滑与底栏音量条此前都只能改一个假的元素音量：
/// 用户看到滑条动了，声音不变，还会留下一个「请用手机侧键」的浮层。
///
/// <p>这里借 `MPVolumeView` 的 slider 写系统音量。这是 iOS 上唯一不需要私有
/// 框架的做法（MPVolumeView 是公开 API；直接 setValue 依赖其内部 slider）。
/// App 只侧载、不上架，风险可控。
///
/// <p>`MPVolumeView` 必须先挂进窗口，subviews 里才会出现 `UISlider`，所以
/// `attach()` 放在启动时调一次，控件本身挪到屏幕外、透明度降到几乎不可见。
enum SystemVolume {
    private static let volumeView = MPVolumeView(
        frame: CGRect(x: -2000, y: -2000, width: 40, height: 40)
    )

    static func attach() {
        guard volumeView.superview == nil else { return }
        volumeView.alpha = 0.01
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })
            ?? scenes.first?.windows.first
        window?.addSubview(volumeView)
        // 让 MPVolumeView 立刻建出内部 slider（不等下一帧，启动时就要能读音量）
        volumeView.layoutIfNeeded()
    }

    private static var slider: UISlider? {
        attach()
        volumeView.layoutIfNeeded()
        return volumeView.subviews.compactMap { $0 as? UISlider }.first
    }

    /// 当前系统媒体音量 0–100；读不到返回 -1。
    static func current() -> Int {
        guard let s = slider else { return -1 }
        return Int((s.value * 100).rounded())
    }

    /// 设系统媒体音量 0–100。slider 不存在（极少见）时静默失败。
    static func set(_ pct: Int) {
        guard let s = slider else { return }
        s.value = Float(max(0, min(100, pct))) / 100
        // 两个事件都发：不同 iOS 版本上 MPVolumeView 只认其中一个
        s.sendActions(for: .valueChanged)
        s.sendActions(for: .touchUpInside)
    }
}
