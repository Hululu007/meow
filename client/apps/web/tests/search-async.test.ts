import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 异步搜索（后台任务 + 轮询快照），2026-10-29 实现。
 *
 * 起因：`POST /api/search` 原来在**请求线程**里跑完整个聚合（2~20 秒），
 * 而请求线程池只有 12 个（`POOL`）。实测 12 个并发搜索就把池占满，
 * `/api/health` 的延迟从毫秒级涨到 **9.1 秒** —— 用户看到的是"整个应用卡死"。
 *
 * 改成"启动任务（立刻返回 taskId）+ 轮询快照（毫秒级）"之后：
 *   · 同样 12 个并发搜索，health 仍然是 0.02 秒
 *   · 前端能边出边显示（实测 0.78 秒就看到 8 条结果）
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')
const VIEW = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SearchView.vue')

describe('异步搜索后端', () => {
  const a = readFileSync(API, 'utf8')

  it('搜索任务跑在后台池，不占请求线程', () => {
    // 关键：必须 FANOUT.execute(...) 而不是在 handle() 里同步 searchAll
    expect(a, '没有 startSearchTask').toContain('private static String startSearchTask')
    const i = a.indexOf('private static String startSearchTask')
    // 编排线程必须独立于搜索池：跑在 FANOUT 上会「池中任务等同池任务」而饥饿
    // （实测极米 Z6X Pro 连续两次全量搜索后网关不响应，见 startSearchTask 注释）
    expect(a.slice(i, i + 1600), '任务没丢到独立编排池').toContain('SEARCH_ORCH.execute')
  })

  it('任务有 TTL，避免内存泄漏', () => {
    // 现行实现是「最少保留时长 + 最多保留个数」两条，不是一个 TTL 常量
    expect(a, '没有最少保留时长').toContain('SEARCH_TASK_MIN_TTL_MS')
    expect(a, '没有保留个数上限').toContain('SEARCH_TASK_MAX_KEPT')
    expect(a, '没有清理函数').toContain('pruneSearchTasks')
    // 启动新任务时要顺手清理
    const i = a.indexOf('private static String startSearchTask')
    expect(a.slice(i, i + 300), '建任务时没清理过期任务').toContain('pruneSearchTasks()')
  })

  it('轮询端点必须在 /api/{site}/{action} 兜底之前', () => {
    // 否则会被当成 site="search"、action="<taskId>" 去调站点类
    const taskRoute = a.indexOf('"/api/search/task/"')
    expect(taskRoute, '缺少轮询路由').toBeGreaterThan(-1)
    // 兜底是 `if (path.startsWith("/api/"))` 后按段拆
    const fallback = a.indexOf('if (path.startsWith("/api/")) {')
    expect(fallback, '找不到兜底路由').toBeGreaterThan(-1)
    expect(taskRoute, '轮询路由在兜底之后，永远走不到').toBeLessThan(fallback)
  })

  it('写 merged 要加锁（轮询会并发读）', () => {
    // 锚点避开 '\0'（TS 源码里会变成真控制字符，匹配不上）
    const i = a.indexOf('JSONObject entry = merged.get(key)')
    expect(i).toBeGreaterThan(-1)
    // 加锁语句紧挨在 merged.get 之前
    expect(a.slice(Math.max(0, i - 300), i), 'merged 写入没加锁').toContain('synchronized (merged)')
  })

  it('同步接口保持可用（老客户端/自动化脚本）', () => {
    // 不带 async 时仍走 searchAll(body)，不能改成只支持异步
    expect(a).toContain('sendJson(ex, 200, searchAll(body))')
  })
})

describe('异步搜索前端', () => {
  const v = readFileSync(VIEW, 'utf8')

  it('用轮询而不是等最终结果', () => {
    expect(v, '没调 startSearch').toContain('startSearch(')
    expect(v, '没调 fetchSearchSnapshot').toContain('fetchSearchSnapshot(')
    expect(v, '没有轮询周期常量').toContain('SEARCH_POLL_MS')
  })

  it('轮询周期不能太长（否则错过边出边看）', () => {
    // 首批结果 0.3~1.0 秒就回来；3 秒轮询等于白做
    const m = v.match(/const SEARCH_POLL_MS = (\d[\d_]*)/)
    expect(m, '找不到轮询周期').toBeTruthy()
    const ms = Number(m![1].replace(/_/g, ''))
    expect(ms, '轮询周期太长，首批结果会被错过').toBeLessThanOrEqual(1000)
    expect(ms, '轮询太频繁（TV 上请求量翻倍）').toBeGreaterThanOrEqual(300)
  })

  it('拿到第一批结果就收起加载态', () => {
    // 否则用户看到"搜索中…"直到全部完成，等于没做逐步显示
    const i = v.indexOf('const groupsNow')
    expect(i).toBeGreaterThan(-1)
    /*
     * 取到收尾分支为止，而不是固定 300 字符窗口。
     * 踩过（2026-11-04）：往这段里加了两行（noiseFiltered/noiseDowngraded）
     * 就把 `loading.value = false` 挤出了窗口 —— 断言失败但代码是对的，
     * 属于测试写法脆弱而不是功能坏了。
     */
    const end = v.indexOf('if (snapshot.done)', i)
    const seg = v.slice(i, end > i ? end : i + 600)
    expect(seg, '有结果时没收起 loading').toContain('loading.value = false')
  })

  it('用 runSeq 防旧响应覆盖新搜索', () => {
    expect(v).toContain('runSeq')
  })
})

/**
 * 本轮补齐的四处（1/2/3/5/8 号）。
 */
describe('搜索链路的收尾问题', () => {
  const API = readFileSync(join(__dirname, '..', '..', '..', '..', 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')
  const HR = readFileSync(join(__dirname, '..', '..', '..', '..', 'server', 'host', 'src', 'shared', 'routes', 'HealthRoutes.java'), 'utf8')
  const VIEW = readFileSync(join(__dirname, '..', 'src', 'views', 'SearchView.vue'), 'utf8')
  const TOOLS = readFileSync(join(__dirname, '..', 'src', 'ai', 'tools.ts'), 'utf8')

  it('unsupported 不跨进程保留', () => {
    /*
     * 它表达的是"上次这个运行环境不支持"。重启往往正是因为改了配置/换了 jar，
     * 把旧标记带回来会让修好的源继续被跳过 —— 实测 PC 插件用错 classpath
     * 启动后 237 个源被标 unsupported，修好重启后标记还在。
     */
    const i = HR.indexOf('public static synchronized void load()')
    expect(i).toBeGreaterThan(-1)
    expect(HR.slice(i, i + 2500), 'load() 没清 unsupported').toMatch(/h\.unsupported = false/)
  })

  it('搜索任务失败时给可读提示，不误报成"没搜到"', () => {
    expect(VIEW, '没读 snapshot.error').toContain('snapshot.error')
    expect(VIEW, '任务出错时没有单独提示').toMatch(/搜索失败|搜索任务出错/)
  })

  it('轮询失败会重试，不立刻整页报错', () => {
    expect(VIEW, '没有轮询失败计数').toContain('pollFailures')
  })

  it('AI 工具层走异步，不占请求线程', () => {
    expect(TOOLS, '还在用同步 fetchSearchAll').not.toContain('fetchSearchAll(')
    expect(TOOLS, '没换异步等待版').toContain('fetchSearchAllWait')
  })

  it('慢且空的源被单独标记（不降级）', () => {
    expect(HR, '缺 slowEmpty 字段').toContain('slowEmpty')
    // 判据：0 条 且 耗时 ≥5s
    const i = HR.indexOf('h.slowEmpty = ')
    expect(i).toBeGreaterThan(-1)
    const body = HR.slice(i, i + 120)
    expect(body, 'slowEmpty 判据不对').toContain('count == 0')
    expect(body, 'slowEmpty 没有耗时门槛').toContain('5_000L')
    /*
     * 排序降权：**不单独扣**，由 lastEmpty + lastCostMs 覆盖。
     *
     * 断言改成"要么单独扣、要么显式说明为何不扣"，锁的是"这个决定被
     * 想过、写在代码里"，而不是某个具体写法。之前写死
     * `/if (h.slowEmpty) s -=/`，代码按"重复罚两遍会失真"改成不扣，
     * 测试就红了——但代码是对的。
     */
    const noDoublePenalty = /slowEmpty[\s\S]{0,160}不再单独扣/.test(HR)
    const doesPenalize = /if \(h\.slowEmpty\) s -=/.test(HR)
    expect(
      doesPenalize || noDoublePenalty,
      'slowEmpty 既没参与排序降权，也没说明为什么不单独扣',
    ).toBe(true)
  })

  it('同步搜索路径保持可用', () => {
    // 不带 async 时仍走 searchAll(body)：老客户端、自动化脚本都靠它
    expect(API).toContain('sendJson(ex, 200, searchAll(body))')
  })

  it('前端显示"已搜 N/M 个源"', () => {
    expect(VIEW).toContain('searchProgress')
    expect(VIEW, '没显示已返回源数').toMatch(/returned.*total|个源已返回|个源/)
  })
})
