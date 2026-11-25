import AVFoundation

/// 后台播放用的 audio session。
///
/// <p>为什么需要它：Info.plist 虽然声明了 `UIBackgroundModes=audio`，
/// 但 iOS 的默认 category 是 `soloAmbient` —— 切后台/锁屏时系统会直接停音。
/// 只有 `.playback` + **处于激活状态** 的 session 才允许「App 在后台继续出声」。
///
/// <p>★ 只在**开播时**激活（前端通过 `meowIos.setAudioSession(true)` 调用），
/// 不在启动/回前台时激活：一启动就 setActive 会抢走音频焦点，用户开着音乐
/// 打开 App 就被打断。暂停不主动 deactivate（避免暂停/继续时反复抢焦点），
/// 离开播放页时前端会调一次 false。
enum AudioSession {
    /// 设 category；失败只记日志，不影响正常播放。
    static func configure() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [])
            LaunchLog.write("audio session: playback")
        } catch {
            LaunchLog.write("audio session category failed: \(error.localizedDescription)")
        }
    }

    /// 开播：设 category + setActive(true)，让 WKWebView 的媒体能在后台继续出声。
    static func activate() {
        configure()
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            LaunchLog.write("audio session active")
        } catch {
            LaunchLog.write("audio session activate failed: \(error.localizedDescription)")
        }
    }

    /// 离开播放页：把 session 还回去，别的 App 的音乐可以恢复。
    static func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            LaunchLog.write("audio session inactive")
        } catch {
            LaunchLog.write("audio session deactivate failed: \(error.localizedDescription)")
        }
    }
}
