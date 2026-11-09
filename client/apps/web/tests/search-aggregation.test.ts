import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 聚合搜索的收尾策略（2026-10-29 实测后改）。
 *
 * 用户报的现象是"同一个关键词搜两次，结果不一样"。逐站量出来的数据是：
 *
 *   Jpys   0.2s → 0.1s → 0.1s            （快源）
 *   AppGet 0.1s → 0.1s → 0.1s
 *   Gz360 17.9s → 0.8s → 0.8s            （首轮冷启动：DNS + TLS 建连）
 *   SaoHuo 32.5s → 0.7s → 1.7s           （同上，更极端）
 *
 * 老逻辑只有"有结果后静默 2.5 秒就收尾"一条，于是快源在 0.6 秒全部回来、
 * 2.5 秒后立刻收尾 —— 首轮要 17.9 秒的源永远赶不上。实测 6 轮里
 * Gz360 只出现 1 次、SP360 4 次。
 *
 * 修法：收尾要三条同时成立（有结果 / 跑满最小等待 / 多数站已返回），
 * 且最小等待按"该站表里已知最慢源的历史耗时"自适应，上限 10 秒。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')
const HEALTH = join(ROOT, 'server', 'host', 'src', 'shared', 'routes', 'HealthRoutes.java')

function src(): string {
  return readFileSync(API, 'utf8')
}

describe('聚合搜索收尾策略', () => {
  it('空闲收尾必须有"最小等待"门槛', () => {
    const s = src()
    // 只有 idle 一条时，快源一回来就收尾，慢源被随机截掉（抖动的来源）
    expect(s, '缺 SEARCH_MIN_MS').toContain('SEARCH_MIN_MS')
    const i = s.indexOf('boolean longEnough')
    expect(i, '找不到 longEnough 判据').toBeGreaterThan(-1)
    expect(s.slice(i, i + 200)).toContain('searchStart')
  })

  it('只用"已返回比例"也不够，必须与最小等待同时成立', () => {
    // 比例门槛会被"超时/异常的空返回"快速满足（那些也算完成），
    // 所以它只能和 longEnough 取或，不能单独决定收尾。
    const s = src()
    expect(s).toContain('mostReturned')
    const i = s.indexOf('longEnough || mostReturned')
    expect(i, '两个门槛没有一起参与判断').toBeGreaterThan(-1)
  })

  it('等待预算按站点历史耗时自适应，且有上限', () => {
    const s = src()
    expect(s, '没有读站点历史耗时').toContain('HealthRoutes.lastCost')
    const i = s.indexOf('waitBudget =')
    expect(i, '找不到 waitBudget 计算').toBeGreaterThan(-1)
    // 上限必须是硬编码常量：无上限时会被 17.9s/32.5s 的极端值拖到用户无法接受
    expect(s.slice(i, i + 160), '等待预算没有上限').toMatch(/Math\.min\(\s*10_000L/)
  })

  it('站点历史耗时只在成功时更新，且要能查到', () => {
    const h = readFileSync(HEALTH, 'utf8')
    expect(h, '没记 lastCostMs').toContain('lastCostMs')
    expect(h, '没有查询接口').toContain('public static long lastCost')
    // 失败不能写入耗时：一个源连不上时耗时是 0/超时值，写进去会把预算拉歪。
    // 实现是 "if (success) { ...; return; }" 的早返回结构，成功才落到 lastCostMs。
    const i = h.indexOf('public static void record(String site, boolean success, String error, long costMs)')
    expect(i).toBeGreaterThan(-1)
    const body = h.slice(i, i + 900)
    const okBranch = body.indexOf('if (success) {')
    const costWrite = body.indexOf('lastCostMs = costMs')
    expect(okBranch, '没有成功分支').toBeGreaterThan(-1)
    expect(costWrite, '耗时没写进 lastCostMs').toBeGreaterThan(-1)
    expect(costWrite, '耗时写入在成功分支之外（失败也会写）').toBeGreaterThan(okBranch)
  })

  it('总超时仍要保留（不能为了让慢源进来就无限等）', () => {
    const s = src()
    expect(s).toContain('SEARCH_TOTAL_TIMEOUT_MS')
    expect(s, '没有用总 deadline 兜底').toContain('searchDeadline')
  })
})

/**
 * 搜索失败日志必须能定位到站点与真实原因。
 *
 * 踩过：原来只记 `t.toString()`，得到的是 `java.lang.reflect.InvocationTargetException`,
 * 既不知道哪个源、也不知道为什么。TV 上几十条一模一样的记录等于没记 ——
 * 也正是这一条缺失，让"设备时钟错→签名类源静默失败"这个问题拖了整轮才查清。
 */
describe('搜索失败日志', () => {
  const s = src()

  it('要带站点名和最内层 cause', () => {
    expect(s, '没有 unwrap').toContain('private static Throwable unwrap')
    const i = s.indexOf('2-arg failed')
    expect(i).toBeGreaterThan(-1)
    expect(s.slice(i, i + 300), '没带站点名').toContain('site')
  })

  it('unwrap 要能剥 InvocationTargetException', () => {
    const i = s.indexOf('private static Throwable unwrap')
    const body = s.slice(i, i + 500)
    expect(body).toContain('InvocationTargetException')
  })
})

/**
 * `/api/health` 必须给出服务器时间。
 *
 * 一批源（Jpys/Gulu/Gz360/MiSou 等）在请求里用 `System.currentTimeMillis()`
 * 做签名或协议时间戳，服务端会拒掉偏差过大的请求，表现是**搜索静默返回空**。
 * 客户端要能自己算出"我跟后端差多少"，才能把这条讲清楚。
 */
describe('健康检查时钟字段', () => {
  it('/api/health 带 now 字段', () => {
    const s = src()
    expect(s).toContain('o.put("now"')
  })
})
