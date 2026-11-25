import SwiftUI
import AVFoundation

@main
struct MeowApp: App {
    @StateObject private var boot = Bootstrap()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // 第一行埋点：如果日志里连这行都没有，说明死在 dyld/签名，不是我们的代码。
        LaunchLog.write("app init")
        // 后台播放（2026-11-25 用户要求「切后台还能播」）：
        // Info.plist 已有 UIBackgroundModes=audio，但默认 audio session 是
        // soloAmbient —— 切后台/锁屏时系统会直接停音。改成 playback 才能续播
        // （代价：静音拨片不再拦截媒体声，视频 App 的常规做法）。
        //
        // ★ 只设 category、不在启动时 setActive：后者会抢走音频焦点，
        //   用户开着音乐进 App 就被打断。真正开播时 WebKit 会自己激活会话。
        Self.configureAudioSession()
    }

    /// 把 audio session 设成后台可播放；失败只记日志，不影响正常播放。
    static func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [])
            LaunchLog.write("audio session: playback")
        } catch {
            LaunchLog.write("audio session failed: \(error.localizedDescription)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(boot: boot)
                .onAppear {
                    LaunchLog.write("ui appear")
                    boot.start()
                }
                // 回前台：iOS 挂起期间看门狗线程与静态服务都可能失效。
                // 立刻踢一次：唤醒 Java 看门狗 + 探活/重建 9979 静态服务；
                // audio session 在中断（来电/闹钟）后也可能失效，一并重激活。
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        Self.configureAudioSession()
                        boot.appBecameActive()
                    }
                }
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
        }
    }
}
