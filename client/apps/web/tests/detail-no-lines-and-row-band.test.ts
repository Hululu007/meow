import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-11-05 两条：
 *
 * 1. **详情有、线路为空要有出路**：豆瓣原生源 `vod_play_from` 恒空，
 *    每张海报点进来都是死路（「立即播放」灰着、只有一句"暂无播放源"）。
 *    现在给一个「在其它源搜索」按钮，并把它当 TV 落点 —— 播放按钮此时是
 *    disabled，tv-nav 会跳过它，不挪 data-tv-first 焦点就落到「返回」上。
 *
 * 2. **横向同行判据收紧**：原判据"垂直区间有交集 + 8px 容差"在字体放大后
 *    会让上方分类胶囊蹭进第一行海报的容差带，右键跳到胶囊。改成"候选中心
 *    落在当前元素的纵向带内"。
 */
const WEB = join(__dirname, '..')
const REPO = join(WEB, '..', '..', '..')
const DETAIL = readFileSync(join(WEB, 'src', 'views', 'DetailView.vue'), 'utf8')
const NAV = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)

/** 去掉注释，避免断言命中注释里的示例代码 */
function codeOnly(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const DETAIL_CODE = codeOnly(DETAIL)

describe('详情页：线路为空时的出口', () => {
  it('片名优先取详情里的 vod_name，其次路由 name', () => {
    const i = DETAIL_CODE.indexOf('const searchTitle')
    expect(i).toBeGreaterThan(-1)
    const body = DETAIL_CODE.slice(i, i + 300)
    expect(body).toContain('item.value?.vod_name')
    expect(body).toContain('route.query.name')
  })

  it('跳搜索页带 wd（SearchView 会 watch wd 自动开搜）', () => {
    const i = DETAIL_CODE.indexOf('function searchOtherSources')
    expect(i).toBeGreaterThan(-1)
    const body = DETAIL_CODE.slice(i, i + 400)
    expect(body).toContain("router.push({ name: 'search', query: { wd: t } })")
    // 有内容的一页用 push（返回能回详情），只有空详情那条才 replace
    expect(body).not.toContain('router.replace')
  })

  it('空线路区块有按钮，且是 TV 落点', () => {
    const i = DETAIL_CODE.indexOf('v-else-if="error"')
    expect(i).toBeGreaterThan(-1)
    const body = DETAIL_CODE.slice(i, i + 900)
    expect(body).toContain('searchOtherSources')
    expect(body).toContain('在其它源搜索')
    expect(body).toContain('data-tv-first')
  })

  it('播放按钮的 data-tv-first 随线路有无切换（disabled 时让位给搜索按钮）', () => {
    // 两个播放按钮都改成条件绑定
    const marks = DETAIL_CODE.match(/:data-tv-first="lines\.length \? '' : undefined"/g) || []
    expect(marks.length).toBe(2)
    // 不能再有裸的 data-tv-first 挂在播放按钮上（会和搜索按钮抢落点）
    const playBlocks = DETAIL_CODE.split('data-tv-first').length - 1
    expect(playBlocks).toBe(3) // 两个条件绑定 + 搜索按钮一个
  })
})

describe('tv-nav：横向只认同一行（中心点判据）', () => {
  it('候选中心落在当前纵向带内才算同行', () => {
    const i = NAV.indexOf('function scanImpl')
    const end = NAV.indexOf('function scrollStep', i)
    const body = NAV.slice(i, end)
    expect(body).toContain('var bandLo = a.top - 8')
    expect(body).toContain('var candCy = b.top + b.height / 2')
    expect(body).toMatch(/candCy >= bandLo && candCy <= bandHi/)
    // 旧的"区间有交集"判据不能回来
    expect(body).not.toMatch(/b\.top < a\.bottom \+ 8 && b\.bottom > a\.top - 8/)
  })

  it('横向仍不回退全量 best', () => {
    const i = NAV.indexOf('function scanImpl')
    const end = NAV.indexOf('function scrollStep', i)
    const body = NAV.slice(i, end)
    expect(body).toMatch(/return rowBest \|\| \(rowFree \? freeBest : null\)/)
  })
})
