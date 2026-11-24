import SwiftUI

@main
struct MeowApp: App {
    @StateObject private var boot = Bootstrap()

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
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
