import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 源健康分类（2026-10-29 实测后重构）。
 *
 * 起因：`/api/health` 报 "270 站 / 244 降级"。实测查清这 244 个里
 * 222 个是 drpy 源（`jsRuntime 未配置`，TV 上没接 Node 运行时）、
 * 19 个是 `ext` 为空或指向不存在的相对路径。它们在任何环境都不会成功，
 * 被当成"源站故障"累计 streak，于是那个数字看起来像全线崩溃。
 *
 * 更要紧的是 30 分钟失活窗口的逻辑矛盾：降级期间源不参与搜索，
 * 就不可能"任意一次成功立即复亮"——唯一恢复路径是用户手动点探活。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const HEALTH = join(ROOT, 'server', 'host', 'src', 'shared', 'routes', 'HealthRoutes.java')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')

function health(): string {
  return readFileSync(HEALTH, 'utf8')
}

describe('源健康分类', () => {
  it('有 unsupported 状态，且它在 skip 判断里', () => {
    const h = health()
    expect(h, '缺 unsupported 字段').toContain('public volatile boolean unsupported')
    const i = h.indexOf('public static boolean isSkipped')
    expect(i).toBeGreaterThan(-1)
    expect(h.slice(i, i + 400), 'unsupported 没参与跳过判断').toContain('unsupported')
  })

  it('环境性失败不进 fail 计数（否则会污染降级统计）', () => {
    const h = health()
    // classify 要把 jsRuntime / ClassNotFound / ext 为空归到 UNSUPPORTED
    const i = h.indexOf('public static Kind classify')
    expect(i).toBeGreaterThan(-1)
    const body = h.slice(i, i + 900)
    expect(body, '没识别 jsRuntime 未配置').toContain('jsRuntime 未配置')
    expect(body, '没识别 ClassNotFoundException').toContain('ClassNotFoundException')
    // record 里 UNSUPPORTED 必须早于普通失败分支返回
    const r = h.indexOf('Kind kind = classify(error)')
    expect(r).toBeGreaterThan(-1)
    expect(h.slice(r, r + 400), 'UNSUPPORTED 没单独返回').toContain('if (kind == Kind.UNSUPPORTED)')
  })

  it('degraded 不再触发跳过（30 分钟窗口已删）', () => {
    const h = health()
    const i = h.indexOf('public static boolean isSkipped')
    const body = h.slice(i, i + 500)
    // 只允许 disabled 与 unsupported 两种跳过
    expect(body, 'degraded 又回到跳过判据里了').not.toMatch(/return\s+h\.degraded/)
    expect(body, 'degraded 又回到跳过判据里了').not.toMatch(/DEGRADE_SKIP_WINDOW/)
  })

  it('健康分只排序不过滤', () => {
    const h = health()
    expect(h, '缺 score()').toContain('public static double score')
    expect(h, '缺 sortByScore').toContain('public static java.util.List<String> sortByScore')
    // 搜聚合里调用排序，但不能拿它过滤
    const a = readFileSync(API, 'utf8')
    expect(a, '搜索没按健康分排序').toContain('HealthRoutes.sortByScore')
    expect(a, '排序结果被当过滤用了').not.toMatch(/targets\s*=\s*routes\.HealthRoutes\.sortByScore[\s\S]{0,80}if\s*\(targets\.isEmpty/)
  })

  it('/api/health 把 unsupported 与 degraded 分开报', () => {
    const h = health()
    const i = h.indexOf('putSummary')
    expect(i).toBeGreaterThan(-1)
    const body = h.slice(i, i + 900)
    expect(body).toContain('unsupportedCount')
    expect(body).toContain('degradedCount')
    // ApiServer 必须走 putSummary，不能自己再拼一遍 degraded
    const a = readFileSync(API, 'utf8')
    expect(a, 'health 没走 putSummary').toContain('HealthRoutes.putSummary')
  })
})

describe('聚合搜索收尾', () => {
  it('全部源已返回时立刻结束，不等空闲窗口', () => {
    // 踩过：18 个快源最慢 0.9s 全部返回，聚合却稳定 4.2~5.0s ——
    // 因为循环还会再进一次，poll 白白等满 3.5s 的 idle 窗口。
    const a = readFileSync(API, 'utf8')
    const i = a.indexOf('if (returned >= totalTargets) break;')
    expect(i, '缺"全部返回即退出"的判据').toBeGreaterThan(-1)
  })

  it('聚合并发有界，且拒绝时不阻塞聚合主线程', () => {
    const a = readFileSync(API, 'utf8')
    /*
     * ★ 判据改成"并发被显式限住"，不再钉具体常量名。
     *
     * 原来钉 `FANOUT_MAX_THREADS`，但实现已改为两条更细的约束：
     *   · 搜索：固定大小 ThreadPoolExecutor + Runtime.maxMemory() 反推 effThreads
     *   · 探活：cached 池 + Semaphore(24) 闸门
     * 钉常量名会让重构必然红。这里改为验"限流的语义"：线程数封顶
     * （固定池或信号量闸门），而不是任其涨到源数量。
     */
    expect(a, '搜索池没封顶（既无固定池也无信号量闸门）').toMatch(
      /new\s+java\.util\.concurrent\.ThreadPoolExecutor|new\s+Semaphore\(/,
    )
    expect(a, '搜索并发没按堆大小压（小内存设备必 OOM）').toContain(
      'Runtime.getRuntime().maxMemory()',
    )
    // CallerRuns 会让被拒任务回到聚合线程上同步跑，等于取消并发限流
    expect(a, '用了 CallerRuns（会阻塞主线程）').not.toContain('CallerRunsPolicy')
    expect(a, '没处理拒绝').toContain('RejectedExecutionException')
  })
})
