/**
 * 播放路由决策（纯函数，无 Vue/浏览器依赖）—— 分配层唯一的判定入口。
 *
 * 背景（2026-11-21 片库无声实报 + 2026-11-24 降画质实报）：分配层要回答的
 * 不是"这是什么编码"，而是"**这台设备能不能解**"。原来拿"10-bit"一刀切，
 * 把 HEVC Main10（4K HDR 的标准编码）也判成只能转码 —— 明明 PC/电视能直解的
 * 片被砍成 1080p 8-bit，用户看到的就是"都被降画质了，好像被转码了"。
 *
 * 现在的链路（能力优先，逐级降级，每一级只在上一级真的做不到时才走）：
 *
 *   直连 direct  →  原生播放 native  →  转封装 remux（视频 copy，只换音频）
 *                →  转码 transcode    →  提示原生 native-hint
 *
 * 三类能力分开算：
 *   · WebView 能解什么 → `MediaSource.isTypeSupported()` 实测（utils/codecCaps.ts）
 *   · 原生播放器能解什么 → TV 桥 `nativeCaps()`（有则用，没有就走旧行为）
 *   · 转码能做什么 → 后端 `/api/transcode`（available/hw/sw）
 *
 * 纯函数 + 全矩阵单测（tests/playback-route.test.ts）：新端/新内核只加用例，
 * 不改逻辑 —— 这是分配层不引入回归的机械保证。
 */

import type { WebCodecCaps } from './codecCaps'

export interface MediaProbe {
  acodec?: string
  vcodec?: string
  /**
   * 源像素格式（yuv420p / yuv420p10le / p010le…）。
   *
   * 只有 **H.264 的 10-bit（Hi10P）** 才是 WebView 与盒子硬解的共同盲区：
   * Chromium 只带 8-bit 解码器，rkmpp/电视硬解也只吃 8-bit。命中时直连和原生
   * 都不成立，只有转码一条路（2026-11-23 片库实报：10-bit 集数直连"解码失败"，
   * copyVideo 转出来的 HLS 也照样黑屏 —— 判定必须早于 copy 决策）。
   *
   * HEVC Main10 / AV1 10-bit **不在此列**：电视原生与 PC 的 WebView2 常能解
   * （实测本机 WebView2：`hvc1.2.4.L153.B0` → true），一刀切就是人为降画质。
   */
  pixfmt?: string
  /** 后端补：位深（8/10/12）。缺省按 pixfmt 推断。 */
  bitDepth?: number
  /** 后端补：色彩传输（smpte2084=PQ / arib-std-b67=HLG 判 HDR）。 */
  colorTransfer?: string
  /** 后端补：声道数（2 / 6 …）。 */
  channels?: number
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
  /**
   * 端侧实测能力（utils/codecCaps.ts）。
   *
   * 缺省或 probed=false → **按旧表走**（不改既有行为）。
   * 有了它才能判断"这台设备到底能不能解高位深"。
   */
  caps?: WebCodecCaps | null
  /**
   * 允许 remux（视频 copy + 音频转 AAC）。
   *
   * 默认 false：在线源（HLS）再 copy 成 HLS 时间戳风险大、4K copy 带宽也高，
   * 只有**片库（本地/SMB）+ 局域网**这种已知可控的场景才打开。
   */
  allowRemux?: boolean
}

export type PlaybackRoute =
  | 'direct'
  | 'native'
  | 'native-hint'
  | 'remux'
  | 'transcode'

/**
 * 当前内核能直解的音频编码集合。基线（Chromium 全家）：AAC/MP3/Opus/
 * Vorbis/FLAC；**Safari（macOS/iOS）带 Dolby 授权**，AC3/E-AC3 可直解 ——
 * 不把 ac3 放进 Safari 的能力表，会把"其实能直连"的文件误送去转码
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
export function isHighBitDepth(pixFmt: string): boolean {
  return /p0?(?:10|12|16)(?:le|be)?$/.test(pixFmt)
}

/** probe 里能看出的位深（后端 bitDepth 优先，否则按 pixfmt 推）。 */
export function probeBitDepth(p: MediaProbe): number {
  if (typeof p.bitDepth === 'number' && p.bitDepth > 0) return p.bitDepth
  const pf = (p.pixfmt || '').toLowerCase()
  if (!pf) return 0
  if (isHighBitDepth(pf)) return /p12/.test(pf) ? 12 : /p16/.test(pf) ? 16 : 10
  return 8
}

/**
 * 是不是"H.264 10-bit（Hi10P）"——唯一需要无条件转码的高位深形态。
 *
 * 判定要**同时**看编码与位深：只按 pixfmt 判会把 HEVC Main10 也拖下水。
 */
export function isHi10p(p: MediaProbe): boolean {
  const vcodec = (p.vcodec || '').toLowerCase()
  if (vcodec !== 'h264') return false
  return probeBitDepth(p) >= 10
}

/**
 * 这台 WebView 能不能直解这个视频（含位深）。
 *
 * - 8-bit：看 videoCodecs（含实测表）。
 * - 高位深 HEVC/AV1：看实测能力（caps.highBitVideo）。
 *   **没有实测能力时按"能"处理** —— 直连失败有运行时兜底（解码报错 → 转码），
 *   而一刀切转码是必然的画质损失，两害相权取轻。
 * - H.264 Hi10P：恒为不能。
 */
export function webCanDecodeVideo(p: MediaProbe, i: PlaybackRouteInput): boolean {
  const vcodec = (p.vcodec || '').toLowerCase()
  if (!vcodec) return true
  if (isHi10p(p)) return false
  if (probeBitDepth(p) < 10) return i.videoCodecs.includes(vcodec)
  const caps = i.caps
  if (caps && caps.probed) return caps.highBitVideo.includes(vcodec)
  return true
}

export function resolvePlaybackRoute(i: PlaybackRouteInput): PlaybackRoute {
  const p = i.probe
  if (!p) return 'direct'
  const audio = (p.acodec || '').toLowerCase()
  // 探测失败的维度按"可解"算：缺信息不该把用户赶去转码
  const audioOk = audio === '' || i.audioCodecs.includes(audio)
  const videoOk = webCanDecodeVideo(p, i)
  if (audioOk && videoOk) return 'direct'

  const canTranscode = i.transcodeAvailable !== false
  /*
   * H.264 Hi10P：WebView 与电视硬解的共同盲区，**原生也救不了**，
   * 所以排在原生分支之前 —— 转码是唯一出路（旧行为，保持不变）。
   */
  if (isHi10p(p)) return canTranscode ? 'transcode' : 'native-hint'
  /*
   * 只有音频解不了、视频能解 → **remux**：让后端把视频原样 copy 过去
   * （零画质损失），只把音频转成 AAC。
   * 这是"片库被降画质"最常见的一档：4K HEVC + AC3/DTS 音轨，
   * 旧逻辑整条重编码 → 4K 砍成 1080p；remux 之后画面是原画。
   *
   * 默认不开（allowRemux=false）：只给片库+局域网这类已知可控场景开。
   */
  if (i.allowRemux && videoOk && !audioOk && canTranscode && !i.hasNative) return 'remux'
  /*
   * 有原生桥（电视）：原生播放器是设备硬解，拿到的是原画。
   * 保持旧语义：默认给提示（用户点一次），开了「无声自动用原生」才自动切。
   */
  if (i.hasNative) {
    if (i.preferNativeOnSilent) return 'native'
    return 'native-hint'
  }
  if (canTranscode) return 'transcode'
  return 'native-hint'
}
