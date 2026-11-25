import AVFoundation

/// 后台播放用的 audio session（**只设 category，不手动 activate**）。
///
/// <p>Info.plist 声明 `UIBackgroundModes=audio` 只是"允许"；默认 category 是
/// `soloAmbient`，切后台/锁屏会被系统停音。启动时设成 `.playback` 即可，
/// **由 WebKit 在媒体起播时自己激活**。
///
/// <p>★ 2026-11-25 真机回归教训：前一版在每次 `play` 里调 `setActive(true)`、
/// 每次回前台又 `setCategory`，iOS 上出现「播放 ~1s 后自动暂停」高频复现
/// —— 手动激活/切换 category 会打断 WebKit 自己的音频会话状态。
/// 现在只保留启动时的 category；不要为了后台播放再手动 setActive。
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
}
