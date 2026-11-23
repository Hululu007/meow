import SwiftUI

@main
struct MeowApp: App {
    @StateObject private var boot = Bootstrap()

    var body: some Scene {
        WindowGroup {
            RootView(boot: boot)
                .onAppear { boot.start() }
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
