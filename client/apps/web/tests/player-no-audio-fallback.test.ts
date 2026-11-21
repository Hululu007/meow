import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

/**
 * 「音频零解码」检测的回归门禁（2026-11-21 投影仪实报）。
 *
 * Android WebView 直连片库 mkv 时，AC3/E-AC3/DTS 音轨没有解码器：
 * 画面正常、不报 MediaError、解码字节数恒 0，用户听到的是彻底无声。
 * 播放器在直连源上双采样该计数，全 0 且视频确实在解 → emit('no-audio')，
 * 父组件（片库）落转码兜底。
 */

function mountPlayer(props: Record<string, unknown> = {}) {
  return mount(VideoPlayer, {
    props: { src: 'https://cdn.example.com/a.mp4', ...props },
    attachTo: document.body,
  })
}

/** jsdom 的 video 元素带不上解码计数，这里按用例需要直接挂属性 */
function fakeMedia(wrapper: ReturnType<typeof mountPlayer>, opts: {
  audioDecoded?: number
  videoDecoded?: number
  muted?: boolean
  volume?: number
} = {}) {
  const v = wrapper.find('video').element as HTMLVideoElement & {
    webkitAudioDecodedByteCount?: number
    webkitVideoDecodedByteCount?: number
  }
  if ('audioDecoded' in opts)
    (v as any).webkitAudioDecodedByteCount = opts.audioDecoded
  if ('videoDecoded' in opts)
    (v as any).webkitVideoDecodedByteCount = opts.videoDecoded
  Object.defineProperty(v, 'duration', { value: 1800, configurable: true })
  Object.defineProperty(v, 'paused', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'readyState', { value: 4, configurable: true, writable: true })
  Object.defineProperty(v, 'seeking', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'buffered', {
    value: { length: 0, end: () => 0 },
    configurable: true,
  })
  v.load = () => {}
  v.pause = () => {}
  v.play = (() => Promise.resolve()) as unknown as HTMLMediaElement['play']
  v.volume = opts.volume ?? 0.5
  v.muted = opts.muted ?? false
  return v
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
})

afterEach(() => {
  vi.useRealTimers()
})

/** 起播到可判定状态：metadata + play + currentTime 推进 */
async function startPlaying(wrapper: ReturnType<typeof mountPlayer>) {
  const v = wrapper.find('video').element as HTMLVideoElement
  Object.defineProperty(v, 'currentTime', { value: 30, configurable: true })
  v.dispatchEvent(new Event('loadedmetadata'))
  v.dispatchEvent(new Event('play'))
  await vi.advanceTimersByTimeAsync(50)
  return v
}

describe('直连源音频零解码 → no-audio 事件', () => {
  it('音频计数两拍全 0、视频在解 → emit no-audio', async () => {
    const w = mountPlayer({ noAudioFallback: true })
    const v = fakeMedia(w, { audioDecoded: 0, videoDecoded: 1_000_000 })
    await startPlaying(w)

    // 第一拍（4s）0 → 继续等；第二拍（+2.5s）仍 0 → 命中
    await vi.advanceTimersByTimeAsync(4200)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    await vi.advanceTimersByTimeAsync(2600)
    expect((w.emitted('no-audio') || []).length).toBe(1)
    // 只发一次
    await vi.advanceTimersByTimeAsync(5000)
    expect((w.emitted('no-audio') || []).length).toBe(1)
    w.unmount()
  })

  it('同构写法对照：逐行挂 fake 元素（排除 fakeMedia 差异）', async () => {
    const w = mount(VideoPlayer, {
      props: { src: 'https://cdn.example.com/a.mp4', noAudioFallback: true },
      attachTo: document.body,
    })
    const v = w.find('video').element as any
    v.webkitAudioDecodedByteCount = 0
    v.webkitVideoDecodedByteCount = 1000000
    Object.defineProperty(v, 'duration', { value: 1800, configurable: true })
    Object.defineProperty(v, 'paused', { value: false, configurable: true, writable: true })
    Object.defineProperty(v, 'readyState', { value: 4, configurable: true, writable: true })
    Object.defineProperty(v, 'currentTime', { value: 30, configurable: true })
    Object.defineProperty(v, 'seeking', { value: false, configurable: true })
    Object.defineProperty(v, 'buffered', { value: { length: 0, end: () => 0 }, configurable: true })
    v.load = () => {}
    v.pause = () => {}
    v.play = () => Promise.resolve()
    v.dispatchEvent(new Event('loadedmetadata'))
    v.dispatchEvent(new Event('play'))
    await vi.advanceTimersByTimeAsync(4200)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    await vi.advanceTimersByTimeAsync(2600)
    expect((w.emitted('no-audio') || []).length).toBe(1)
    w.unmount()
  })

  it('音频计数 > 0（AAC 正常解码）→ 永不 emit', async () => {
    const w = mountPlayer({ noAudioFallback: true })
    fakeMedia(w, { audioDecoded: 880_000, videoDecoded: 9_000_000 })
    await startPlaying(w)
    await vi.advanceTimersByTimeAsync(15000)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    w.unmount()
  })

  it('静音/零音量时不判（muted 下 Chromium 跳过音频解码，0 是正常的）', async () => {
    const w = mountPlayer({ noAudioFallback: true })
    const v = fakeMedia(w, { audioDecoded: 0, videoDecoded: 1_000_000 })
    await startPlaying(w)
    // 静音要在 metadata 之后再设：onLoaded 会把元素状态恢复成用户偏好
    // （muted=false），组件内静音场景走 prefs，元素上的 muted 会被覆盖回去
    v.muted = true
    await vi.advanceTimersByTimeAsync(15000)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    w.unmount()
  })

  it('内核没暴露解码计数、且无 AudioContext → 安全退化，不 emit', async () => {
    const w = mountPlayer({ noAudioFallback: true })
    const v = fakeMedia(w)
    // 不挂任何 webkit* 属性
    v.dispatchEvent(new Event('loadedmetadata'))
    v.dispatchEvent(new Event('play'))
    await vi.advanceTimersByTimeAsync(15000)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    w.unmount()
  })

  it('计数器缺席 → 走 WebAudio 通道：两拍能量 0 判无声（AC3 场景）', async () => {
    // jsdom 没有 AudioContext：塞一个可控 fake
    class FakeAnalyser {
      fftSize = 2048
      connect() {}
      getFloatTimeDomainData(buf: Float32Array) {
        for (let i = 0; i < buf.length; i++) buf[i] = 0 // 全静音样本
      }
    }
    class FakeCtx {
      state = 'running'
      destination = {}
      resume = async () => {}
      close = async () => {}
      createMediaElementSource = () => ({ connect: () => {} })
      createAnalyser = () => new FakeAnalyser()
    }
    ;(window as any).AudioContext = FakeCtx

    const w = mountPlayer({ noAudioFallback: true })
    const v = fakeMedia(w, {}) // 不带 webkit 计数器 → 走通道②
    await startPlaying(w)
    // crossorigin 必须先设置（WebAudio 探测要求媒体非跨源污染）
    expect(v.crossOrigin).toBe('anonymous')
    await vi.advanceTimersByTimeAsync(4200) // 计数器分支的第一拍（t=4000）→ 切到 WebAudio
    expect((w.emitted('no-audio') || []).length).toBe(0)
    await vi.advanceTimersByTimeAsync(5200) // WebAudio 第一拍 t=9000：能量 0，streak=1
    expect((w.emitted('no-audio') || []).length).toBe(0)
    await vi.advanceTimersByTimeAsync(2600) // 第二拍 t=11500：仍 0 → 判无声
    expect((w.emitted('no-audio') || []).length).toBe(1)
    w.unmount()
    delete (window as any).AudioContext
  })

  it('WebAudio 通道：能量 > 0（AAC 正常）→ 不 emit', async () => {
    class FakeAnalyser {
      fftSize = 2048
      connect() {}
      getFloatTimeDomainData(buf: Float32Array) {
        for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? 0.5 : -0.5
      }
    }
    class FakeCtx {
      state = 'running'
      destination = {}
      resume = async () => {}
      close = async () => {}
      createMediaElementSource = () => ({ connect: () => {} })
      createAnalyser = () => new FakeAnalyser()
    }
    ;(window as any).AudioContext = FakeCtx

    const w = mountPlayer({ noAudioFallback: true })
    const v = fakeMedia(w, {})
    await startPlaying(w)
    await vi.advanceTimersByTimeAsync(15000)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    w.unmount()
    delete (window as any).AudioContext
  })

  it('AudioContext 起不来（suspended）→ 放弃探测，不绑不 emit', async () => {
    class FakeAnalyser {
      fftSize = 2048
      connect() {}
      getFloatTimeDomainData(buf: Float32Array) {
        for (let i = 0; i < buf.length; i++) buf[i] = 0
      }
    }
    class FakeCtx {
      state = 'suspended' // autoplay 政策下可能永远起不来
      destination = {}
      resume = async () => {}
      close = async () => {}
      createMediaElementSource = () => {
        throw new Error('should not bind when suspended')
      }
      createAnalyser = () => new FakeAnalyser()
    }
    ;(window as any).AudioContext = FakeCtx

    const w = mountPlayer({ noAudioFallback: true })
    const v = fakeMedia(w, {})
    await startPlaying(w)
    await vi.advanceTimersByTimeAsync(15000)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    w.unmount()
    delete (window as any).AudioContext
  })

  it('未开启 no-audio-fallback（非片库）→ 不检测、不设 crossorigin', async () => {
    const w = mountPlayer({})
    fakeMedia(w, { audioDecoded: 0, videoDecoded: 1_000_000 })
    await startPlaying(w)
    await vi.advanceTimersByTimeAsync(15000)
    expect((w.emitted('no-audio') || []).length).toBe(0)
    expect((w.find('video').element as HTMLVideoElement).crossOrigin).toBe(null)
    w.unmount()
  })
})
