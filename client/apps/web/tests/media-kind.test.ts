import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { hasNativeHls, looksLikeDirectMedia, looksLikeHls } from '../src/components/player/mediaKind'

/**
 * 2026-11-04 真机实测：源站给的 `wmm.php?...` 内容是清单但没有 `.m3u8`。
 * TV 有原生嗅探能播，PC 没有原生 HLS → 直接 src not supported。
 */
describe('播放引擎选择', () => {
  it('写明 .m3u8 的一律走 hls.js（两端一致）', () => {
    expect(looksLikeHls('https://cdn.example/a/index.m3u8', false)).toBe(true)
    expect(looksLikeHls('https://cdn.example/a/index.m3u8', true)).toBe(true)
    expect(looksLikeHls('https://cdn.example/a/index.m3u8?token=1', false)).toBe(true)
  })

  it('代理地址里编码的 .m3u8 也认得', () => {
    const u = 'http://127.0.0.1:9979/api/proxy/stream?url=https%3A%2F%2Fcdn%2Fa.m3u8'
    expect(looksLikeHls(u, false)).toBe(true)
  })

  it('没有扩展名的 .php 地址：PC 当清单试，Android 交回原生', () => {
    const u = 'http://103.236.72.182:2666/wmm.php?key=1&url=https://v.qq.com/x.html'
    expect(looksLikeHls(u, false), 'PC 无原生 HLS，要试 hls.js').toBe(true)
    expect(looksLikeHls(u, true), 'Android 有原生嗅探，保持旧行为').toBe(false)
  })

  it('明确的单文件扩展名不会被当清单', () => {
    for (const u of [
      'https://cdn.example/v/a.mp4',
      'https://cdn.example/v/a.mkv?token=2',
      'https://cdn.example/v/a.flv',
      'http://127.0.0.1:9979/api/proxy/stream?url=https%3A%2F%2Fcdn%2Fa.mp4',
    ]) {
      expect(looksLikeHls(u, false), u).toBe(false)
    }
  })

  it('空地址不猜', () => {
    expect(looksLikeHls('', false)).toBe(false)
  })

  it('looksLikeDirectMedia 只认单文件', () => {
    expect(looksLikeDirectMedia('https://x/a.mp4')).toBe(true)
    expect(looksLikeDirectMedia('https://x/a.m3u8')).toBe(false)
  })
})

describe('原生 HLS 判据只认 Android', () => {
  const fake = { canPlayType: () => 'maybe' }

  it('Android WebView 回 maybe → 可信', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S9110) wv' })
    expect(hasNativeHls(fake)).toBe(true)
    vi.unstubAllGlobals()
  })

  it('Windows Edge 也回 maybe，但不可信（实测播不了）', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140' })
    expect(hasNativeHls(fake)).toBe(false)
    vi.unstubAllGlobals()
  })
})
