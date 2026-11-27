import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 弹幕颜色 + 详情页预取（2026-11-02）。
 *
 * ## 颜色
 * 用户问「抓取的弹幕是没有颜色的是吗」。实测三条链路的真实情况：
 *   · iqiyi 直连  → parseIqiyiBullets 读 colorHex，**保留颜色**
 *   · 腾讯直连    → 原来写死 "16777215"，全站 4 万条全白
 *   · danmu_api   → format=xml 原样透传，上游给白色就是白色
 * 前端解析（parts[3] → #rrggbb）与渲染（makeSprite 按色缓存）本来就没问题，
 * 所以只需要修腾讯那一处。
 *
 * ## 详情页预取
 * 播放页的「下集预取」只覆盖第 2 集往后，**第 1 集永远冷启动**，
 * 而它恰恰最常被点。详情页停留 3–10 秒正好够 danmu_api 跑完。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const API = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
)
const WEB_API = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'api', 'index.ts'),
  'utf8',
)
const DETAIL = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'DetailView.vue'),
  'utf8',
)
const PLAY = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
  'utf8',
)
const DM = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'danmaku.ts'),
  'utf8',
)

function region(src: string, marker: string, len: number): string {
  const i = src.indexOf(marker)
  expect(i, `找不到锚点 ${marker}`).toBeGreaterThan(-1)
  return src.slice(i, i + len)
}

describe('弹幕颜色：抓取层', () => {
  it('腾讯不再写死白色，改为读上游字段', () => {
    const i = API.indexOf('private static String fetchTencentXml')
    expect(i).toBeGreaterThan(-1)
    // 窗口要罩住整个函数：2026-11-27 加了时间轴注释后函数体变长，6000 已经不够
    const body = API.slice(i, i + 12000)
    // 原来的实现是 all.add(new String[]{..., "16777215", ...}) 硬编码
    expect(body).not.toMatch(/all\.add\(new String\[\]\{String\.valueOf\(absMs \/ 1000\),\s*"16777215"/)
    // 现在探测多个可能的字段名
    expect(body).toContain('content_color')
    expect(body).toContain('fontcolor')
    // 且保留白色兜底（上游真不提供时不能变成黑色/透明）
    expect(body).toContain('16777215')
  })

  it('腾讯 time_offset 是整集绝对毫秒，不能再加片起点', () => {
    const i = API.indexOf('private static String fetchTencentXml')
    expect(i).toBeGreaterThan(-1)
    const body = API.slice(i, i + 12000)
    /*
     * 2026-11-27 真 bug：分片 30 秒一片、time_offset 已经是绝对毫秒，
     * 旧代码 `startMs + off` 又加一遍片起点 → 时间轴「满 30 秒 / 空 30 秒」交替，
     * 且一半弹幕被 over-duration 砍掉（庆余年 ep1：54,435 → 27,550）。
     */
    expect(body).toContain('long absMs = offIsAbsolute ? off : startMs + off;')
    expect(body).toContain('final boolean offIsAbsolute = minOff == Long.MAX_VALUE')
    // 判据必须允许跨片重叠（片 330 里的弹幕可能从 310 秒起）
    expect(body).toContain('minOff >= startMs / 2')
  })

  it('颜色值兼容十进制 / #RRGGBB / 六位十六进制', () => {
    const i = API.indexOf('private static String fetchTencentXml')
    const body = API.slice(i, i + 12000)
    expect(body).toContain('startsWith("#")')
    expect(body).toContain('[0-9a-f]{6}')
    // 0（纯黑）在深色背景上等于看不见，必须当缺省
    expect(body).toContain('rgb > 0')
  })

  it('iqiyi 保留颜色的逻辑没被改坏', () => {
    const body = region(API, 'private static void parseIqiyiBullets', 1600)
    expect(body).toContain('colorHex')
    expect(body).toContain('Integer.parseInt(colorHex, 16)')
  })
})

describe('弹幕颜色：解析与渲染', () => {
  it('前端解析读 p 的第 4 段并转 #rrggbb', () => {
    // 扫描解析是主路径；DOMParser 只在畸形 XML 兜底，两处都读 parts[3]
    const body = region(DM, 'function scanDanmakuXml', 1800)
    expect(body).toContain('parts[3]')
    expect(body).toContain('padStart(6')
  })

  it('渲染按 颜色+文本 缓存精灵图（不是所有弹幕共用一个白图）', () => {
    const body = region(DM, 'private makeSprite', 2400)
    // 颜色必须进缓存键，否则不同颜色的同一句话会互相覆盖
    expect(body).toContain('${color}')
    // 渐变也必须进缓存键（同文本不同渐变不能共用位图）
    expect(body).toContain("${gradient?.join(',') || ''}")
    expect(body).toContain('g.fillStyle = color')
  })
})

describe('详情页预取第 1 集', () => {
  it('详情加载完成后触发，且用统一的 prefetchDanmaku', () => {
    expect(DETAIL).toContain('maybePrefetchFirstDanmaku')
    expect(DETAIL).toContain('prefetchDanmaku')
    // 必须在 load() 里被调用，否则永远不会触发
    const i = DETAIL.indexOf('async function load()')
    const body = DETAIL.slice(i, i + 2200)
    expect(body).toContain('maybePrefetchFirstDanmaku')
  })

  it('只取第 1 集（不是整季全抓）', () => {
    const body = region(DETAIL, 'function maybePrefetchFirstDanmaku', 900)
    expect(body).toContain('episodes?.[0]')
  })

  it('看过的片不预取（历史页进详情页不该触发）', () => {
    /*
     * 2026-11-02 用户口径：历史页 → 详情页没必要预取，
     * 正常搜索/首页进详情页才该预取。判据用「这部片有没有观看进度」：
     * 有进度说明用户会点「继续观看」或挑已看过的集，不会点第 1 集。
     */
    const body = region(DETAIL, 'function maybePrefetchFirstDanmaku', 900)
    expect(body).toContain('getProgress')
    expect(body).toContain('return')
  })

  it('预取集中在 api 层，播放页与详情页共用同一个实现', () => {
    expect(WEB_API).toContain('export function prefetchDanmaku')
    const body = region(WEB_API, 'export function prefetchDanmaku', 700)
    expect(body).toContain('POST')
    expect(body).toContain('catch(() => {})')   // 失败静默
    // 播放页不再自己拼 URL
    expect(PLAY).toContain('prefetchDanmaku')
    expect(PLAY).not.toContain('/api/proxy/danmaku/prefetch?name=${')
  })
})
