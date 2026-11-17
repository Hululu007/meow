/**
 * D-5：双击语义按**事件来源**，不按设备。
 *
 * 场景：触摸屏 PC 的 `isTouch` 恒为 true（`pointer: coarse` 或 `ontouchstart`），
 * 但用户插着鼠标时双击应当全屏（PC 语义），不是左右分区快进。
 * 这里用真实 DOM 事件验证最近一次 pointerdown 的 pointerType 分流：
 *   · pointerdown(mouse) + dblclick → 全屏
 *   · pointerdown(touch) + dblclick(中区) → 暂停/播放
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 必须在 import VideoPlayer 之前把环境摆成"触屏设备"：
// isTouch 是模块级 ref，导入时就定型。jsdom 的 matchMedia 是空壳。
vi.hoisted(() => {
  const anyWindow = window as unknown as Record<string, unknown>
  anyWindow.matchMedia = (q: string) => ({
    matches: q.includes('pointer: coarse'),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
  Object.defineProperty(window, 'ontouchstart', { value: null, configurable: true })
})

import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

function mountPlayer() {
  return mount(VideoPlayer, {
    props: { src: '' },
    attachTo: document.body,
  })
}

function stageOf(wrapper: ReturnType<typeof mountPlayer>) {
  const el = wrapper
    .findAll('div')
    .find((d) => (d.attributes('style') || '').includes('touch-action'))
  if (!el) throw new Error('找不到 stage 元素')
  return el
}

function fakeMedia(wrapper: ReturnType<typeof mountPlayer>) {
  const v = wrapper.find('video').element as HTMLVideoElement
  Object.defineProperty(v, 'paused', { value: true, configurable: true, writable: true })
  Object.defineProperty(v, 'duration', { value: 2400, configurable: true })
  Object.defineProperty(v, 'buffered', {
    value: { length: 0, end: () => 0 },
    configurable: true,
  })
  v.load = () => {}
  v.play = vi.fn().mockResolvedValue(undefined)
  v.pause = vi.fn()
  return v
}

/** jsdom 没有 PointerEvent：造一个带 pointerType 的事件 */
function pointerdown(type: string) {
  const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'pointerType', { value: type })
  return ev
}

function centerRect(el: Element) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0 }),
    configurable: true,
  })
}

beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
})

describe('D-5 双击按事件来源分流', () => {
  it('鼠标双击 → 全屏（触摸屏 PC 不再走分区快进）', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    const stage = stageOf(w)
    centerRect(stage.element)
    // 全屏作用在 wrap（.meow-player-root），不是 stage
    const wrap = w.find('.meow-player-root').element as HTMLElement & { requestFullscreen: unknown }
    const fullscreen = vi.fn().mockResolvedValue(undefined)
    wrap.requestFullscreen = fullscreen

    await stage.element.dispatchEvent(pointerdown('mouse'))
    await stage.trigger('dblclick')
    await w.vm.$nextTick()

    expect(fullscreen).toHaveBeenCalledTimes(1)
    expect(v.play).not.toHaveBeenCalled()
    expect(v.pause).not.toHaveBeenCalled()
    w.unmount()
  })

  it('手指双击中区 → 暂停/播放，不请求全屏', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    const stage = stageOf(w)
    centerRect(stage.element)
    // 全屏作用在 wrap（.meow-player-root），不是 stage
    const wrap = w.find('.meow-player-root').element as HTMLElement & { requestFullscreen: unknown }
    const fullscreen = vi.fn().mockResolvedValue(undefined)
    wrap.requestFullscreen = fullscreen

    await stage.element.dispatchEvent(pointerdown('touch'))
    // clientX 落在中区（0..100 左区 / 100..200 中区 / 200..300 右区）
    stage.element.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 100 }),
    )
    await w.vm.$nextTick()

    expect(fullscreen).not.toHaveBeenCalled()
    expect(v.play).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})
