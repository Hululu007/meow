import { describe, expect, it } from 'vitest'
import { resolvePlaybackRoute } from '../src/utils/playRoute'

/**
 * 播放分配决策矩阵（2026-11-21）：纯函数全用例。
 * 分配层所有行为变化都必须在这里加用例锁住。
 */

const AAC = { acodec: 'aac', vcodec: 'h264' }
const AC3 = { acodec: 'ac3', vcodec: 'h264' }
const HEVC_AC3 = { acodec: 'ac3', vcodec: 'hevc' }
const DTS = { acodec: 'dts', vcodec: 'h264' }

const TV_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac']
const TV_VIDEO = ['h264', 'hevc']
const PC_VIDEO = ['h264']

function tv(input: Partial<Parameters<typeof resolvePlaybackRoute>[0]> = {}) {
  return resolvePlaybackRoute({
    audioCodecs: TV_AUDIO,
    videoCodecs: TV_VIDEO,
    hasNative: true,
    preferNativeOnSilent: false,
    transcodeAvailable: true,
    ...input,
  })
}
function pc(input: Partial<Parameters<typeof resolvePlaybackRoute>[0]> = {}) {
  return resolvePlaybackRoute({
    audioCodecs: TV_AUDIO,
    videoCodecs: PC_VIDEO,
    hasNative: false,
    preferNativeOnSilent: false,
    transcodeAvailable: true,
    ...input,
  })
}

describe('播放分配：直连优先（全可解）', () => {
  it('AAC+H264 → 直连（TV/PC 同）', () => {
    expect(tv({ probe: AAC })).toBe('direct')
    expect(pc({ probe: AAC })).toBe('direct')
  })
  it('TV 新内核 H265+AAC → 直连；PC（桌面无 H265）→ 转码', () => {
    expect(tv({ probe: { acodec: 'aac', vcodec: 'hevc' } })).toBe('direct')
    expect(pc({ probe: { acodec: 'aac', vcodec: 'hevc' } })).toBe('transcode')
  })
  it('无 probe（未探测/老后端）→ direct（交给运行时检测兜底）', () => {
    expect(tv({ probe: null })).toBe('direct')
  })
})

describe('播放分配：音频超纲（AC3/DTS）', () => {
  it('TV 默认（提示式）→ native-hint', () => {
    expect(tv({ probe: AC3 })).toBe('native-hint')
    expect(tv({ probe: DTS })).toBe('native-hint')
  })
  it('TV 开了「无声自动用原生」→ native', () => {
    expect(tv({ probe: AC3, preferNativeOnSilent: true })).toBe('native')
  })
  it('PC（无原生桥）→ 转码', () => {
    expect(pc({ probe: AC3 })).toBe('transcode')
  })
  it('后端无转码能力 → 仍提示原生（赌设备能解）', () => {
    expect(pc({ probe: AC3, transcodeAvailable: false })).toBe('native-hint')
    expect(tv({ probe: AC3, transcodeAvailable: false })).toBe('native-hint')
  })
})

describe('播放分配：视频超纲（hevc 在桌面）', () => {
  it('桌面 H265+AC3 双超纲 → 无原生 → 转码', () => {
    expect(pc({ probe: HEVC_AC3 })).toBe('transcode')
  })
})

describe('③ Safari 能力表（AC3/E-AC3 可直解）', () => {
  const safariUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  it('webviewAudioCodecs：Apple Webkit 含 ac3/eac3，Chromium 不含', async () => {
    const { webviewAudioCodecs } = await import('../src/utils/playRoute')
    expect(webviewAudioCodecs(false)).toEqual(['aac', 'mp3', 'opus', 'vorbis', 'flac'])
    expect(webviewAudioCodecs(true).includes('ac3')).toBe(true)
    expect(webviewAudioCodecs(true).includes('eac3')).toBe(true)
  })
  it('Safari 上 AC3 文件 → direct（不被误送去转码）', () => {
    // Safari 的能力表注入
    const r = resolvePlaybackRoute({
      probe: AC3,
      audioCodecs: ['aac', 'mp3', 'ac3', 'eac3'],
      videoCodecs: ['h264', 'hevc'],
      hasNative: false,
      preferNativeOnSilent: false,
      transcodeAvailable: true,
    })
    expect(r).toBe('direct')
  })
})

describe('播放分配：10-bit H.264（Hi10P，2026-11-23 片库实报）', () => {
  const HI10P = { acodec: 'aac', vcodec: 'h264', pixfmt: 'yuv420p10le' }
  it('TV 有原生桥也走转码：电视硬解同样只吃 8-bit', () => {
    expect(tv({ probe: HI10P })).toBe('transcode')
    expect(tv({ probe: HI10P, preferNativeOnSilent: true })).toBe('transcode')
  })
  it('PC → 转码', () => {
    expect(pc({ probe: HI10P })).toBe('transcode')
  })
  it('连转码都没有 → 提示原生（最后一条路）', () => {
    expect(tv({ probe: HI10P, transcodeAvailable: false })).toBe('native-hint')
  })
  it('8-bit yuv420p 不受影响 → 直连', () => {
    expect(tv({ probe: { ...AAC, pixfmt: 'yuv420p' } })).toBe('direct')
    expect(pc({ probe: { ...AAC, pixfmt: 'yuv420p' } })).toBe('direct')
  })
  it('nv12 是 8-bit（名字含 12 不算高位深）→ 直连', () => {
    expect(tv({ probe: { ...AAC, pixfmt: 'nv12' } })).toBe('direct')
  })
  it('p010le / yuv420p12le 都识别为高位深', () => {
    expect(tv({ probe: { ...AAC, pixfmt: 'p010le' } })).toBe('transcode')
    expect(pc({ probe: { ...AAC, pixfmt: 'yuv420p12le' } })).toBe('transcode')
  })
})

describe('播放分配：探测失败按可解算', () => {
  it('acodec 缺失（probe 半残）→ direct，不把用户赶去转码', () => {
    expect(tv({ probe: { vcodec: 'h264' } })).toBe('direct')
    expect(pc({ probe: { acodec: 'aac' } })).toBe('direct')
  })
})

/**
 * 高位深 HEVC Main10（2026-11-24 降画质实报）。
 *
 * 旧逻辑拿"10-bit"一刀切 → 全部转码 → 用户看到 4K 被砍成 1080p。
 * 正确逻辑看**这台设备能不能解**：实测 WebView2 对
 * `video/mp4; codecs="hvc1.2.4.L153.B0"` 返回 true。
 */
describe('播放分配：HEVC Main10（4K HDR 的标准编码）', () => {
  const MAIN10 = { acodec: 'aac', vcodec: 'hevc', pixfmt: 'yuv420p10le' }
  const MAIN10_AC3 = { acodec: 'ac3', vcodec: 'hevc', pixfmt: 'yuv420p10le' }
  /** 实测能力：能解 HEVC 10-bit，不能解 AC3 */
  const CAPS_OK = {
    probed: true,
    video: ['h264', 'hevc', 'av1'],
    highBitVideo: ['hevc', 'av1'],
    audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  }
  /** 实测能力：高位深解不了 */
  const CAPS_NO_HI = {
    probed: true,
    video: ['h264', 'hevc'],
    highBitVideo: [] as string[],
    audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  }

  it('实测能解 → 直连（不再一刀切转码）', () => {
    expect(tv({ probe: MAIN10, caps: CAPS_OK })).toBe('direct')
    expect(pc({ probe: MAIN10, caps: CAPS_OK })).toBe('direct')
  })
  it('没有实测能力（老内核/SSR）→ 仍允许直连，交给运行时兜底', () => {
    expect(tv({ probe: MAIN10 })).toBe('direct')
    expect(pc({ probe: MAIN10 })).toBe('direct')
  })
  it('实测高位深解不了 → 转码（PC）/ 提示原生（TV）', () => {
    expect(pc({ probe: MAIN10, caps: CAPS_NO_HI })).toBe('transcode')
    expect(tv({ probe: MAIN10, caps: CAPS_NO_HI })).toBe('native-hint')
  })
  it('Main10 + AC3：TV 有原生桥 → 提示原生；PC 开 remux → 视频 copy', () => {
    expect(tv({ probe: MAIN10_AC3, caps: CAPS_OK })).toBe('native-hint')
    expect(pc({ probe: MAIN10_AC3, caps: CAPS_OK, allowRemux: true })).toBe('remux')
  })
  it('AV1 10-bit 同理：实测能解 → 直连', () => {
    const av1 = { acodec: 'aac', vcodec: 'av1', pixfmt: 'yuv420p10le' }
    expect(pc({ probe: av1, caps: CAPS_OK })).toBe('direct')
    expect(pc({ probe: av1, caps: CAPS_NO_HI })).toBe('transcode')
  })
  it('H.264 10-bit（Hi10P）仍然转码：设备共同盲区，不被 HEVC 规则带偏', () => {
    const hi10p = { acodec: 'aac', vcodec: 'h264', pixfmt: 'yuv420p10le' }
    expect(tv({ probe: hi10p, caps: CAPS_OK })).toBe('transcode')
    expect(pc({ probe: hi10p, caps: CAPS_OK })).toBe('transcode')
  })
})

describe('播放分配：remux（视频 copy + 音频转码，零画质损失）', () => {
  it('默认不开：AC3 在 PC 仍走整条转码（旧行为，不回归）', () => {
    expect(pc({ probe: AC3 })).toBe('transcode')
  })
  it('片库/局域网打开后：音频解不了 + 视频能解 → remux', () => {
    expect(pc({ probe: AC3, allowRemux: true })).toBe('remux')
    expect(pc({ probe: DTS, allowRemux: true })).toBe('remux')
  })
  it('有原生桥时优先原生提示（电视硬解 = 原画）', () => {
    expect(tv({ probe: AC3, allowRemux: true })).toBe('native-hint')
    expect(tv({ probe: AC3, allowRemux: true, preferNativeOnSilent: true })).toBe('native')
  })
  it('视频也解不了 → 不是 remux，走转码', () => {
    expect(pc({ probe: HEVC_AC3, allowRemux: true })).toBe('transcode')
  })
  it('后端没有转码能力 → 提示原生，不假装 remux', () => {
    expect(pc({ probe: AC3, allowRemux: true, transcodeAvailable: false })).toBe('native-hint')
  })
})
