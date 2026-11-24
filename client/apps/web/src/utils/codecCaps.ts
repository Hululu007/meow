/**
 * 端侧解码能力实测（2026-11-24）
 *
 * 为什么不能再用硬编码表：原来 videoCodecs 写死 ['h264','hevc']，于是
 * 「10-bit 一律转码」把 HEVC Main10（4K HDR 的标准编码）也判成只能转码，
 * 明明 PC/电视能直解的片被砍成 1080p 8-bit —— 用户看到的「都被降画质」。
 *
 * 实测（本机 WebView2 157 / Edge）：
 *   video/mp4; codecs="hvc1.2.4.L153.B0"  → true（HEVC Main10 能解）
 *   video/mp4; codecs="av01.0.08M.10.0.110.09.16.09.0" → true（AV1 10-bit 能解）
 *   audio/mp4; codecs="ac-3" / "ec-3" / "dtsc" → false（AC3/EAC3/DTS 不能解）
 *
 * 探测不到（老内核 / SSR / 单测 / Safari）时返回 probed=false，调用方按旧表走，
 * **行为与改动前完全一致**（不回归保证）。
 */

import { isAppleWebkit } from '@/compat/ua'

/** 一次探测的结论。 */
export interface WebCodecCaps {
  /** 探测是否真的做了（false = 用兜底表） */
  probed: boolean
  /** 能直解的视频编码（小写）：h264 / hevc / av1 */
  video: string[]
  /** 能直解的**高位深**视频编码（小写）：hevc / av1（h264 不在内，见下） */
  highBitVideo: string[]
  /** 能直解的音频编码（小写） */
  audio: string[]
}

/**
 * 高位深探测用的 MIME。
 *
 * `hvc1.2.4.L153.B0` = HEVC Main10（profile 2, level 5.1）；
 * `hev1` 是带参数集的变体，部分内核只认一个，两个都试。
 * 另补 L5.2（4K60 常见）——只探 L5.1 会把 4K60 的片误判成不能解。
 *
 * ★ h264 不做高位深探测：10-bit H.264（Hi10P）是 WebView 与电视硬解的
 * **共同盲区**（Chromium 只带 8-bit 解码器，rkmpp/电视硬解也只吃 8-bit），
 * 命中一律转码，不用设备去试。
 */
const HIGH_BIT_VIDEO_PROBES: { codec: string; mime: string }[] = [
  { codec: 'hevc', mime: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
  { codec: 'hevc', mime: 'video/mp4; codecs="hev1.2.4.L153.B0"' },
  { codec: 'hevc', mime: 'video/mp4; codecs="hvc1.2.4.L156.B0"' },
  { codec: 'av1', mime: 'video/mp4; codecs="av01.0.08M.10.0.110.09.16.09.0"' },
]

const BASE_VIDEO_PROBES: { codec: string; mime: string }[] = [
  { codec: 'h264', mime: 'video/mp4; codecs="avc1.42E01E"' },
  { codec: 'hevc', mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  { codec: 'av1', mime: 'video/mp4; codecs="av01.0.08M.08"' },
]

const AUDIO_PROBES: { codec: string; mime: string }[] = [
  { codec: 'aac', mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { codec: 'mp3', mime: 'audio/mp4; codecs="mp4a.40.34"' },
  { codec: 'opus', mime: 'audio/mp4; codecs="opus"' },
  { codec: 'vorbis', mime: 'audio/mp4; codecs="vorbis"' },
  { codec: 'flac', mime: 'audio/mp4; codecs="flac"' },
  { codec: 'ac3', mime: 'audio/mp4; codecs="ac-3"' },
  { codec: 'eac3', mime: 'audio/mp4; codecs="ec-3"' },
]

/** 兜底表：探测不可用时的历史行为（电视有 hevc、桌面只有 h264）。 */
export const FALLBACK_VIDEO_TV = ['h264', 'hevc']
export const FALLBACK_VIDEO_DESKTOP = ['h264']
export const FALLBACK_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac']

let cached: WebCodecCaps | null = null

function supports(mime: string): boolean {
  try {
    const ms = (window as unknown as { MediaSource?: { isTypeSupported(t: string): boolean } }).MediaSource
    if (!ms || typeof ms.isTypeSupported !== 'function') return false
    return ms.isTypeSupported(mime) === true
  } catch {
    return false
  }
}

/**
 * 探测一次并缓存。
 *
 * 只在 Chromium / Android WebView 里跑：
 *   · Safari/iOS 的 HLS 走系统播放器（不是 MSE），isTypeSupported 的结论
 *     会和实际播放不一致，硬用它会把能播的片判成不能播；
 *   · 没有 MediaSource（SSR / 单测）→ probed=false，调用方走兜底表。
 */
export function detectCodecCaps(): WebCodecCaps {
  if (cached) return cached
  const hasMS =
    typeof window !== 'undefined' &&
    !!(window as unknown as { MediaSource?: unknown }).MediaSource
  if (!hasMS || isAppleWebkit()) {
    cached = { probed: false, video: [], highBitVideo: [], audio: [] }
    return cached
  }
  const video: string[] = []
  const highBitVideo: string[] = []
  const audio: string[] = []
  for (const p of BASE_VIDEO_PROBES) {
    if (supports(p.mime) && !video.includes(p.codec)) video.push(p.codec)
  }
  for (const p of HIGH_BIT_VIDEO_PROBES) {
    if (supports(p.mime) && !highBitVideo.includes(p.codec)) highBitVideo.push(p.codec)
  }
  for (const p of AUDIO_PROBES) {
    if (supports(p.mime) && !audio.includes(p.codec)) audio.push(p.codec)
  }
  cached = { probed: true, video, highBitVideo, audio }
  return cached
}

/** 只用于测试：清缓存（探测结果在一次会话里不该变）。 */
export function __resetCodecCapsCache(): void {
  cached = null
}
