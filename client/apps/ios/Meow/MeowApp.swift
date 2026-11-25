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
        // 真正开播时由前端调 meowIos.setAudioSession(true) 再 setActive
        //（启动就 setActive 会抢走音频焦点，用户开着音乐进 App 就被打断）。
        AudioSession.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView(boot: boot)
                .onAppear {
                    LaunchLog.write("ui appear")
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
                    if phase == .active {
                        AudioSession.configure()
                        boot.appBecameActive()
                        ShellOrientation.reapplyOnActivate()
                    }
                }
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
