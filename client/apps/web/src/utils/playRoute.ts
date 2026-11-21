/**
 * 播放路由决策（纯函数，无 Vue/浏览器依赖）—— 分配层唯一的判定入口。
 *
 * 背景（2026-11-21 片库无声实报）：音频编码是三端唯一的分歧点 ——
 * 所有 WebView（PC/TV/手机）都不带 AC3/E-AC3/DTS 解码器（Dolby 授权），
 * 视频 H264 全端可解、H265 看内核。分配规则：
 *
 *   · 全可解（AAC 系 + H264/H265）           → 直连（零成本、全体验）
 *   · 超纲 + TV 有原生桥 + 用户开了自动       → 原生播放器（设备解码，秒开）
 *   · 超纲 + TV 有原生桥（默认）             → 提示「用原生播放」（不自动打断，
 *                                              沿用 2026-11-19 错误页不自动切原生的裁决）
 *   · 超纲 + 无原生桥（PC/网页）             → 后端转码
 *   · 超纲 + 连转码能力都没有                → 提示原生（赌设备能解）
 *
 * 纯函数 + 全矩阵单测（tests/playback-route.test.ts）：新端/新内核只加用例，
 * 不改逻辑 —— 这是分配层不引入回归的机械保证。
 */

export interface MediaProbe {
  acodec?: string
  vcodec?: string
}

export interface PlaybackRouteInput {
  /** 后端探测的编码元数据；null/缺 = 未探测（走运行时兜底，不在此预判） */
  probe?: MediaProbe | null
  /** 当前内核能解码的音频编码（小写，如 aac/mp3/opus/flac） */
  audioCodecs: string[]
  /** 当前内核能解码的视频编码（如 h264/hevc） */
  videoCodecs: string[]
  /** TV 壳且有原生播放桥 */
  hasNative: boolean
  /** 用户开了「无声时自动用原生播放」 */
  preferNativeOnSilent: boolean
  /** 后端转码能力；null = 未探测（按可用算） */
  transcodeAvailable?: boolean | null
}

export type PlaybackRoute = 'direct' | 'native' | 'native-hint' | 'transcode'

/**
 * 当前内核能直解的音频编码集合。基线（Chromium 全家）：AAC/MP3/Opus/
 * Vorbis/FLAC；**Safari（macOS/iOS）带 Dolby 授权**，AC3/E-AC3 可直解 ——
 * 不把 ac3 放进 Safari 的能力表，就会把"其实能直连"的文件误送去转码
 * （2026-11-21 清单③）。
 */
export function webviewAudioCodecs(isAppleWebkit = false): string[] {
  const base = ['aac', 'mp3', 'opus', 'vorbis', 'flac']
  // Safari/iOS 带 Dolby 授权（AC3/E-AC3 可直解）；UA 判定在 compat/ua.isAppleWebkit
  return isAppleWebkit ? [...base, 'ac3', 'eac3'] : base
}

export function resolvePlaybackRoute(i: PlaybackRouteInput): PlaybackRoute {
  const p = i.probe
  if (!p) return 'direct'
  const audio = (p.acodec || '').toLowerCase()
  const video = (p.vcodec || '').toLowerCase()
  // 探测失败的维度按"可解"算：缺信息不该把用户赶去转码
  const audioOk = audio === '' || i.audioCodecs.includes(audio)
  const videoOk = video === '' || i.videoCodecs.includes(video)
  if (audioOk && videoOk) return 'direct'

  const canTranscode = i.transcodeAvailable !== false
  if (i.hasNative && i.preferNativeOnSilent) return 'native'
  if (i.hasNative) return 'native-hint'
  return canTranscode ? 'transcode' : 'native-hint'
}
