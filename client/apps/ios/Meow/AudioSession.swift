import AVFoundation

/// 后台播放用的 audio session（**启动只设 category，进后台才激活**）。
///
/// <p>Info.plist 声明 `UIBackgroundModes=audio` 只是"允许"；默认 category 是
/// `soloAmbient`，切后台/锁屏会被系统停音。启动时设成 `.playback` 即可。
///
/// <p>★ 2026-11-25 真机回归教训（第一版）：在每次 `play` 里调 `setActive(true)`、
/// 每次回前台又 `setCategory` —— iOS 上出现「播放 ~1s 后自动暂停」高频复现。
/// 不要在播放入口处碰会话；WebKit 自己会在前台激活它。
///
/// <p>★ 2026-11-25 真机回归教训（第二版）：只设 category 不激活 —— 切后台媒体
/// 被系统暂停、要走系统播放条才继续。声明 background mode 不等于会话是 active，
/// 后台出声要求会话已激活。所以改成：**只在小程序报告"正在播"且进后台时激活一次**。
/// 这样前台播放完全不受影响（不在 play 路径上），后台也能出声。
///
/// <p>不在暂停/前台时 `setActive(false)`：解激活同样会打断 WebKit 的音频管线，
/// 且我们的页面可能刚被系统暂停、JS 状态还没回来。宁可让会话保持 active
/// （非混音 category 会压住别的 App 的音乐，所以只在"本来就在播"时才激活）。
enum AudioSession {
    /// 页面报告"现在在播"（play 事件置位；前台 pause 清掉；后台系统暂停不清）
    private static var wantPlayback = false
    private static var configured = false

    /// 设 category；失败只记日志，不影响正常播放。
    static func configure() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [])
            configured = true
            LaunchLog.write("audio session: playback")
        } catch {
            LaunchLog.write("audio session category failed: \(error.localizedDescription)")
        }
    }

    /// 页面播放状态。只记状态，不碰会话 —— 激活时机在 `appDidEnterBackground`。
    static func setPlaying(_ on: Bool) {
        wantPlayback = on
    }

    /// 进后台：只有"页面说在播"才激活。没在播就不激活，
    /// 否则会把用户正在听的其他 App 音乐压掉（.playback 是非混音 category）。
    static func appDidEnterBackground() {
        guard configured, wantPlayback else { return }
        let session = AVAudioSession.sharedInstance()
        // 没有公开的 isActive：setActive(true) 对已激活会话是幂等的，直接调
        do {
            try session.setActive(true)
            LaunchLog.write("audio session: active for background playback")
        } catch {
            LaunchLog.write("audio session background activate failed: \(error.localizedDescription)")
        }
    }
}
