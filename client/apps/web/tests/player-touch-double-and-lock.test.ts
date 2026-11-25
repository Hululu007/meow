/**
 * 播放页两个真机行为门禁（2026-11-25，iOS IPA 用户报）：
 *
 * 1. iOS WKWebView 对手指双击只发两次 click、不发 dblclick。旧逻辑里两次
 *    click 各自在 220ms 后 toggle，表现是「第一击显示控制栏、第二击又收起」。
 *    这里验证 click 级的双击兜底：不依赖 dblclick 也能执行双击动作，且
 *    click2 之后补发的原生 dblclick 不会重复执行。
 *
 * 2. 移动端全屏的「锁定」：锁定后点画面不能暂停/快进/弹控制栏，
 *    只在左侧闪出解锁按钮；点它恢复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 必须在 import VideoPlayer 之前把环境摆成"触屏设备"（isTouch 导入时定型）
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

function clickAt(el: Element, x: number, y: number) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
}

function centerRect(el: Element) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 300, height: 200, right: 300, bottom: 200, x: 0, y: 0 }),
    configurable: true,
  })
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
  document.documentElement.removeAttribute('data-shell')
})

describe('iOS 双击兜底（不依赖 dblclick）', () => {
  it('两次相邻 click：中区双击立刻暂停/播放，不会再"亮栏→收栏"', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    const stage = stageOf(w)
    centerRect(stage.element)
    const wrap = w.find('.meow-player-root').element as HTMLElement & { requestFullscreen: unknown }
    const fullscreen = vi.fn().mockResolvedValue(undefined)
    wrap.requestFullscreen = fullscreen

    await stage.element.dispatchEvent(pointerdown('touch'))
    clickAt(stage.element, 150, 100)
    clickAt(stage.element, 152, 102)
    // 等过 220ms 的单击定时器：如果双击兜底没生效，这里会去切控制栏
    await sleep(400)
    await w.vm.$nextTick()

    expect(v.play).toHaveBeenCalledTimes(1)
    expect(fullscreen).not.toHaveBeenCalled()
    w.unmount()
  })

  it('click2 之后补发的原生 dblclick 不重复执行', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    const stage = stageOf(w)
    centerRect(stage.element)

    await stage.element.dispatchEvent(pointerdown('touch'))
    clickAt(stage.element, 150, 100)
    clickAt(stage.element, 151, 101)
    // Android WebView 的顺序：click1 → click2 → dblclick
    stage.element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 151, clientY: 101 }))
    await sleep(400)
    await w.vm.$nextTick()

    expect(v.play).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('鼠标双击仍走全屏（点击级兜底只作用于触屏）', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    const stage = stageOf(w)
    centerRect(stage.element)
    const wrap = w.find('.meow-player-root').element as HTMLElement & { requestFullscreen: unknown }
    const fullscreen = vi.fn().mockResolvedValue(undefined)
    wrap.requestFullscreen = fullscreen

    await stage.element.dispatchEvent(pointerdown('mouse'))
    // 鼠标双击：click 带 pointerType='mouse'
    const c1 = new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100 })
    Object.defineProperty(c1, 'pointerType', { value: 'mouse' })
    const c2 = new MouseEvent('click', { bubbles: true, clientX: 150, clientY: 100 })
    Object.defineProperty(c2, 'pointerType', { value: 'mouse' })
    stage.element.dispatchEvent(c1)
    stage.element.dispatchEvent(c2)
    stage.element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 100 }))
    await sleep(400)
    await w.vm.$nextTick()

    expect(fullscreen).toHaveBeenCalledTimes(1)
    expect(v.play).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('移动端全屏锁定', () => {
  /** 手机 CSS 视口（jsdom 默认 1024×768 是桌面形态，canLock 会判成非移动端） */
  function setViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  }
  afterEach(() => setViewport(1024, 768))

  async function enterFullscreen(w: ReturnType<typeof mountPlayer>) {
    const fsBtn = w.findAll('button').find((b) => b.attributes('title') === '全屏')
    if (!fsBtn) throw new Error('底栏没有全屏按钮')
    await fsBtn.trigger('click')
    // toggleFullscreen 是 async：requestFullscreen 被拒不一定会同步落到伪全屏
    await sleep(30)
    await w.vm.$nextTick()
  }

  it('竖屏不显示锁定按钮，进全屏才出现', async () => {
    setViewport(390, 844)
    const w = mountPlayer()
    fakeMedia(w)
    await w.vm.$nextTick()
    expect(w.findAll('button').some((b) => b.attributes('aria-label') === '锁定画面')).toBe(false)
    await enterFullscreen(w)
    expect(w.findAll('button').some((b) => b.attributes('aria-label') === '锁定画面')).toBe(true)
    w.unmount()
  })

  it('锁定后点画面不播放/暂停，只闪出解锁按钮；点解锁恢复', async () => {
    setViewport(390, 844)
    const w = mountPlayer()
    const v = fakeMedia(w)
    const stage = stageOf(w)
    centerRect(stage.element)
    await enterFullscreen(w)

    const lockBtn = w.findAll('button').find((b) => b.attributes('aria-label') === '锁定画面')
    await lockBtn!.trigger('click')
    await w.vm.$nextTick()

    // 锁定后点击画面：既不能暂停/播放，也不能把控制栏唤出来
    clickAt(stage.element, 150, 100)
    await sleep(320)
    await w.vm.$nextTick()
    expect(v.play).not.toHaveBeenCalled()
    expect(v.pause).not.toHaveBeenCalled()

    const unlock = w.findAll('button').find((b) => b.attributes('aria-label') === '解锁画面')
    expect(unlock, '锁定时点屏幕应闪出解锁按钮').toBeTruthy()
    await unlock!.trigger('click')
    await w.vm.$nextTick()
    expect(w.findAll('button').some((b) => b.attributes('aria-label') === '解锁画面')).toBe(false)

    // 解锁后手势恢复：双击中区恢复播放（单击只切控制栏，不该拿它当判据）
    clickAt(stage.element, 150, 100)
    clickAt(stage.element, 151, 101)
    await sleep(320)
    expect(v.play).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('自动横屏播放（未点全屏）也有锁按钮', async () => {
    // iPhone 横屏 CSS 视口：844×390（短边 < 480 → compact）
    setViewport(844, 390)
    const w = mountPlayer()
    fakeMedia(w)
    await w.vm.$nextTick()
    expect(
      w.findAll('button').some((b) => b.attributes('aria-label') === '锁定画面'),
      '自动转横屏后锁按钮不能消失（用户 2026-11-25 真机报）',
    ).toBe(true)
    w.unmount()
  })

  it('移动端底栏提供弹幕设置入口（搜索图标右侧），不再收进更多', async () => {
    const w = mountPlayer()
    fakeMedia(w)
    const btn = w.findAll('button').find((b) => b.attributes('aria-label') === '弹幕设置')
    expect(btn, '底栏缺少弹幕设置按钮').toBeTruthy()
    await btn!.trigger('click')
    await w.vm.$nextTick()
    expect(w.find('[data-panel="dm"]').exists()).toBe(true)
    w.unmount()
  })

  it('退出全屏自动解锁（不留无入口的锁定状态）', async () => {
    setViewport(390, 844)
    const w = mountPlayer()
    fakeMedia(w)
    await enterFullscreen(w)
    const lockBtn = w.findAll('button').find((b) => b.attributes('aria-label') === '锁定画面')
    await lockBtn!.trigger('click')
    await w.vm.$nextTick()

    // 全屏按钮此时是"退出全屏"，点它 → pseudoFs=false → watch 自动解锁
    const fsBtn = w.findAll('button').find((b) => b.attributes('title') === '全屏')
    await fsBtn!.trigger('click')
    await w.vm.$nextTick()
    await sleep(50)
    await w.vm.$nextTick()
    expect(w.findAll('button').some((b) => b.attributes('aria-label') === '锁定画面')).toBe(false)
    w.unmount()
  })
})
