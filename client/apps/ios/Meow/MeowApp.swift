import SwiftUI

@main
struct MeowApp: App {
    @StateObject private var boot = Bootstrap()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // 第一行埋点：如果日志里连这行都没有，说明死在 dyld/签名，不是我们的代码。
        LaunchLog.write("app init")
    }

    var body: some Scene {
        WindowGroup {
            RootView(boot: boot)
                .onAppear {
                    LaunchLog.write("ui appear")
                    boot.start()
                }
                // 回前台：iOS 挂起期间看门狗线程也冻结，系统可能已把监听 socket
                // 收走。立刻踢一次，别让用户先看到「后端连接中断」再等 5 秒。
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        LaunchLog.write("scene active; kick gateway watchdog")
                        JvmBridge.kickWatchdog()
                    }
                }
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
