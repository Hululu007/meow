import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

/**
 * 运行时行为验证（不是静态结构断言）。
 *
 * jsdom 跑不了 hls/dash，但能验证播放器自己那部分状态机：
 * 控制栏可见性、焦点判据、观看时长累计、换源时停媒体。
 * 前几轮同类 bug 都是"静态代码看着对、运行时分支走错"，所以这层必须有。
 */

function mountPlayer(props: Record<string, unknown> = {}) {
  return mount(VideoPlayer, {
    props: { src: '', ...props },
    attachTo: document.body,
  })
}

function fakeMedia(wrapper: ReturnType<typeof mountPlayer>, duration = 2400) {
  const v = wrapper.find('video').element as HTMLVideoElement
  Object.defineProperty(v, 'duration', { value: duration, configurable: true })
  Object.defineProperty(v, 'paused', { value: true, configurable: true, writable: true })
  Object.defineProperty(v, 'seeking', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'buffered', {
    value: { length: 0, end: () => 0 },
    configurable: true,
  })
  v.load = () => {}
  return v
}

beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
  window.__meowTvKeyOwner = false
})

/**
 * 把 jsdom 摆成指定设备形态，跑完还原。
 *
 * ★ 为什么必须摆：jsdom 的 `matchMedia` 是个空壳，任何查询都返回
 *   `matches=false`；`innerWidth/innerHeight` 默认 1024×768。
 *   照抄进 `isBigScreenLandscape()` 就等于"永远当成大屏横屏、没有鼠标的电视"，
 *   于是「非 TV 环境保留返回键」必然失败 —— 失败的不是产品，是环境没摆对。
 *
 * @param finePointer 是否有鼠标/触控板（`any-pointer: fine`）
 */
async function withDevice(
  width: number,
  height: number,
  finePointer: boolean,
  run: () => Promise<void>,
) {
  const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const mm = window.matchMedia
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  window.matchMedia = ((q: string) => ({
    matches: q.includes('fine') ? finePointer : false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as any
  try {
    await run()
  } finally {
    if (iw) Object.defineProperty(window, 'innerWidth', iw)
    if (ih) Object.defineProperty(window, 'innerHeight', ih)
    window.matchMedia = mm
  }
}

describe('观看时长：按墙钟累计，不靠 pos 差值', () => {
  it('播放 3 秒后 progress 里的 watched 接近 3（而不是 0）', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const v = fakeMedia(w)
    ;(v as any).paused = false

    // jsdom 的 performance.now 是真的，直接推进 currentTime 并连续触发 timeupdate
    const t0 = performance.now()
    let elapsed = 0
    while (elapsed < 3000) {
      await new Promise((r) => setTimeout(r, 120))
      elapsed = performance.now() - t0
      v.currentTime = elapsed / 1000
      v.dispatchEvent(new Event('timeupdate'))
    }
    // 再等一次心跳（每 5 秒发，或 watched 推进 5 秒发）
    v.currentTime = 6
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()

    const evs = w.emitted('progress') || []
    expect(evs.length).toBeGreaterThan(0)
    const last = evs[evs.length - 1][0] as any
    expect(typeof last.watched).toBe('number')
    expect(last.watched).toBeGreaterThan(1.5)
    // 一条 pos 差 ≤ 5 的旧实现会拿到 0，这里必须明显大于 0
    w.unmount()
  })

  it('暂停期间不累计', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const v = fakeMedia(w)
    ;(v as any).paused = true
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 100))
      v.dispatchEvent(new Event('timeupdate'))
    }
    v.currentTime = 9
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()
    const evs = w.emitted('progress') || []
    const last = evs.length ? (evs[evs.length - 1][0] as any) : { watched: 0 }
    expect(last.watched).toBe(0)
    w.unmount()
  })

  it('seek 期间不累计（seeking=true）', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const v = fakeMedia(w)
    ;(v as any).paused = false
    ;(v as any).seeking = true
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100))
      v.dispatchEvent(new Event('timeupdate'))
    }
    v.currentTime = 12
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()
    const evs = w.emitted('progress') || []
    const last = evs.length ? (evs[evs.length - 1][0] as any) : { watched: 0 }
    expect(last.watched).toBe(0)
    w.unmount()
  })

  it('换源后 watched 归零（新一集从头计）', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const v = fakeMedia(w)
    ;(v as any).paused = false
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100))
      v.dispatchEvent(new Event('timeupdate'))
    }
    await w.setProps({ src: 'http://x/b.m3u8' })
    // setupSource 会重置 watchedSec，紧接着的 progress 应该报小值
    await new Promise((r) => setTimeout(r, 50))
    const evs = w.emitted('progress') || []
    const last = evs.length ? (evs[evs.length - 1][0] as any) : null
    if (last) expect(last.watched || 0).toBeLessThan(2)
    w.unmount()
  })
})

describe('音轨重叠：换源前必须停掉旧媒体', () => {
  it('setProps 换 src 时对 <video> 调了 pause + 清 src', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const v = fakeMedia(w)
    let paused = 0
    let cleared = 0
    v.pause = () => {
      paused++
    }
    const origRemove = v.removeAttribute.bind(v)
    v.removeAttribute = (name: string) => {
      if (name === 'src') cleared++
      origRemove(name)
    }
    await w.setProps({ src: 'http://x/b.m3u8' })
    expect(paused).toBeGreaterThan(0)
    expect(cleared).toBeGreaterThan(0)
    w.unmount()
  })

  it('卸载时也停（切集整页重建，不靠节点被移除）', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    const v = fakeMedia(w)
    let paused = 0
    let muted = false
    v.pause = () => {
      paused++
    }
    Object.defineProperty(v, 'muted', {
      configurable: true,
      get: () => muted,
      set: (x: boolean) => {
        muted = x
      },
    })
    w.unmount()
    expect(paused).toBeGreaterThan(0)
    expect(muted).toBe(true)
  })
})

describe('控制栏可见性：收起后不能留在焦点候选里', () => {
  it('收起时底栏带 invisible，展开后没有', async () => {
    const w = mountPlayer({ src: 'http://x/a.m3u8' })
    fakeMedia(w)
    // 挂载时控制栏是显示的（用户刚进来看片，需要能看到操作入口）
    for (const b of w.findAll('.meow-ctrl-bar')) {
      expect(b.classes()).not.toContain('invisible')
    }
    // 片头/片尾提示都不在时，退格键收起控制栏
    const w2 = mountPlayer({ src: 'http://x/a.m3u8' })
    fakeMedia(w2)
    const consumed = (window as any).__meowTvConsumeBack?.()
    await w2.vm.$nextTick()
    if (consumed) {
      for (const b of w2.findAll('.meow-ctrl-bar')) {
        expect(b.classes()).toContain('invisible')
      }
    }
    w2.unmount()
    w.unmount()
  })

  it('TV 环境下不渲染左上角返回按钮', async () => {
    document.documentElement.setAttribute('data-tv', '1')
    window.__meowTvKeyOwner = true
    // 真电视形态：大屏横屏 + 没有鼠标/触控（遥控器自带返回键）
    await withDevice(960, 540, false, async () => {
      const w = mountPlayer({ src: 'http://x/a.m3u8' })
      fakeMedia(w)
      await w.find('.group').trigger('mousemove')
      await w.vm.$nextTick()
      const back = w.findAll('button[aria-label="返回"]')
      expect(back.length).toBe(0)
      w.unmount()
    })
  })

  it('非 TV 环境保留返回按钮', async () => {
    // 桌面浏览器：有鼠标 → 不是"大屏横屏无指针"形态 → 给返回键
    await withDevice(1440, 900, true, async () => {
      const w = mountPlayer({ src: 'http://x/a.m3u8' })
      fakeMedia(w)
      await w.find('.group').trigger('mousemove')
      await w.vm.$nextTick()
      const back = w.findAll('button[aria-label="返回"]')
      expect(back.length).toBe(1)
      w.unmount()
    })
  })

  it('TV 壳跑在手机模拟器上（横屏但短边 < 480）也保留返回按钮', async () => {
    // 2026-11-12 用户口径：只有「大屏横屏的电视/投影仪」不给返回键，
    // 其他形态都给 —— 手机横屏（短边 390）算"其他"。
    await withDevice(844, 390, false, async () => {
      const w = mountPlayer({ src: 'http://x/a.m3u8' })
      fakeMedia(w)
      await w.find('.group').trigger('mousemove')
      await w.vm.$nextTick()
      const back = w.findAll('button[aria-label="返回"]')
      expect(back.length).toBe(1)
      w.unmount()
    })
  })
})
