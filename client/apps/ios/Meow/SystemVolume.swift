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
///
/// <p>★ 2026-11-25 真机：启动时窗口还没建好，attach 拿不到 window，slider 永远
/// 为空、音量怎么滑都不变（且没有任何报错）。现在失败会延时重试并写日志。
///
/// <p>系统音量 HUD 不会出现：iOS 13+ 程序化改音量本来就不弹 HUD（只有侧键弹）。
/// 播放页自己的百分比浮层就是反馈，不伪造系统 HUD。
enum SystemVolume {
    private static let volumeView = MPVolumeView(
        frame: CGRect(x: -2000, y: -2000, width: 40, height: 40)
    )
    private static var retryCount = 0
    /// 应用主动设置音量的时刻：KVO 回调据此去重（不要自己弹两次浮层）
    static var lastProgrammaticAt: TimeInterval = 0

    static func attach() {
        // 侧键/控制中心改音量也要有反馈（见 VolumeObserver）
        VolumeObserver.shared.start()
        guard volumeView.superview == nil else { return }
        volumeView.alpha = 0.01
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first(where: { $0.isKeyWindow })
            ?? scenes.first?.windows.first
        guard let window else {
            // 启动早期窗口还没出来：延时重试（覆盖冷启动），失败次数有上限
            if retryCount < 8 {
                retryCount += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { attach() }
            }
            return
        }
        window.addSubview(volumeView)
        // 让 MPVolumeView 立刻建出内部 slider（不等下一帧，启动时就要能读音量）
        volumeView.layoutIfNeeded()
        LaunchLog.write("system volume attached (slider=\(slider == nil ? "no" : "yes"))")
    }

    private static var slider: UISlider? {
        attach()
        volumeView.layoutIfNeeded()
        return volumeView.subviews.compactMap { $0 as? UISlider }.first
    }

    /// 当前系统媒体音量 0–100；读不到返回 -1。
    ///
    /// <p>★ 读音量**不能**走 slider getter：那个会触发 attach，把 MPVolumeView
    /// 挂进窗口（启动时读一次快照就全局抑制系统音量 HUD，2026-11-26 用户报
    /// 「任意页面按音量键都没有系统音量条」）。会话的 outputVolume 不依赖视图。
    static func current() -> Int {
        let v = AVAudioSession.sharedInstance().outputVolume
        if v > 0 { return Int((v * 100).rounded()) }
        // 会话未激活时读数是 0：只有已经挂载才读 slider（绝不在这里 attach）
        if volumeView.superview != nil,
           let s = volumeView.subviews.compactMap({ $0 as? UISlider }).first {
            return Int((s.value * 100).rounded())
        }
        return 0
    }

    /// 离开播放页：把 MPVolumeView 摘掉，恢复系统音量 HUD 与系统悬浮层。
    ///
    /// <p>MPVolumeView 只要在窗口层级里，iOS 就会把系统音量 HUD 全局压掉
    /// （业界已知行为）。播放页自己的百分比浮层够用；其它页面应该让系统接管。
    static func detach() {
        guard volumeView.superview != nil else { return }
        volumeView.removeFromSuperview()
        LaunchLog.write("system volume detached (hud restored)")
    }

    /// 设系统媒体音量 0–100。slider 不存在（极少见）时静默失败。
    static func set(_ pct: Int) {
        guard let s = slider else {
            LaunchLog.write("system volume: slider missing (write \(pct))")
            return
        }
        lastProgrammaticAt = Date().timeIntervalSince1970
        s.value = Float(max(0, min(100, pct))) / 100
        // 两个事件都发：不同 iOS 版本上 MPVolumeView 只认其中一个
        s.sendActions(for: .valueChanged)
        s.sendActions(for: .touchUpInside)
    }
}

/// 系统音量变化观察者（侧键 / 控制中心 / 应用内设置都会触发）。
///
/// <p>窗口里挂了 MPVolumeView 之后，iOS 就不再弹系统音量 HUD（业界已知行为），
/// 用户按侧键会"音量变了但没有任何提示"。这里 KVO AVAudioSession.outputVolume，
/// 把变化回传给页面，由播放页弹自己的音量浮层。
private final class VolumeObserver: NSObject {
    static let shared = VolumeObserver()
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        AVAudioSession.sharedInstance().addObserver(
            self, forKeyPath: "outputVolume", options: [.new], context: nil
        )
    }

    override func observeValue(forKeyPath keyPath: String?,
                               of object: Any?,
                               change: [NSKeyValueChangeKey: Any]?,
                               context: UnsafeMutableRawPointer?) {
        guard keyPath == "outputVolume" else { return }
        // 应用自己 set() 触发的（手势/底栏滑条）：页面已有浮层，不重复回调
        if Date().timeIntervalSince1970 - SystemVolume.lastProgrammaticAt < 0.8 { return }
        let pct = Int((AVAudioSession.sharedInstance().outputVolume * 100).rounded())
        LaunchLog.write("system volume changed -> \(pct)")
        DispatchQueue.main.async {
            WebViewRegistry.view?.evaluateJavaScript(
                "window.__meowVolumeChanged&&window.__meowVolumeChanged(\(pct))",
                completionHandler: nil)
        }
    }
}
