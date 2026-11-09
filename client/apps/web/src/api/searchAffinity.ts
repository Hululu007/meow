/**
 * 把"源偏好"喂给排序层（2026-11-03）。
 *
 * <p>数据来自两处，都不是新采集的：
 *   · `stores/history` —— 用户真实播过的源（localStorage，现成的）
 *   · `/api/health/state` —— 后端已有的源健康明细（现成的）
 *
 * <p>**为什么不放在 searchRank.ts 里直接读**：那个文件要能纯函数单测
 * （不碰 localStorage / fetch）。这里只负责取数和兜底，一行排序逻辑都没有。
 *
 * <p>取不到就返回空 Map —— 排序退化成"只看片名相关性"，
 * 不能因为历史为空或后端没响应就让搜索报错。
 */

import { fetchHealthState } from './health'
import { listHistory } from '@/stores/history'
import { buildSiteAffinity, type AffinityHealth } from './searchRank'

let cachedAt = 0
let cached: Map<string, number> | null = null
/** 缓存 60 秒：一次搜索里所有卡片共用同一份，不必每个关键词都重算 */
const TTL_MS = 60_000

/**
 * 取源偏好（带 60 秒缓存）。
 *
 * <p>缓存的意义：搜索页与 AI 面板每轮都可能调用，而 health 是一个 HTTP 请求。
 * 60 秒内用户看的是同一批数据，多打几次没有信息增量。
 */
export async function siteAffinity(): Promise<Map<string, number>> {
  const now = Date.now()
  if (cached && now - cachedAt < TTL_MS) return cached
  let health: Record<string, AffinityHealth> | null = null
  try {
    const h = await fetchHealthState()
    const out: Record<string, AffinityHealth> = {}
    for (const [k, v] of Object.entries(h.sites || {})) {
      out[k] = {
        degraded: !!v.degraded,
        disabled: !!v.disabled,
        unsupported: !!v.unsupported,
        lastCount: Number(v.lastCount) || 0,
        lastCostMs: Number(v.lastCostMs) || 0,
      }
    }
    health = out
  } catch {
    // 后端不可达：只用观看历史排序，不至于整个搜索失败
  }
  cached = buildSiteAffinity({ history: listHistory(), health, now })
  cachedAt = now
  return cached
}

/** 仅供测试：清掉缓存 */
export function __resetSiteAffinity(): void {
  cached = null
  cachedAt = 0
}
