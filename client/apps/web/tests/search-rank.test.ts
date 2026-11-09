import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SearchGroup } from '../src/api/types'

/**
 * 聚合结果的排序（2026-11-02 用户报「AI 面板搜出来是哔哩评析，不是正经剧」）。
 *
 * 实测依据（TV / 44 源 / `我不是大师` / refresh:true，共 53 条）：
 *   0       正剧（荐片）
 *   1-17    我不是女巫 / 我不是龙套 / 我不是酒神 …（荐片一次吐 18 条）
 *   18-24   正剧（金牌 / 干饭）
 *   25-41   哔哩 17 条解说 / 预告 / 合集
 *   42-52   正剧（优奇客 / 瓜子 / 闪电优汐 / 潮流 / 蔬菜 / 咕噜 / 骚火 / 360）
 *
 * 后端分组顺序 = 源返回顺序，AI 面板只取前 6 条，于是"搜正剧出来一堆解说"。
 */

type Spec = { n: string; r?: string; sites?: string[] }

function g(spec: Spec): SearchGroup {
  const sites = spec.sites || ['AppRJ']
  return {
    vod_name: spec.n,
    vod_pic: '',
    vod_remarks: spec.r,
    sources: sites.map((site, i) => ({ site, vod_id: 'v' + i })),
  }
}

/** 按实测顺序构造的一组结果（保留污染特征，条目做了裁剪） */
const WD = '我不是大师'
const POLLUTED: SearchGroup[] = [
  g({ n: '我不是大师', r: '第24集', sites: ['Jianpian'] }),
  g({ n: '大师', r: 'BD中英双字幕', sites: ['Jianpian'] }),
  g({ n: '我不是女巫', r: 'BD中英双字', sites: ['Jianpian'] }),
  g({ n: '我不是龙套', r: 'HD国语中字', sites: ['Jianpian'] }),
  g({ n: '我不是酒神', r: 'HD国语中字', sites: ['Jianpian'] }),
  g({ n: '我不是龙王', r: '第80集', sites: ['Jianpian'] }),
  g({ n: '我不是大师', r: '(24全)', sites: ['Jpys'] }),
  g({ n: '我不是大师', r: '24集全', sites: ['AppDrama2'] }),
  g({ n: '一口气6小时看完民国江湖骗局《我不是大师》八场骗局每一分钟都在反转，爆肝十五天狂写十万字！', r: '391分鐘', sites: ['Bili'] }),
  g({ n: '2026《我不是大师》第1-24集 已更 超清！~', r: '78分鐘', sites: ['Bili'] }),
  g({ n: '专治骗子，局中有局！民国骗术江湖《我不是大师》到底好不好看？包含；剧情、细节、历史科普、骗术拆解等', r: '38分鐘', sites: ['Bili'] }),
  g({ n: '我不是大师 直播 李现 李一桐', r: '128分鐘', sites: ['Bili'] }),
  g({ n: '我不是大师', r: '已完结', sites: ['AppYQK'] }),
  g({ n: '我不是大师', r: '全24集', sites: ['Gz360'] }),
  g({ n: '我不是大师解说', r: '评分:8.0', sites: ['Gz360'] }),
  g({ n: '我不是大师', r: '更新至第18集', sites: ['Duopan'] }),
  g({ n: '我不是大师', r: '更新至第24集', sites: ['AppRJ'] }),
  g({ n: '我不是大师', r: '24集全', sites: ['AppGet'] }),
  g({ n: '我不是大师原著时代背景解读', r: '6期全', sites: ['Gulu'] }),
  g({ n: '我不是大师原著深度解读', r: '5期全', sites: ['Gulu'] }),
  g({ n: '我不是大师', r: '24集全', sites: ['Gulu'] }),
  g({ n: '我不是大师', r: '电视剧', sites: ['SP360'] }),
]

const { rankGroups, scoreGroup, normTitle, buildSiteAffinity } = await import('../src/api/searchRank')

const names = (list: SearchGroup[]) => list.map((x) => x.vod_name)

describe('排序：正剧在前，解说/花絮在后', () => {
  const ranked = rankGroups(POLLUTED, WD)

  it('前 6 条全部是《我不是大师》本体（来自 6 个不同影视源）', () => {
    expect(names(ranked).slice(0, 6).every((n) => n === '我不是大师')).toBe(true)
    const srcs = ranked.slice(0, 6).map((x) => x.sources[0].site)
    expect(new Set(srcs).size).toBe(6)
    for (const s of srcs) expect(['Jianpian', 'Jpys', 'AppDrama2', 'AppYQK', 'Gz360', 'Duopan', 'AppRJ', 'AppGet', 'Gulu', 'SP360']).toContain(s)
  })

  it('哔哩的解说/预告全部排在任何一条不相关剧之后', () => {
    const idxBili = ranked
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => x.sources[0].site === 'Bili')
      .map(({ i }) => i)
    const idxNearMiss = ranked
      .map((x, i) => ({ n: x.vod_name, i }))
      .filter(({ n }) => n === '我不是酒神' || n === '我不是龙王' || n === '我不是女巫')
      .map(({ i }) => i)
    expect(Math.min(...idxBili)).toBeGreaterThan(Math.max(...idxNearMiss))
  })

  it('带"解说/解读"的标题排在正剧之后（即使以关键词开头）', () => {
    const idxReal = ranked.findIndex((x) => x.vod_name === '我不是大师' && x.vod_remarks === '更新至第24集')
    const idxJieshuo = ranked.findIndex((x) => x.vod_name === '我不是大师解说')
    const idxJiedu = ranked.findIndex((x) => x.vod_name === '我不是大师原著深度解读')
    expect(idxJieshuo).toBeGreaterThan(idxReal)
    expect(idxJiedu).toBeGreaterThan(idxReal)
  })

  it('完全同名 > 前缀同名的另一部剧 > 只是包含关键词的长标题', () => {
    const s = (n: string) => {
      const found = POLLUTED.find((x) => x.vod_name === n)!
      return scoreGroup(found, WD)
    }
    expect(s('我不是大师')).toBeGreaterThan(s('我不是酒神'))
    expect(s('我不是酒神')).toBeGreaterThan(s('2026《我不是大师》第1-24集 已更 超清！~'))
  })

  it('时长型备注（"391分鐘"）会被扣分', () => {
    const long = g({ n: '我不是大师', r: '391分鐘' })
    const ep = g({ n: '我不是大师', r: '24集全' })
    expect(scoreGroup(long, WD)).toBeLessThan(scoreGroup(ep, WD))
  })
})

describe('排序的稳定性与边界', () => {
  it('同分保持原顺序（不在轮次之间漂移）', () => {
    const a = [g({ n: '我不是大师', r: '第1集', sites: ['A'] }), g({ n: '我不是大师', r: '第2集', sites: ['B'] })]
    expect(rankGroups(a, WD).map((x) => x.sources[0].site)).toEqual(['A', 'B'])
    expect(rankGroups([...a].reverse(), WD).map((x) => x.sources[0].site)).toEqual(['B', 'A'])
  })

  it('关键词为空/全是标点时原样返回，不崩', () => {
    expect(rankGroups(POLLUTED, '').length).toBe(POLLUTED.length)
    expect(rankGroups(POLLUTED, '《》').length).toBe(POLLUTED.length)
  })

  it('归一化去掉书名号/空格/大小写', () => {
    expect(normTitle('《我不是大师》 第一季')).toBe(normTitle('我不是大师第一季'))
    expect(normTitle('The  Last of Us')).toBe('thelastofus')
  })
})

describe('meowSearch 必须"先排序再截断"', () => {
  const TOOLS = readFileSync(join(__dirname, '..', 'src', 'ai', 'tools.ts'), 'utf8')

  it('rankGroups 出现在 slice 之前', () => {
    // ★ 这就是用户看到"AI 面板前 6 条是哔哩评析"的根因：直接 slice 拿的是
    //   后端"源返回顺序"的前 N 条。
    const rankAt = TOOLS.indexOf('rankGroups(r.groups')
    const sliceAt = TOOLS.indexOf('ranked.slice(0, limit)')
    expect(rankAt).toBeGreaterThan(0)
    expect(sliceAt).toBeGreaterThan(rankAt)
  })
})

describe('搜索页：只在收尾时重排 + 收尾后不显示进度', () => {
  const VIEW = readFileSync(join(__dirname, '..', 'src', 'views', 'SearchView.vue'), 'utf8')
  const code = VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('渐进过程保持插入顺序，done 时才 rankGroups', () => {
    // 边收边排会让卡片在眼前跳（TV 上把焦点带跑）。
    expect(code).toMatch(/groups\.value = groupsNow/)
    expect(code).toMatch(/if \(snapshot\.done\) \{[\s\S]{0,900}rankGroups\(groupsNow, k/)
  })

  it('进度条收尾后不再显示（命中缓存时后端会给 returned=0/total=2）', () => {
    expect(code).toMatch(/!searchFinal && searchProgress\.total/)
    expect(code).toMatch(/searchFinal\.value = true/)
  })
})

describe('源偏好只作为同分次序（2026-11-03 用户提问）', () => {
  it('同分时，看过/健康度高的源排前面', () => {
    const a = g({ n: '我不是大师', r: '全24集', sites: ['AppRJ'] })
    const b = g({ n: '我不是大师', r: '全24集', sites: ['Xlys'] })
    const aff = buildSiteAffinity({ history: [{ site: 'AppRJ', pos: 100, dur: 2000, at: Date.now() }] })
    expect(rankGroups([b, a], WD, aff)[0].sources[0].site).toBe('AppRJ')
  })

  it('偏好翻不过"正剧 vs 解说"的判断', () => {
    // 解说/花絮即使来自最爱的源，也必须排在正剧之后
    const real = g({ n: '我不是大师', r: '全24集', sites: ['Xlys'] })
    const ugc = g({ n: '我不是大师解说', r: '评分:8.0', sites: ['AppRJ'] })
    const aff = buildSiteAffinity({
      history: Array.from({ length: 20 }, () => ({ site: 'AppRJ', pos: 100, dur: 2000, at: Date.now() })),
    })
    expect(rankGroups([ugc, real], WD, aff)[0].vod_name).toBe('我不是大师')
  })

  it('偏好再高也翻不过"完全同名 > 只是包含关键词"', () => {
    const exact = g({ n: '我不是大师', sites: ['Xlys'] })
    const near = g({ n: '我不是酒神', sites: ['AppRJ'] })
    const aff = buildSiteAffinity({
      history: Array.from({ length: 20 }, () => ({ site: 'AppRJ', pos: 100, dur: 2000, at: Date.now() })),
    })
    expect(rankGroups([near, exact], WD, aff)[0].vod_name).toBe('我不是大师')
  })

  it('权重上限 ±80（不参与正片判定，只破同分）', () => {
    const many = buildSiteAffinity({
      history: Array.from({ length: 50 }, () => ({ site: 'AppRJ', pos: 100, dur: 2000, at: Date.now() })),
      health: { AppRJ: { lastCount: 20, lastCostMs: 0 } },
    })
    const one = g({ n: '我不是大师', sites: ['AppRJ'] })
    const other = g({ n: '我不是大师', sites: ['Xlys'] })
    expect(scoreGroup(one, WD, many) - scoreGroup(other, WD, many)).toBeLessThanOrEqual(80)
  })

  it('只点开过详情（pos=0）的源权重低于真播过的', () => {
    const opened = buildSiteAffinity({ history: [{ site: 'A', pos: 0, dur: 0 }] })
    const played = buildSiteAffinity({ history: [{ site: 'A', pos: 60, dur: 2400 }] })
    expect((opened.get('A') || 0)).toBeLessThan(played.get('A') || 0)
  })

  it('降级/停用的源被压到后面', () => {
    const aff = buildSiteAffinity({
      history: [],
      health: { Bad: { degraded: true, lastCount: 0, lastCostMs: 9000 } },
    })
    expect(aff.get('Bad') || 0).toBeLessThan(0)
  })
})
