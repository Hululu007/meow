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

describe('播放分配：探测失败按可解算', () => {
  it('acodec 缺失（probe 半残）→ direct，不把用户赶去转码', () => {
    expect(tv({ probe: { vcodec: 'h264' } })).toBe('direct')
    expect(pc({ probe: { acodec: 'aac' } })).toBe('direct')
  })
})
