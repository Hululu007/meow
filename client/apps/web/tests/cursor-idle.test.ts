/**
 * 全屏播放空闲隐藏光标（2026-11-12）。
 *
 * 三端都反馈"全屏时鼠标不会延迟消失"：Web 没有这层逻辑；PC 的 CSS
 * cursor:none 在 WebView2 全屏合成里不一定生效；TV 是系统指针图标。
 * 这里锁住共用逻辑与三端接线。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createIdleCursor } from '../src/components/player/idleCursor'

afterEach(() => {
  vi.useRealTimers()
})

describe('createIdleCursor', () => {
  it('全屏 + 指针空闲 3s 后隐藏，移动立即恢复', () => {
    vi.useFakeTimers()
    const calls: boolean[] = []
    const c = createIdleCursor({
      isFullscreen: () => true,
      canHide: () => true,
      apply: (h) => calls.push(h),
    })
    c.activity()
    expect(c.isHidden()).toBe(false)
    vi.advanceTimersByTime(2999)
    expect(c.isHidden()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(c.isHidden()).toBe(true)
    c.activity()
    expect(c.isHidden()).toBe(false)
    expect(calls).toEqual([true, false])
  })

  it('非全屏永远不隐藏（也不残留定时器）', () => {
    vi.useFakeTimers()
    const calls: boolean[] = []
    const c = createIdleCursor({
      isFullscreen: () => false,
      canHide: () => true,
      apply: (h) => calls.push(h),
    })
    c.activity()
    vi.advanceTimersByTime(10_000)
    expect(c.isHidden()).toBe(false)
    expect(calls).toEqual([])
  })

  it('触摸/电视环境（canHide=false）不隐藏', () => {
    vi.useFakeTimers()
    const c = createIdleCursor({
      isFullscreen: () => true,
      canHide: () => false,
      apply: () => {},
    })
    c.activity()
    vi.advanceTimersByTime(10_000)
    expect(c.isHidden()).toBe(false)
  })

  it('stop（退出全屏/卸载）恢复光标并取消计时', () => {
    vi.useFakeTimers()
    const calls: boolean[] = []
    const c = createIdleCursor({
      isFullscreen: () => true,
      canHide: () => true,
      apply: (h) => calls.push(h),
    })
    c.activity()
    vi.advanceTimersByTime(3000)
    expect(c.isHidden()).toBe(true)
    c.stop()
    expect(c.isHidden()).toBe(false)
    expect(calls).toEqual([true, false])
    vi.advanceTimersByTime(10_000)
    expect(c.isHidden()).toBe(false)
  })

  it('隐藏状态下继续移动只补一次恢复（不重复调 apply）', () => {
    vi.useFakeTimers()
    const calls: boolean[] = []
    const c = createIdleCursor({
      isFullscreen: () => true,
      canHide: () => true,
      apply: (h) => calls.push(h),
    })
    c.activity()
    vi.advanceTimersByTime(3000)
    c.activity()
    c.activity()
    expect(calls).toEqual([true, false])
  })
})

describe('三端接线', () => {
  const SRC = join(__dirname, '..', 'src')
  const ROOT = join(__dirname, '..', '..', '..', '..')
  const player = readFileSync(join(SRC, 'components', 'player', 'VideoPlayer.vue'), 'utf8')
  const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8')

  it('Web/PC：播放器挂 pointer 活动、全屏切换、CSS class 与 Tauri 原生调用', () => {
    expect(player).toContain('createIdleCursor({')
    expect(player).toContain('@pointermove.passive="noteCursorActivity"')
    expect(player).toContain('@pointerdown.passive="noteCursorActivity"')
    expect(player).toContain("watch([fullscreen, pseudoFs]")
    expect(player).toContain("'desktop_set_cursor_visible'")
    expect(tokens).toContain('html.meow-cursor-none')
  })

  it('PC 原生命令存在且注册', () => {
    const lib = readFileSync(join(ROOT, 'client', 'apps', 'desktop', 'src-tauri', 'src', 'lib.rs'), 'utf8')
    expect(lib).toContain('fn desktop_set_cursor_visible')
    expect(lib).toContain('set_cursor_visible(visible)')
    expect(lib).toContain('desktop_set_cursor_visible,')
  })

  it('TV：WebView 指针图标设为 NULL（CSS 在部分 WebView 管不到系统指针）', () => {
    const act = readFileSync(
      join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'MainActivity.java'),
      'utf8',
    )
    expect(act).toContain('PointerIcon.TYPE_NULL')
    expect(act).toContain('PointerIcon.TYPE_DEFAULT')
    expect(act).toContain('installPointerAutoHide()')
    expect(act).toContain('postDelayed(hidePointerIcon, 3000)')
  })
})
