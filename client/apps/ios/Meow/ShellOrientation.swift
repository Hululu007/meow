import UIKit

/// 由页面请求转屏（播放页/直播页全屏用）。
///
/// <p>为什么必须走原生：WKWebView 里的 `screen.orientation.lock()` 只在
/// **真全屏**上下文有效，而 iPhone 的 WKWebView 拿不到元素全屏（只能伪全屏，
/// 页面 CSS 撑满），于是方向锁永远抛 NotAllowedError —— 表现就是「点了全屏还是竖着」。
/// 只能让壳去转。
///
/// <p>★ 2026-11-25 回前台补转：iOS 进后台会把 App 方向复位成竖屏，而前端在
/// `visibilitychange` 里调过来的那次，往往早于 scene 真正 active ——
/// `requestGeometryUpdate` 会被忽略（用户真机实测：回前台仍是竖屏，点「尝试横屏」
/// 才转）。这里在原生 `scenePhase == .active` 之后按**最后请求的方向**补一次，
/// 并用两次延迟 + 失败重试兜住时序。
enum ShellOrientation {
    /// 最近一次页面请求的方向。回前台按它补。
    private static var desired: String?
    /// 失败重试计数（防止 requestGeometryUpdate 持续报错时无限重试）
    private static var retryCount = 0

    static func apply(_ mode: String) {
        desired = mode
        retryCount = 0
        DispatchQueue.main.async { applyNow(mode) }
    }

    /// scene 回到 active 之后调用。
    ///
    /// 只补「landscape」：竖屏是系统复位后的默认值，强制 portrait 会把
    /// 用户自己横着拿的首页又掰回竖屏（其他页面不该受影响）。
    static func reapplyOnActivate() {
        guard desired == "landscape" else { return }
        retryCount = 0
        // 两拍：刚 active 时几何更新可能还不可用，1.2s 再兜一次（幂等）
        for delay in [0.35, 1.2] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                if desired == "landscape" { applyNow("landscape") }
            }
        }
    }

    private static func applyNow(_ mode: String) {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first else { return }
        guard scene.activationState == .foregroundActive else {
            LaunchLog.write("[ios] orientation \(mode) skipped: scene not active")
            return
        }
        let mask: UIInterfaceOrientationMask
        switch mode {
        case "landscape": mask = .landscape
        case "portrait": mask = .portrait
        default: mask = .allButUpsideDown
        }
        if #available(iOS 16.0, *) {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                LaunchLog.write("[ios] orientation \(mode) rejected: \(error.localizedDescription)")
                // 刚回前台最容易撞「not in foreground」—— 退一次重试
                if desired == mode && retryCount < 2 {
                    retryCount += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        if desired == mode { applyNow(mode) }
                    }
                }
            }
            scene.keyWindow?.rootViewController?
                .setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            UIDevice.current.setValue(
                mode == "landscape"
                    ? UIInterfaceOrientation.landscapeRight.rawValue
                    : UIInterfaceOrientation.portrait.rawValue,
                forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
        LaunchLog.write("[ios] orientation -> \(mode)")
    }
}
