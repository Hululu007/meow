import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 搜索页「左侧源列表 → 右侧结果卡片」的遥控器右键（2026-11-16 用户报）。
 *
 * 现象：源列表里只有一两个站点按 → 能进结果区（恰好纵向中心与某张卡片对齐的
 * 那几个），其余站点按 → 毫无反应。
 *
 * 根因：tv-nav 的左右键只走「同一行」（rowBest，为了不让首页海报右键跳到上方
 * 分类胶囊）。源列表一项约 33px、结果卡片一张约 104px，两列行高对不齐，
 * 大部分站点在右侧同一行里根本没有候选。
 *
 * 约定：标 `data-tv-col` 后走 tv-nav 的跨列兜底 —— → 落到纵向最近的卡片，
 * ← 从卡片回到最近的站点。这个测试锁住那两个标记，删掉就退回旧行为。
 */
const SEARCH = readFileSync(
  join(__dirname, '..', 'src', 'views', 'SearchView.vue'),
  'utf8',
)

describe('搜索页聚合结果的两栏列标记', () => {
  it('源列表标 left', () => {
    expect(SEARCH).toMatch(/<aside v-if="siteTabs\.length > 1" data-tv-col="left"/)
  })

  it('结果区标 right', () => {
    expect(SEARCH).toMatch(/data-tv-col="right"/)
  })

  it('两个标记都在聚合结果分支里（单站结果没有左右两栏）', () => {
    // 聚合分支从 hits.length 起，到单站结果（list.length）之前
    const start = SEARCH.indexOf('v-else-if="hits.length"')
    const end = SEARCH.indexOf('v-else-if="list.length"')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = SEARCH.slice(start, end)
    expect(block).toContain('data-tv-col="left"')
    expect(block).toContain('data-tv-col="right"')
  })
})
