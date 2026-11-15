/**
 * Web / PC 端的局域网后端扫描（2026-11-15 修5）。
 *
 * TV 有原生 LanScan（Java 线程 + Socket 探测）；浏览器里没有 socket，
 * 只能用 fetch 探 `/api/health`。可行性靠两条事实：
 *   · /api/health 带全放行 CORS（apiserver 与 meowd 都是），跨域读得到 JSON；
 *   · LAN 里"没人监听"的地址会立刻回 ECONNREFUSED，fetch 秒失败，
 *     只有真的没主机的 IP 才会拖到超时——所以整体耗时可控。
 *
 * 网段从哪来：浏览器拿不到本机 IP，只能推断——
 *   ① 当前页面 origin 是局域网 IP → 用它的前三个八位组（最准）
 *   ② 已保存的后端地址是局域网 IP → 同上
 *   ③ 都不是 → 兜底扫最常见的两个家用网段（与 TV 的 LanScan 兜底一致）
 *
 * https 页面里 fetch http 地址会被混合内容策略直接拦掉，
 * 调用方应按 scanLanBackends 的 httpsBlocked 提示用户换 http 访问。
 */

export interface LanHit {
  /** 后端基地址，如 http://192.168.1.10:30010 */
  url: string
  version: string
  sites: number
}

export interface ScanResult {
  hits: LanHit[]
  /** 扫过的候选总数（用于"没找到"时说明覆盖面） */
  probed: number
  /** true = 页面是 https，浏览器会拦掉所有 http 探测，结果必为空 */
  httpsBlocked: boolean
}

/** 探测端口：30010 = Docker 默认，9979 = PC 插件直连默认 */
const PORTS = [30010, 9979]
/** 无命中时的兜底网段（与 TV LanScan 的兜底口径一致，只取最常见两条控制耗时） */
const FALLBACK_SUBNETS = ['192.168.1', '192.168.0']
/** 单个探测的超时：LAN 上正常的 health 响应 <100ms，超出即视为无服务 */
const PROBE_TIMEOUT_MS = 1200
/** 并发上限：一次发 32 个 fetch，/24 两端口 ≈ 8~20 秒 */
const CONCURRENCY = 32

function isLanIp(host: string): boolean {
  return /^(192\.168|10(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2})\.\d{1,3}$/.test(host)
}

function subnetOf(host: string): string | null {
  if (!isLanIp(host)) return null
  const parts = host.split('.')
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

/** 推断候选网段：origin → 已保存后端 → 兜底；去重保序 */
export function lanSubnets(): string[] {
  const out: string[] = []
  const push = (s: string | null) => {
    if (s && !out.includes(s)) out.push(s)
  }
  try {
    push(subnetOf(location.hostname))
  } catch {
    /* file:// 等特殊 origin 忽略 */
  }
  try {
    const saved = localStorage.getItem('meow.api') || ''
    if (saved) push(subnetOf(new URL(saved).hostname))
  } catch {
    /* localStorage 不可用忽略 */
  }
  for (const s of FALLBACK_SUBNETS) push(s)
  return out
}

async function probe(base: string): Promise<LanHit | null> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(`${base}/api/health`, { signal: ctrl.signal, cache: 'no-store' })
    if (!r.ok) return null
    const j = (await r.json()) as { ok?: boolean; version?: string; sites?: number }
    if (!j || j.ok !== true) return null
    return { url: base, version: j.version || '', sites: Number(j.sites) || 0 }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 有界并发的 map：始终保持 concurrency 个在飞 */
async function pooled<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 扫描局域网里的 meow 后端。
 *
 * 优先扫推断出的网段；一个网段扫完有命中就停（家用环境不会两段都部署）。
 */
export async function scanLanBackends(): Promise<ScanResult> {
  const httpsBlocked = location.protocol === 'https:'
  if (httpsBlocked) return { hits: [], probed: 0, httpsBlocked }
  const subnets = lanSubnets()
  let probed = 0
  const hits: LanHit[] = []
  for (const subnet of subnets) {
    const targets: string[] = []
    for (let i = 1; i <= 254; i++) {
      const ip = `${subnet}.${i}`
      // 本机自身跳过：127.0.0.1 场景由"同源"承担，扫自己没有意义
      if (ip === location.hostname) continue
      for (const port of PORTS) targets.push(`http://${ip}:${port}`)
    }
    probed += targets.length
    const results = await pooled(targets, probe)
    for (const h of results) if (h) hits.push(h)
    if (hits.length) break
  }
  // 同一后端可能同时开 30010 与 9979：只留每台主机的第一个命中
  const seen = new Set<string>()
  const uniq = hits.filter((h) => {
    const host = new URL(h.url).host
    if (seen.has(host)) return false
    seen.add(host)
    return true
  })
  return { hits: uniq, probed, httpsBlocked }
}
