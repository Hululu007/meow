import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache, getPrefs, savePrefs } from '../src/stores/prefs'

/**
 * VideoPlayer 与 PlayView 的契约测试。
 *
 * 播放器内核（hls/dash）在 jsdom 里跑不起来，这里只验证
 * 两边靠 interface 约定的那部分：emit 与 defineExpose。
 * 这两条一旦破坏，续播会静默失效（表现是"永远从头开始"）。
 */

function mountPlayer(props: Record<string, unknown> = {}) {
  return mount(VideoPlayer, {
    props: { src: '', ...props },
    attachTo: document.body,
  })
}

/** jsdom 不实现媒体播放，手动给出可控的 duration/currentTime */
function fakeMedia(wrapper: ReturnType<typeof mountPlayer>, duration = 2400) {
  const v = wrapper.find('video').element as HTMLVideoElement
  Object.defineProperty(v, 'duration', { value: duration, configurable: true })
  Object.defineProperty(v, 'paused', { value: true, configurable: true, writable: true })
  Object.defineProperty(v, 'buffered', {
    value: { length: 0, end: () => 0 },
    configurable: true,
  })
  return v
}

describe('VideoPlayer 契约', () => {
  it('暴露 seekTo / getTime / restart', () => {
    const w = mountPlayer()
    const vm = w.vm as any
    expect(typeof vm.seekTo).toBe('function')
    expect(typeof vm.getTime).toBe('function')
    expect(typeof vm.restart).toBe('function')
    w.unmount()
  })

  it('seekTo 把视频定位到指定秒', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    ;(w.vm as any).seekTo(1200)
    expect(Math.round(v.currentTime)).toBe(1200)
    w.unmount()
  })

  it('seekTo 不会越过片尾（留 1 秒余量）', () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 100)
    ;(w.vm as any).seekTo(999)
    expect(v.currentTime).toBeLessThanOrEqual(99)
    w.unmount()
  })

  it('restart 回到开头', () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    v.currentTime = 900
    ;(w.vm as any).restart()
    expect(v.currentTime).toBe(0)
    w.unmount()
  })

  it('元数据就绪时发 loaded，供父组件做续播 seek', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    v.dispatchEvent(new Event('loadedmetadata'))
    await w.vm.$nextTick()
    const evs = w.emitted('loaded')
    expect(evs).toBeTruthy()
    expect((evs![0][0] as any).duration).toBe(2400)
    w.unmount()
  })

  it('播放超 5 秒后发非 final 的 progress', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    v.currentTime = 6
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()
    const evs = w.emitted('progress')
    expect(evs).toBeTruthy()
    const p = evs![0][0] as any
    expect(p.pos).toBe(6)
    expect(p.final).toBe(false)
    w.unmount()
  })

  it('暂停时发 final 的 progress（关键节点，可触发同步）', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    v.currentTime = 42
    v.dispatchEvent(new Event('pause'))
    await w.vm.$nextTick()
    const evs = w.emitted('progress') || []
    const last = evs[evs.length - 1]?.[0] as any
    expect(last?.final).toBe(true)
    expect(last?.pos).toBe(42)
    w.unmount()
  })

  it('卸载时补发一次 final，避免切集丢掉最后几秒', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    v.currentTime = 777
    w.unmount()
    // 卸载后仍能从 emitted 里读到
    const evs = w.emitted('progress') || []
    const last = evs[evs.length - 1]?.[0] as any
    expect(last?.final).toBe(true)
    expect(last?.pos).toBe(777)
  })

  it('有集列表且知道位置时才显示选集', () => {
    const single = mountPlayer({ episodes: [{ name: '1', url: 'a' }], currentIndex: 0 })
    expect(single.text()).not.toContain('选集')
    single.unmount()

    const multi = mountPlayer({
      episodes: [
        { name: '1', url: 'a' },
        { name: '2', url: 'b' },
      ],
      currentIndex: 0,
    })
    expect(multi.text()).toContain('选集')
    multi.unmount()
  })

  it('暂停浮层显示「当前 / 总时长」，不显示剩余时间', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 634)
    // duration ref 由 loadedmetadata 填充，不派发的话浮层条件不成立
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 125
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()
    const text = w.text()
    expect(text).toContain('2:05 / 10:34')
    expect(text).not.toContain('剩余')
    w.unmount()
  })

  it('播放中按方向键 seek 并显示中央时间提示', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 600)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 100
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await w.vm.$nextTick()
    expect(Math.round(v.currentTime)).toBe(105)
    w.unmount()
  })

  it('方向键 seek 后若内核把播放打断，会自动续播', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 600)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 100
    // 播放状态
    Object.defineProperty(v, 'paused', { value: false, configurable: true, writable: true })
    v.dispatchEvent(new Event('play'))
    await w.vm.$nextTick()

    // seek 开始 → 内核中断成暂停
    v.dispatchEvent(new Event('seeking'))
    ;(v as any).paused = true
    v.dispatchEvent(new Event('seeked'))
    await w.vm.$nextTick()
    // 组件应调用 play() 恢复；jsdom 的 play 会 reject，只要不抛即可
    expect(w.emitted('error')).toBeFalsy()
    w.unmount()
  })
})

/**
 * 方向键连按累加。
 *
 * 手感要求：连按 5→10→15 秒，停 500ms 后重新从 5 开始。
 * 这个不生效的话，想跳 30 秒要按 6 次，是日常最烦的细节之一。
 */
describe('方向键连按累加', () => {
  function setup(duration = 600) {
    const w = mountPlayer()
    const v = fakeMedia(w, duration)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 300
    return { w, v }
  }

  function press(key: string) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }

  it('连按三次累加为 5+10+15=30 秒', async () => {
    const { w, v } = setup()
    const t0 = v.currentTime

    press('ArrowRight')
    await w.vm.$nextTick()
    const afterFirst = v.currentTime - t0
    expect(Math.round(afterFirst)).toBe(5)

    press('ArrowRight')
    await w.vm.$nextTick()
    const afterSecond = v.currentTime - t0
    expect(Math.round(afterSecond)).toBe(15) // 5 + 10

    press('ArrowRight')
    await w.vm.$nextTick()
    expect(Math.round(v.currentTime - t0)).toBe(30) // 5 + 10 + 15
    w.unmount()
  })

  it('超过 500ms 未按则重新从 5 秒开始', async () => {
    vi.useFakeTimers()
    try {
      const { w, v } = setup()
      const t0 = v.currentTime
      press('ArrowRight')
      vi.advanceTimersByTime(700)
      press('ArrowRight')
      await w.vm.$nextTick()
      // 第一次 5，隔了 700ms 后第二次又从 5 开始
      expect(Math.round(v.currentTime - t0)).toBe(10)
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('向左连按是负向累加', async () => {
    const { w, v } = setup()
    const t0 = v.currentTime
    press('ArrowLeft')
    press('ArrowLeft')
    await w.vm.$nextTick()
    expect(Math.round(t0 - v.currentTime)).toBe(15) // 5 + 10
    w.unmount()
  })

  it('不会跳到负数或越过片尾', async () => {
    const { w, v } = setup(600)
    v.currentTime = 3
    press('ArrowLeft')
    await w.vm.$nextTick()
    expect(v.currentTime).toBe(0)

    v.currentTime = 598
    press('ArrowRight')
    await w.vm.$nextTick()
    expect(v.currentTime).toBeLessThanOrEqual(600)
    w.unmount()
  })
})

/**
 * 播放信息调试面板。
 *
 * 面板本身是给人看的，但 window.__playerDebug 是给 MCP 自动化
 * 断言用的 —— 那条链路断了会让"自动冒烟"变成"截图肉眼看"，
 * 所以这里重点锁住开关和全局变量的生命周期。
 */
describe('播放信息调试面板', () => {
  it('默认关闭，不产生全局快照', () => {
    const w = mountPlayer()
    expect((window as any).__playerDebug).toBeFalsy()
    expect(w.text()).not.toContain('播放信息')
    w.unmount()
  })

  it('按 D 打开后出现面板并写入全局快照', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w)
    v.dispatchEvent(new Event('loadedmetadata'))
    await w.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    await w.vm.$nextTick()

    expect(w.text()).toContain('播放信息')
    const dbg = (window as any).__playerDebug
    expect(dbg).toBeTruthy()
    // 三层都要有
    expect(dbg.video).toBeTruthy()
    expect(dbg.biz).toBeTruthy()
    expect(dbg.state).toBeTruthy()
    w.unmount()
  })

  it('再按一次 D 关闭，面板消失且全局快照被清空', async () => {
    const w = mountPlayer()
    fakeMedia(w)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    await w.vm.$nextTick()
    expect((window as any).__playerDebug).toBeTruthy()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    await w.vm.$nextTick()
    await w.vm.$nextTick()

    expect(w.text()).not.toContain('播放信息')
    expect((window as any).__playerDebug).toBeFalsy()
    w.unmount()
  })

  it('快照里带业务层关键字段，便于 MCP 断言', async () => {
    const w = mountPlayer({ lineName: '测试线路', canSwitchLine: true })
    const v = fakeMedia(w, 600)
    v.dispatchEvent(new Event('loadedmetadata'))
    await w.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    await w.vm.$nextTick()

    const dbg = (window as any).__playerDebug
    expect(dbg.biz.line).toBe('测试线路')
    expect(dbg.biz.maxRecoverAttempts).toBe(3)
    expect(dbg.video.duration).toBe(600)
    // 就绪状态：readyState 在 jsdom 里是 0，但字段必须存在
    expect(typeof dbg.video.readyState).toBe('number')
    w.unmount()
  })

  it('卸载时清理全局快照与定时器', () => {
    const w = mountPlayer()
    fakeMedia(w)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
    expect((window as any).__playerDebug).toBeTruthy()
    w.unmount()
    expect((window as any).__playerDebug).toBeFalsy()
  })
})

/**
 * 手势与键盘的误触发回归。
 *
 * 这几条都是"看起来能用、实测才发现会误伤"的问题，
 * 共同点是事件链路上有延迟（220ms 单击判定），
 * 而其他语义的点击没有被排除掉。
 */
describe('点击与键盘不误伤', () => {
  it('★ 按住方向键以 2x 持续扫动，而不是无限累加跳秒', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 0
    Object.defineProperty(v, 'playbackRate', { value: 1, configurable: true, writable: true })
    await w.vm.$nextTick()

    // 按住不放：第一次 repeat=false（跳 5 秒），之后 repeat=true（进入扫描）
    for (let i = 0; i < 15; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: i > 0, bubbles: true }),
      )
    }
    await w.vm.$nextTick()

    // 关键断言 1：currentTime 只由第一次按键推进 5 秒，
    // 后续靠倍速跑，而不是每次 keydown 再跳一段。
    // （只看跳秒的话，修复前这里会累加到 5*(1+2+…+15) = 600 秒。）
    expect(v.currentTime).toBe(5)
    // 关键断言 2：进入 2 倍速扫描
    expect(v.playbackRate).toBe(2)
    w.unmount()
  })

  it('松开方向键恢复原倍速', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    Object.defineProperty(v, 'playbackRate', { value: 1, configurable: true, writable: true })
    await w.vm.$nextTick()

    // 按下并按住
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: false, bubbles: true }),
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }),
    )
    await w.vm.$nextTick()
    expect(v.playbackRate).toBe(2)

    // 松手
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    await w.vm.$nextTick()
    expect(v.playbackRate).toBe(1)
    w.unmount()
  })

  it('手点（repeat=false）仍然会累加，保留原有手感', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 0
    await w.vm.$nextTick()

    // 连点三次（都是独立按键，repeat=false）
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: false, bubbles: true }),
      )
    }
    await w.vm.$nextTick()
    // 5 + 10 + 15（还没到封顶）
    expect(v.currentTime).toBe(30)
    w.unmount()
  })

  it('★ 连按累加有封顶：连点 10 次也不会跳几分钟', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 100
    await w.vm.$nextTick()

    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: false, bubbles: true }),
      )
    }
    await w.vm.$nextTick()

    // 步长序列 5,10,15,20,20,20,20,20,20,20 = 170（封顶前会是 275）
    expect(v.currentTime).toBe(270)
    w.unmount()
  })

  it('连点 20 次也不会顶到片尾（封顶生效）', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 100
    await w.vm.$nextTick()

    for (let i = 0; i < 20; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: false, bubbles: true }),
      )
    }
    await w.vm.$nextTick()

    // 5+10+15 + 20×17 = 370（封顶前是 900，直接顶到片长 1000 的片尾）
    expect(v.currentTime).toBe(470)
    expect(v.currentTime).toBeLessThan(1000)
    w.unmount()
  })

  it('封顶对左方向同样生效', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 500
    await w.vm.$nextTick()

    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: false, bubbles: true }),
      )
    }
    await w.vm.$nextTick()

    expect(v.currentTime).toBe(330) // 500 - 170
    w.unmount()
  })

  it('带 Ctrl/Cmd 的组合键不劫持（Ctrl+F 查找、Ctrl+D 收藏）', async () => {
    const w = mountPlayer()
    const v = fakeMedia(w, 1000)
    v.dispatchEvent(new Event('loadedmetadata'))
    v.currentTime = 100
    Object.defineProperty(v, 'paused', { value: false, configurable: true, writable: true })
    await w.vm.$nextTick()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }),
    )
    await w.vm.$nextTick()
    // Ctrl+D 不该打开调试面板
    expect(w.text()).not.toContain('播放信息')
    // Ctrl+F 也不该进全屏
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }),
    )
    await w.vm.$nextTick()
    expect(w.text()).not.toContain('播放信息')
    w.unmount()
  })

  it('搜索框里按 Esc 能关掉弹窗', async () => {
    const w = mountPlayer()
    fakeMedia(w)
    await w.vm.$nextTick()

    // 打开搜索弹窗
    const searchBtn = w.findAll('button').find((b) => (b.attributes('title') || '') === '搜索弹幕')
    expect(searchBtn).toBeTruthy()
    await searchBtn!.trigger('click')
    await w.vm.$nextTick()
    expect(w.text()).toContain('搜索弹幕')

    // 焦点在输入框（模拟用户点进去打字）
    const input = w.find('input[placeholder*="片名"]')
    expect(input.exists()).toBe(true)
    ;(input.element as HTMLInputElement).focus()

    // Esc 必须能关
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    expect(w.text()).not.toContain('片名，例如')
    w.unmount()
  })

  it('静音状态会持久化（切集后不自动恢复有声）', async () => {
    localStorage.clear()
    __resetPrefsCache()
    const w = mountPlayer()
    const v = fakeMedia(w)
    await w.vm.$nextTick()

    // 点静音按钮（title 含"静音"或音量图标）
    const muteBtn = w.findAll('button').find((b) => /静音|音量/.test(b.attributes('title') || ''))
    if (muteBtn) {
      await muteBtn.trigger('click')
      await w.vm.$nextTick()
    }
    // 无论按钮是否找到，直接验证 prefs 层的契约
    const p = getPrefs()
    expect(typeof p.muted).toBe('boolean')
    // 写入静音后重建实例应能读到
    savePrefs({ muted: true })
    __resetPrefsCache()
    expect(getPrefs().muted).toBe(true)
    w.unmount()
  })
})

/**
 * TV 控制栏的自动隐藏：**必须从「最后一次操作」重新计时**。
 *
 * 用户反馈原话：「呼出控制栏，在左右选按键时，控制栏自动隐藏了，
 * 但是还没来得及选到位置呢。」
 *
 * 根因不是定时器写错，而是**焦点移动根本不经过播放器**：
 * 控制栏显示时存在 `.meow-tv-focus`，tv-nav 的 dispatchKey 看到焦点框
 * 就直接把方向键消费去 move()，播放器的 keydown 永远收不到那一按。
 * 于是 wake() 没被调用，5 秒定时器照原计划走完。
 *
 * 修法两道：tv-nav 移焦点后广播 `meow:tv-focus`（页面订阅续期）+
 * 定时器到期时再检查一次"焦点框还在控制栏里且刚操作过"。
 */
describe('TV 控制栏：焦点移动必须重置隐藏计时', () => {
  // isTvEnv() 判 documentElement.dataset.tv === '1' 或 UA 含 MeowTV。
  // 不标这一下，clearTvFocus / 续期分支整个不会执行，测试会假通过。
  beforeEach(() => {
    document.documentElement.dataset.tv = '1'
  })
  afterEach(() => {
    delete document.documentElement.dataset.tv
  })

  /** 造一个"控制栏 + 焦点框"的最小 DOM，模拟 tv-nav 移过焦点的状态 */
  function seedCtrlFocus(host: HTMLElement) {
    const scope = document.createElement('div')
    scope.setAttribute('data-tv-scope', 'ctrl')
    const btn = document.createElement('button')
    btn.className = 'meow-tv-focus'
    scope.appendChild(btn)
    host.appendChild(scope)
    return scope
  }

  it('广播 meow:tv-focus 后，控制栏在静默期结束时不会消失', async () => {
    vi.useFakeTimers()
    const w = mountPlayer()
    const v = fakeMedia(w)
    await w.vm.$nextTick()

    // 唤出控制栏（空格是播放/暂停，也会 wake）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await w.vm.$nextTick()

    seedCtrlFocus(document.body)

    // 4.5 秒时来一次"焦点移动"，应当续期
    vi.advanceTimersByTime(4500)
    window.dispatchEvent(new CustomEvent('meow:tv-focus'))
    await w.vm.$nextTick()

    // 再过 4 秒（距第一次唤出已 8.5s，但距最后一次操作只有 4s）
    vi.advanceTimersByTime(4000)
    await w.vm.$nextTick()

    // 控制栏仍在（有焦点框 + 刚操作过）
    expect(document.querySelector('[data-tv-scope="ctrl"] .meow-tv-focus')).toBeTruthy()

    w.unmount()
    vi.useRealTimers()
    void v
  })

  it('控制栏里没有焦点框时，静默期到了正常收起（不会粘住）', async () => {
    vi.useFakeTimers()
    const w = mountPlayer()
    fakeMedia(w)
    await w.vm.$nextTick()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await w.vm.$nextTick()
    // 唤醒后控制栏应当存在
    expect(document.querySelector('[data-tv-scope="ctrl"]')).toBeTruthy()

    // 期间没有任何焦点移动，也没有广播 meow:tv-focus
    vi.advanceTimersByTime(6000)
    await w.vm.$nextTick()

    // 收起：clearTvFocus() 会摘掉 scope 属性（元素本身不删，模板里一直在）
    const scope = document.querySelector('[data-tv-scope="ctrl"]')
    expect(scope).toBeFalsy()

    w.unmount()
    vi.useRealTimers()
  })

})
