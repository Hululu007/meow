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
  /**
   * 源像素格式（yuv420p / yuv420p10le / p010le…）。
   *
   * 10-bit H.264（Hi10P）是浏览器与盒子硬解的共同盲区：Chromium 只带
   * 8-bit 解码器，rkmpp/电视硬解也只吃 8-bit。命中时**直连和原生都不成立**，
   * 只有转码一条路（2026-11-23 片库实报：10-bit 集数直连"解码失败"，
   * copyVideo 转出来的 HLS 也照样黑屏 —— 判定必须早于 copy 决策）。
   */
  pixfmt?: string
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

/**
 * pix_fmt 是否高位深（10/12/16-bit）。只认 `…p10le / p010le / p016le` 这类
 * 8-bit 以外的格式；`nv12`（8-bit 4:2:0）里虽然含 "12" 但不是高位深，别误判。
 */
function isHighBitDepth(pixFmt: string): boolean {
  return /p0?(?:10|12|16)(?:le|be)?$/.test(pixFmt)
}

export function resolvePlaybackRoute(i: PlaybackRouteInput): PlaybackRoute {
  const p = i.probe
  if (!p) return 'direct'
  const audio = (p.acodec || '').toLowerCase()
  const video = (p.vcodec || '').toLowerCase()
  const highBit = isHighBitDepth((p.pixfmt || '').toLowerCase())
  // 探测失败的维度按"可解"算：缺信息不该把用户赶去转码
  const audioOk = audio === '' || i.audioCodecs.includes(audio)
  const videoOk = video === '' || i.videoCodecs.includes(video)
  if (audioOk && videoOk && !highBit) return 'direct'

  const canTranscode = i.transcodeAvailable !== false
  // 10-bit H.264（Hi10P）：直连和原生桥都救不了（浏览器只带 8-bit 解码器，
  // 电视硬解同样只吃 8-bit）→ 转码是唯一出路；连转码都没有才提示原生
  if (highBit) return canTranscode ? 'transcode' : 'native-hint'
  if (i.hasNative && i.preferNativeOnSilent) return 'native'
  if (i.hasNative) return 'native-hint'
  return canTranscode ? 'transcode' : 'native-hint'
}
