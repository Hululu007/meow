import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

/**
 * TV 播放页返回键的两段语义（2026-11-03 用户调整）。
 *
 *   ① 控制栏 / 弹框显示时：返回只负责把它们隐藏（不碰播放状态）
 *   ② 都没显示时：第一次返回**只弹提示**——不暂停、不唤出控制栏；
 *      提示还在屏上的 2.5 秒内再按，才真的退出（交给壳 goBack）。
 *
 * 原来的实现是"第一次 = 暂停 + 提示"，用户视角是"按了返回画面却定格"。
 */

function mountPlayer(props: Record<string, unknown> = {}) {
  return mount(VideoPlayer, { props: { src: '', ...props }, attachTo: document.body })
}

/** 可控的假 media：记录 pause/load 调用，src 可被 stopMedia 摘掉 */
function fakeMedia(wrapper: ReturnType<typeof mountPlayer>) {
  const v = wrapper.find('video').element as HTMLVideoElement
  const calls = { pause: 0, load: 0 }
  Object.defineProperty(v, 'paused', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'seeking', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'readyState', { get: () => 3, configurable: true })
  Object.defineProperty(v, 'duration', { value: 2400, configurable: true })
  Object.defineProperty(v, 'buffered', { value: { length: 0, end: () => 0 }, configurable: true })
  v.pause = () => { calls.pause++ }
  v.load = () => { calls.load++ }
  return { v, calls }
}

const back = () => (window as unknown as { __meowTvConsumeBack?: () => boolean }).__meowTvConsumeBack?.()

beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.setAttribute('data-tv', '1')
  ;(window as unknown as { __meowTvKeyOwner?: boolean }).__meowTvKeyOwner = true
})

describe('返回键：有东西显示时只隐藏，不碰播放', () => {
  it('控制栏显示时第一次返回 = 收控制栏，不弹提示也不暂停', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const { v, calls } = fakeMedia(w)
    // 挂载时控制栏是显示的
    expect(w.findAll('.meow-ctrl-bar').every((b) => !b.classes().includes('invisible'))).toBe(true)

    expect(back()).toBe(true)
    await w.vm.$nextTick()
    expect(w.findAll('.meow-ctrl-bar').every((b) => b.classes().includes('invisible'))).toBe(true)
    expect(w.text()).not.toContain('再按一次返回退出播放')
    expect(calls.pause).toBe(0)
    expect(v.getAttribute('src')).not.toBeNull() // 没有摘源
    w.unmount()
  })
})

describe('返回键：两段退出（先提示、再退出），全程不暂停', () => {
  it('第一次只弹提示；提示期内再按 → 交还壳（return false）并停媒体', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const { v, calls } = fakeMedia(w)
    back() // 收掉挂载时的控制栏
    await w.vm.$nextTick()

    // ★ 第一次：只提示。不暂停、不唤控制栏、不摘源。
    expect(back()).toBe(true)
    await w.vm.$nextTick()
    expect(w.text()).toContain('再按一次返回退出播放')
    expect(calls.pause).toBe(0)
    expect(v.getAttribute('src')).not.toBeNull()
    expect(w.findAll('.meow-ctrl-bar').every((b) => b.classes().includes('invisible'))).toBe(true)

    // ★ 第二次（提示还在）：退出。壳拿到 false 就 goBack；媒体先彻底停掉。
    expect(back()).toBe(false)
    // pause 只可能是 stopMedia 内部那一次（摘源前的标准流程），不是"暂停播放"语义
    expect(calls.pause).toBeLessThanOrEqual(1)
    expect(v.getAttribute('src')).toBeNull()
    expect(v.muted).toBe(true)
    w.unmount()
  })

  it('提示过期后再按 = 重新提示，不会因为按慢了误退出', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    fakeMedia(w)
    back() // 收控制栏
    await w.vm.$nextTick()
    back() // 弹提示
    await w.vm.$nextTick()
    expect(w.text()).toContain('再按一次返回退出播放')

    // 等提示消失（2.5s 窗口）
    await new Promise((r) => setTimeout(r, 2700))
    expect(w.text()).not.toContain('再按一次返回退出播放')

    expect(back()).toBe(true)
    await w.vm.$nextTick()
    expect(w.text()).toContain('再按一次返回退出播放')
    w.unmount()
  }, 15000)

  it('暂停状态下同样只提示，第二下才退出', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const { v, calls } = fakeMedia(w)
    Object.defineProperty(v, 'paused', { value: true, configurable: true, writable: true })
    back()
    await w.vm.$nextTick()
    expect(back()).toBe(true)
    await w.vm.$nextTick()
    expect(w.text()).toContain('再按一次返回退出播放')
    expect(back()).toBe(false)
    expect(v.getAttribute('src')).toBeNull()
    w.unmount()
  })
})
