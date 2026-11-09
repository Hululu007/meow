import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 滚动停靠点审计（2026-11-04）。
 *
 * 规矩只有一条：**容器里有可聚焦元素时，容器自己不能标 `data-tv-scroll`**。
 * 容器的矩形包住所有子元素，几何上 primary=0（+0.6 折扣），上下键会先落到
 * 容器上（画一根左竖条），再按一次才进内容 —— 用户看到的就是"按一下没反应"。
 *
 * 文本型滚动区（日志、更新说明、统计面板）没有可聚焦子元素，标了才对：
 * 那时它是唯一的滚动入口。
 *
 * 本轮修掉的三处：
 *   · 详情页选集容器（101 集 ↓ 落到空容器）
 *   · 设置页「连接设置」弹层（设备按钮 ↓ 落到容器）
 *   · 播放器「搜索弹幕」结果列表、AI 面板消息列表
 */
const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

/** 取某个标记所在元素的起始标签（到第一个 '>'） */
function openTagAround(src: string, needle: string): string {
  const i = src.indexOf(needle)
  if (i < 0) return ''
  const start = src.lastIndexOf('<', i)
  const end = src.indexOf('>', i)
  return start >= 0 && end > start ? src.slice(start, end + 1) : ''
}

describe('滚动停靠点不能抢子元素的焦点', () => {
  it('详情页选集容器不可聚焦（回归）', () => {
    const tag = openTagAround(read('views/DetailView.vue'), 'max-h-[52vh] overflow-y-auto')
    expect(tag).not.toContain('data-tv-scroll')
    expect(tag).not.toContain('tabindex')
  })

  it('设置页「连接设置」弹层内容区不可聚焦', () => {
    const tag = openTagAround(
      read('views/SettingsView.vue'),
      'min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5 outline-none',
    )
    expect(tag).not.toContain('data-tv-scroll')
    expect(tag).not.toContain('tabindex')
  })

  it('播放器弹幕搜索结果列表不可聚焦，且留了焦点框空间', () => {
    const tag = openTagAround(read('components/player/VideoPlayer.vue'), 'ref="dmListEl"')
    expect(tag).not.toContain('data-tv-scroll')
    expect(tag).not.toContain('tabindex')
    // overflow 容器会裁 box-shadow：必须有内边距
    expect(tag).toMatch(/-mx-2/)
    expect(tag).toMatch(/px-2/)
  })

  it('AI 面板消息列表不可聚焦', () => {
    const tag = openTagAround(read('components/ai/AiPanel.vue'), 'ref="listEl"')
    expect(tag).not.toContain('data-tv-scroll')
    expect(tag).not.toContain('tabindex')
  })

  it('纯文本滚动区仍然保留停靠点（否则遥控器滚不动）', () => {
    // 这三处没有可聚焦子元素，必须自己当停靠点
    expect(read('views/LogsView.vue')).toContain('data-tv-scroll')
    expect(read('components/common/UpdateDialog.vue')).toContain('data-tv-scroll')
    expect(read('components/common/WatchStatsPanel.vue')).toContain('data-tv-scroll')
  })
})
