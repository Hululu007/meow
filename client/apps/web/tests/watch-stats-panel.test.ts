import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 观看统计面板（2026-10-30 用户需求）。
 *
 * 用户原话：「历史页面的，统计卡片样式不太友好（时长保留的情况下，
 * 额外单独统计按钮，打开统计面板）。是否可以参考学习 zcode 的统计图」。
 *
 * 这几条锁的都是"改坏了会静默出错"的地方 —— 图表算错不会报错，
 * 只是画出来不对，单靠 typecheck 和肉眼很难发现。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const STATS = join(REPO, 'client', 'apps', 'web', 'src', 'stores', 'watchStats.ts')
const PANEL = join(
  REPO, 'client', 'apps', 'web', 'src', 'components', 'common', 'WatchStatsPanel.vue',
)
const VIEW = join(REPO, 'client', 'apps', 'web', 'src', 'views', 'HistoryView.vue')

describe('统计汇总：连续天数与峰值', () => {
  const src = readFileSync(STATS, 'utf8')

  it('今天没看时，连续天数从昨天往前算（否则一进页面就显示 0）', () => {
    // 判据：如果今天没有记录，就把起点退一天再数
    expect(src).toContain('if (!set.has(todayKey(d))) d.setDate(d.getDate() - 1)')
  })

  it('日均只按"有记录的天"平均（挂机少的空白日不该拉低）', () => {
    expect(src).toContain('avgPerActiveDay')
    expect(src).toMatch(/active\.length \? Math\.round\(monthly \/ active\.length\) : 0/)
  })

  it('峰值取单日最高时长，而不是总时长', () => {
    expect(src).toContain('for (const x of active) if (x.seconds > peak.seconds) peak = { ...x }')
  })
})

describe('统计面板：图表实现', () => {
  const src = readFileSync(PANEL, 'utf8')

  it('不引图表库（品牌一致的纯 SVG）', () => {
    // 现有柱状图就是"纯 div，不引图表库"，保持同一策略
    expect(src).not.toMatch(/from ['"]echarts|from ['"]chart\.js|from ['"]d3/)
    expect(src).toContain('<svg')
  })

  it('颜色走 CSS 变量，四套主题自动跟随', () => {
    // 写死颜色的话换肤后图表和整体不搭（焦点框踩过同类问题）
    expect(src).toContain('var(--color-accent)')
    expect(src).toContain('var(--color-line)')
  })

  it('面板要 Teleport 到 body（否则被顶栏盖住）', () => {
    // 站内 main 有 relative z-10 层叠上下文，不跳出去 z 再大也压不过顶栏
    expect(src).toContain('<Teleport to="body">')
    expect(src).toContain('</Teleport>')
  })

  it('有 data-tv-scope + data-tv-scroll（遥控器要能进、能滚）', () => {
    expect(src).toContain('data-tv-scope')
    expect(src).toContain('data-tv-scroll')
  })

  it('关闭后把焦点还给触发按钮', () => {
    const view = readFileSync(VIEW, 'utf8')
    expect(view).toContain('data-tv-key="history-stats"')
    expect(view).toContain('__meowTvScopeClosed')
  })
})

describe('2026-10-30 第三轮：卡片瘦身 + 弹框滚动', () => {
  const VIEW = readFileSync(
    join(REPO, 'client', 'apps', 'web', 'src', 'views', 'HistoryView.vue'), 'utf8',
  )
  const NAV = readFileSync(
    join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'), 'utf8',
  )

  it('卡片里不再有近 7 天柱状图（零数据时是纯噪音）', () => {
    /*
     * 用户原话「图片红框内容去除」：那里原本一排柱子 + 7 个日期。
     * 零数据时柱子高度全 0，只剩光秃秃的日期标签，占掉右半边却无信息。
     * 逐日曲线在弹框的趋势图里（30 天带面积）信息量大得多。
     */
    expect(VIEW, '卡片里还留着柱状图').not.toContain('barHeight(')
    expect(VIEW, '卡片里还留着日期标签函数').not.toContain('function shortDate(')
    expect(VIEW).toBeTruthy()
  })

  it('有历史没时长时也要显示入口（不能整卡消失）', () => {
    // 踩过：条件原来只有 stats.total > 0，清过统计后入口一起没了
    expect(VIEW).toMatch(/v-if="stats\.total > 0 \|\| items\.length > 0"/)
  })

  it('滚动步长是半屏，不是 0.7 屏', () => {
    /*
     * 0.7 屏时容器 490px、一次滚 343px，而内容只有 791px ——
     * 按一次下键直接到底，中间图表一闪而过。
     */
    const at = NAV.indexOf('function scrollStep(')
    expect(at).toBeGreaterThan(-1)
    const body = NAV.slice(at, at + 900)
    expect(body, '步长仍是 0.7 屏').toContain('* 0.5')
    expect(body, '还留着 0.7').not.toContain('* 0.7')
  })

  it('上下键优先命中滚动停靠点（否则滚到底回不去内容区）', () => {
    /*
     * 面板里 4 个候选：「返回」/ 内容容器（894×490）/「去找片」/「关闭」。
     * 从「去找片」按上键时几何上「返回」会赢，上键永远回不到内容区。
     */
    const at = NAV.indexOf('var score = primary + secondary * 2')
    expect(at).toBeGreaterThan(-1)
    const block = NAV.slice(at, at + 900)
    expect(block, '滚动停靠点没加权').toContain("hasAttribute('data-tv-scroll')")
    expect(block, '加权系数缺失').toMatch(/score \*= 0\.6/)
  })

  it('滚动容器的焦点框只画左竖条（不圈住整块）', () => {
    // 894×490 的容器被 3px 框圈住，看起来像"选中一大片"
    expect(NAV).toContain("[data-tv-scroll].meow-tv-focus")
    expect(NAV).toMatch(/inset 3px 0 0 0 var\(--color-accent/)
  })
})

describe('历史页：卡片保留数字 + 独立统计入口', () => {
  const src = readFileSync(VIEW, 'utf8')

  it('卡片仍显示 4 个关键数字（时长保留）', () => {
    for (const k of ['今天', '近 7 天', '总计', '有记录']) {
      expect(src, `卡片缺「${k}」`).toContain(k)
    }
  })

  it('有独立的统计面板入口', () => {
    expect(src).toContain('WatchStatsPanel')
    // 入口走 openStats()（它负责把内部滚动归零），不要直接翻 flag
    expect(src).toContain('openStats()')
    const fnAt = src.indexOf('async function openStats()')
    expect(fnAt, '没有 openStats').toBeGreaterThan(-1)
    expect(src.slice(fnAt, fnAt + 500), '打开时没重置滚动').toContain('scrollTop = 0')
  })

  it('refreshStats 定义在 siteBreakdown 之后（否则落进 TDZ）', () => {
    // 两者都是 const/function 混用，顺序错了会在挂载瞬间抛 ReferenceError
    const fnAt = src.indexOf('function refreshStats()')
    const depAt = src.indexOf('function siteBreakdown()')
    expect(fnAt).toBeGreaterThan(-1)
    expect(depAt).toBeGreaterThan(-1)
    expect(fnAt, 'refreshStats 定义在 siteBreakdown 之前 → TDZ').toBeGreaterThan(depAt)
  })
})
