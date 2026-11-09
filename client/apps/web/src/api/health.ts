import { request } from './index'

/**
 * 源健康度：探活 / 手动降权 / 明细。
 *
 * 判定收敛在后端 `isSiteSkipped()`（ApiServer.java:1054），搜索、直播、探活
 * 三处共用同一套。前端只负责展示与开关，不要在本文件里再算一遍
 * "连续失败几次算坏"——那会把判定变成两套（实测踩过：手动禁用后某个入口还在打它）。
 *
 * 写入类端点在后端设了 authToken 时会要求 X-Meow-Token，
 * `request()` 已经统一带上，这里不要绕开它自己 fetch。
 */

/** 单站健康明细（`GET /api/health/state` 的 sites[site]） */
export interface SiteHealthDetail {
  /** 累计成功次数 */
  ok: number
  /** 累计失败次数 */
  fail: number
  /** 连续失败次数；任意一次成功会清零 */
  streak: number
  /**
   * 源站反复失败（连续失败 ≥3 次）。
   *
   * 只用于展示与排序，**不再触发跳过**——搜索对所有源都会发起请求。
   */
  degraded: boolean
  /** 手动禁用（无时间窗，只有用户自己恢复才解除） */
  disabled: boolean
  /**
   * 环境不支持：配置缺失 / JS 运行时没接。
   *
   * 这类源会被聚合跳过，但它**不是故障**——实测 270 站里 229 个属于此类
   * （drpy 脚本源需要 Node 运行时）。与 degraded 分开统计，
   * 否则"229 个降级"看起来像全线崩溃。
   */
  unsupported: boolean
  /** unsupported 的具体原因，给设置页展开显示 */
  unsupportedReason: string
  /** 最近一次搜索返回的条目数 */
  lastCount: number
  /** 最近一次成功调用的耗时（毫秒） */
  lastCostMs: number
  lastError: string
  lastOkAt: number
  lastFailAt: number
}

export interface HealthState {
  /** 源站反复失败的站 key（展示用，不跳过） */
  degraded: string[]
  /** 手动停用的站 key */
  disabled: string[]
  /** 环境不支持的站 key（配置缺失 / 运行时没接，会被聚合跳过） */
  unsupported: string[]
  sites: Record<string, SiteHealthDetail>
}

export interface ProbeResult {
  site: string
  ok: boolean
  /** 单站耗时（毫秒） */
  ms: number
  /** 失败原因；ok 时为空串。后端已剥掉 FutureTask/InvocationTarget 外壳 */
  error: string
}

export async function fetchHealthState(): Promise<HealthState> {
  return request<HealthState>('/api/health/state')
}

/**
 * 主动探活。
 *
 * 省略 sites = 探整张站点表（后端 24 并发 + 单站 8 秒超时）。
 * 270 个源最坏要 90 秒，所以超时给到 3 分钟而不是默认 60 秒。
 */
export async function probeSites(sites?: string[]): Promise<{
  ok: boolean
  probed: number
  results: ProbeResult[]
}> {
  return request('/api/health/probe', {
    method: 'POST',
    body: sites && sites.length ? { sites } : {},
    timeout: 180_000,
  })
}

/**
 * 手动停用 / 恢复。
 *
 * `disabled=false` 会同时清零 streak 与 degraded，语义是"立刻再试一次"，
 * 而不是"解除锁定后再等 30 分钟窗口过去"。
 * 未知站点会进 unknown 且不写库（拼错的 key 不会被当成配置存下来）。
 */
export async function setSitesDisabled(
  sites: string[],
  disabled: boolean,
): Promise<{ ok: boolean; disabled: boolean; updated: string[]; unknown: string[]; state: HealthState }> {
  return request('/api/health/degrade', {
    method: 'POST',
    body: { sites, disabled },
  })
}

/**
 * 重置全部源健康记录（清掉跳过/降档/降级标记）。
 *
 * 为什么需要：失效剔除和超时拉黑的 TTL 是 10 分钟，期间即使源站修好了
 * 也看不到效果。有这个按钮就不用重启后端。
 *
 * 只清 `site-health.json`，不动 `config.sites.json`（手动停用状态在那边）。
 */
export async function resetHealth(): Promise<{ ok: boolean }> {
  return request('/api/health/reset', { method: 'POST' })
}
