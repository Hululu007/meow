import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 播放页/直播页的窗口装饰（2026-11-20 用户报）：
 *  1. 播放页拖不动窗口 —— 顶部只有 2px 拖拽条，且标题区没绑定拖拽；
 *  2. 红绿灯在右上角，要求挪到左上角返回按钮左侧。
 */
const LAYOUT = join(__dirname, '..', 'src', 'components', 'layout')
const chrome = readFileSync(join(LAYOUT, 'DesktopTopChrome.vue'), 'utf8')
const player = readFileSync(
  join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)

describe('播放页窗口装饰', () => {
  it('红绿灯在左上角，不再固定右上角', () => {
    expect(chrome).toContain('fixed left-2 top-2')
    expect(chrome).not.toContain('fixed right-2 top-2')
  })

  it('顶部拖拽条至少 10px，不是原来的 2px', () => {
    expect(chrome).toContain('h-2.5')
    expect(chrome).not.toContain('fixed inset-x-0 top-0 z-[199] h-2"')
  })

  it('播放页标题栏给左上角红绿灯让位', () => {
    expect(player).toContain("isDesktopShell() ? 'pl-24'")
  })

  it('标题区能拖拽窗口 / 双击最大化', () => {
    expect(player).toContain('@pointerdown="beginWindowDrag"')
    expect(player).toContain('@dblclick="toggleMaximizeOnDblClick"')
    expect(player).toContain("from '@/composables/useWindowDrag'")
  })
})
