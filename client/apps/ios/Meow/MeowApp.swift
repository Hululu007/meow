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
                // 回前台：iOS 挂起期间看门狗线程与静态服务都可能失效。
                // 立刻踢一次：唤醒 Java 看门狗 + 探活/重建 9979 静态服务。
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        boot.appBecameActive()
                    }
                }
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
