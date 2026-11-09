import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 详情页左右两栏的上下键隔离（2026-11-04 用户报）。
 *
 * 现象：简介展开后「收起简介」的 y 落在集数第 3 行上，从 14 按 ↑
 * 纵向只差 1px（真正的上一行差 56px）→ 几何算法必然选它，焦点跳左栏。
 *
 * 约定：页面用 `data-tv-col` 标列；tv-nav 上下键只在同列竞争，
 * 列里到头才允许去"不属于任何列"的元素（返回/顶栏），**不回另一列**。
 * 左右键不受影响，边界处仍可跨列。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const TV_NAV = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)
const DETAIL = readFileSync(
  join(__dirname, '..', 'src', 'views', 'DetailView.vue'),
  'utf8',
)

describe('tv-nav 列隔离', () => {
  it('有 colOf，按最近的 data-tv-col 取值，无标记返回空串', () => {
    expect(TV_NAV).toMatch(/function colOf\(el\)/)
    expect(TV_NAV).toContain("el.closest('[data-tv-col]')")
    expect(TV_NAV).toMatch(/return host \? \(host\.getAttribute\('data-tv-col'\) \|\| '1'\) : ''/)
  })

  it('find() 支持列过滤，且只过滤"同列"或"无列"', () => {
    expect(TV_NAV).toMatch(/function find\(dir, includePinned, colMode\)/)
    expect(TV_NAV).toContain("colMode === 'same' ? colOf(from) : ''")
    expect(TV_NAV).toContain('colOf(x) === wantCol')
  })

  it('上下键走"同列 → 无列（顶栏/返回）"，不回到另一列', () => {
    expect(TV_NAV).toContain("find(dir, false, 'same')")
    expect(TV_NAV).toContain("find(dir, true, 'loose')")
    // 只有焦点不在列里时才走老的全局兜底
    expect(TV_NAV).toMatch(/if \(!el && \(dir === 'up' \|\| dir === 'down'\)\) el = find\(dir, true\)/)
  })

  it('左右键不带 colMode（边界仍可跨列）', () => {
    expect(TV_NAV).toMatch(/var curCol = isVertical \? colOf/)
    // find(dir, false) 的横向调用仍然存在
    // 行尾用 \r?\n：仓库 blob 是 LF，但 Windows（core.autocrlf=true）
    // checkout 出来是 CRLF，只写 \n 会在本地红、CI 绿（踩过）
    expect(TV_NAV).toMatch(/el = find\(dir, false\)\r?\n/)
  })
})

describe('选集分段', () => {
  it('确认胶囊后滚回顶部并把焦点交给该段首集', () => {
    expect(DETAIL).toMatch(/async function selectEpPage\(p: number\)/)
    expect(DETAIL).toContain('box.scrollTop = 0')
    expect(DETAIL).toContain('__meowTvFocus')
    // 胶囊必须走这个入口，不能再直接写 epPage
    expect(DETAIL).toContain('@click="selectEpPage(p - 1)"')
    expect(DETAIL).not.toContain('@click="epPage = p - 1"')
  })

  it('有列隔离时不再用滚动区隔离（否则 101 ↑ 跳过胶囊直达顶栏）', () => {
    expect(TV_NAV).toMatch(/if \(colMode\) regionMode = null/)
  })

  it('左右键行内到头时，允许跨到另一列（101 ← 能到左栏按钮）', () => {
    expect(TV_NAV).toMatch(/if \(!got && !vertical\)/)
    expect(TV_NAV).toContain('c !== myCol')
    expect(TV_NAV).toMatch(/scan\(otherCol, from, dir, skipPinned, regionMode, true\)/)
    // 跨行只在 rowFree 时有备选；默认仍只认同行
    expect(TV_NAV).toMatch(/return rowBest \|\| \(rowFree \? freeBest : null\)/)
  })
})

describe('详情页标记与焦点框留白', () => {
  it('左右两栏各自标 data-tv-col', () => {
    expect(DETAIL).toContain('data-tv-col="left"')
    expect(DETAIL).toContain('data-tv-col="right"')
  })

  it('选集滚动区四周留出焦点框的空间（左/下不再被裁）', () => {
    // overflow 容器会裁掉 box-shadow；必须有内边距，且用负 margin 抵回对齐
    expect(DETAIL).toMatch(/mt-3 -mx-2 max-h-\[52vh\] overflow-y-auto px-2 pb-2 pt-1/)
  })

  it('选集容器不能是焦点停靠点（否则上下键先落到空容器）', () => {
    /*
     * 2026-11-04 用户报：第 1 集按下键，焦点先落到选集区容器上
     * （画一根左竖条），再按才到第 3 行 —— 因为该容器矩形包住所有
     * 集数按钮，primary=0 且带 0.6 折扣，几何上必赢。
     * 滚动交给 scrollIntoViewWithin，不需要它可聚焦。
     */
    const start = DETAIL.indexOf('max-h-[52vh] overflow-y-auto')
    expect(start).toBeGreaterThan(-1)
    const tag = DETAIL.slice(start, DETAIL.indexOf('>', start))
    expect(tag).not.toContain('data-tv-scroll')
    expect(tag).not.toContain('tabindex')
  })
})
