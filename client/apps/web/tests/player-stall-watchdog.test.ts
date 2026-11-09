import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

/**
 * 假死看门狗（stallTimer）的运行时验证。
 *
 * 场景：清单能拿到（video 触发 loadedmetadata、readyState=1），但分片全 404，
 * 于是 readyState 永远上不到 2、currentTime 恒 0 —— 既不报错也不推进。
 * 实测（MuMu）：404 的 m3u8 在 936ms 就 loadedmetadata，之后完全静止。
 *
 * 这时 20 秒的 startupTimer 要白等满，用户只看到转圈。
 * stallTimer 用 currentTime 作判据，12 秒无进展就判死。
 */
function mountPlayer(props: Record<string, unknown> = {}) {
  return mount(VideoPlayer, { props: { src: '', ...props }, attachTo: document.body })
}

function fakeMedia(wrapper: ReturnType<typeof mountPlayer>, duration = 2400) {
  const v = wrapper.find('video').element as HTMLVideoElement
  let rs = 0
  Object.defineProperty(v, 'duration', { value: duration, configurable: true })
  Object.defineProperty(v, 'paused', { value: true, configurable: true, writable: true })
  Object.defineProperty(v, 'seeking', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'readyState', { get: () => rs, configurable: true })
  Object.defineProperty(v, 'buffered', { value: { length: 0, end: () => 0 }, configurable: true })
  v.load = () => {}
  return {
    v,
    /** 模拟"拿到 metadata 但再也不推进" */
    setReadyState(n: number) {
      rs = n
    },
  }
}

beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
  ;(window as any).__meowTvKeyOwner = false
})

describe('假死看门狗：有 metadata 但 12 秒无进展要判死', () => {
  it('★ readyState=1 且 currentTime 恒 0 → 12 秒后报错（而不是等 20 秒）', async () => {
    const w = mountPlayer({ src: 'http://example.test/stall.m3u8' })
    const { v, setReadyState } = fakeMedia(w)

    // 模拟假死：拿到 metadata、readyState 停在 1、currentTime 不动
    setReadyState(1)
    v.dispatchEvent(new Event('loadedmetadata'))

    // 快速推进到 12.5 秒（不真等，用计时器快进）
    const t0 = Date.now()
    while (Date.now() - t0 < 12_800) {
      await new Promise((r) => setTimeout(r, 400))
    }

    const evs = w.emitted('error') || []
    expect(evs.length).toBeGreaterThan(0)
    // 2026-11-04 起 error 事件带 kind（父组件据此决定换线还是转码）
    const payload = evs[0][0] as { kind?: string; msg?: string }
    const msg = String(payload?.msg ?? payload)
    // 文案要能说明"拿到信息但没画面"
    expect(msg).toMatch(/没画面|无法播放/)
    w.unmount()
  }, 30000)

  it('readyState 到 3 或 currentTime 有推进 → 不报错', async () => {
    const w = mountPlayer({ src: 'http://example.test/ok.m3u8' })
    const { v, setReadyState } = fakeMedia(w)

    setReadyState(1)
    v.dispatchEvent(new Event('loadedmetadata'))
    // 2 秒后"开始出画面"
    await new Promise((r) => setTimeout(r, 2000))
    setReadyState(3)
    Object.defineProperty(v, 'currentTime', { value: 1.5, configurable: true, writable: true })

    await new Promise((r) => setTimeout(r, 12_000))
    const evs = w.emitted('error') || []
    expect(evs.length).toBe(0)
    w.unmount()
  }, 30000)

  it('连 metadata 都没有 → 交给 20 秒那个，不在 12 秒误报', async () => {
    const w = mountPlayer({ src: 'http://example.test/notfound.m3u8' })
    const { setReadyState } = fakeMedia(w)
    // readyState 恒 0：源站连不上
    setReadyState(0)

    await new Promise((r) => setTimeout(r, 13_000))
    const evs = w.emitted('error') || []
    // stallTimer 不该触发（readyState < 1）
    expect(evs.length).toBe(0)
    w.unmount()
  }, 30000)
})
