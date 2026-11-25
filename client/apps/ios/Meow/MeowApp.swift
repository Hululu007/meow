import SwiftUI

@main
struct MeowApp: App {
    @StateObject private var boot = Bootstrap()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // 第一行埋点：如果日志里连这行都没有，说明死在 dyld/签名，不是我们的代码。
        LaunchLog.write("app init")
        // 后台播放（2026-11-25 用户要求「切后台还能播」）：
        // 默认 category 是 soloAmbient，切后台/锁屏会被系统停音。这里只设 category，
        // 会话激活交给 scenePhase == .background 且页面报告在播时才做
        //（见 AudioSession：在 play 路径上 setActive 会造成「播放 1s 自动暂停」）。
        AudioSession.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView(boot: boot)
                .onAppear {
                    LaunchLog.write("ui appear")
                    // 窗口此时一定存在：再挂一次 MPVolumeView（启动早期那次可能没窗口）
                    SystemVolume.attach()
                    boot.start()
                }
                /*
                 * 回前台做三件事：
                 *  1) 唤醒 Java 看门狗 + 探活/重建 9979 静态服务；
                 *  2) 播放页/直播页要求的横屏会被系统复位成竖屏 —— 由
                 *     ShellOrientation 按"最后请求的方向"补回来（原生侧补，
                 *     不依赖 visibilitychange 的时序；用户实测 JS 侧调用被忽略）；
                 *  3) audio session 被来电等打断后重设 category（不 setActive）。
                 */
                .onChange(of: scenePhase) { phase in
                    // 切前后台的全量状态流水：系统事件顺序不固定，排障只能靠它
                    LaunchLog.write("scenePhase -> \(String(describing: phase))")
                    if phase == .active {
                        boot.appBecameActive()
                        ShellOrientation.reapplyOnActivate()
                        // 给页面补一个"真正回到前台"的信号：播放器用它续播/恢复横屏，
                        // 不依赖 visibilitychange 的时序（2026-11-25 用户实测会漏）。
                        DispatchQueue.main.async {
                            WebViewRegistry.view?.evaluateJavaScript(
                                "window.__meowIosActive&&window.__meowIosActive()",
                                completionHandler: nil)
                        }
                    } else if phase == .background {
                        /*
                         * 进后台才激活音频会话：前台播放路径一律不碰（上一版在
                         * 每次 play 里 setActive 导致「播放 1s 自动暂停」）。
                         * 页面通过 meowIos.setPlaying 报告过"在播"才会真的激活。
                         */
                        AudioSession.appDidEnterBackground()
                    }
                }
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
