import UIKit

/// 由页面请求转屏（播放页全屏用）。
///
/// <p>为什么必须走原生：WKWebView 里的 `screen.orientation.lock()` 只在
/// **真全屏**上下文有效，而 iPhone 的 WKWebView 拿不到元素全屏（只能伪全屏，
/// 页面 CSS 撑满），于是方向锁永远抛 NotAllowedError —— 表现就是「点了全屏还是竖着」。
/// 只能让壳去转。
enum ShellOrientation {
    static func apply(_ mode: String) {
        DispatchQueue.main.async {
            guard let scene = UIApplication.shared.connectedScenes
                .compactMap({ $0 as? UIWindowScene }).first else { return }
            let mask: UIInterfaceOrientationMask
            switch mode {
            case "landscape": mask = .landscape
            case "portrait": mask = .portrait
            default: mask = .allButUpsideDown
            }
            if #available(iOS 16.0, *) {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                    LaunchLog.write("[ios] orientation \(mode) rejected: \(error.localizedDescription)")
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
}
