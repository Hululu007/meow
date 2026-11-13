/**
 * GitHub 加速：全局候选列表 + 候选生成。
 *
 * <p>只做「公开 GitHub 地址」的候选；私有仓带 token 的请求由调用方短路。
 * 纯函数，不读 Prefs —— 调用方把 `getPrefs().gitAccel` 传进来，便于单测。
 *
 * <p>实测（2026-11-09）：
 *  - raw / gh-proxy / ghproxy.net / jsDelivr 对 raw 文件和 19.6MB 包都返回 206；
 *  - 公开 api.github.com 只有 gh-proxy 稳定（ghfast 超时、ghproxy.net 403）；
 *  - gh.llkk.cc 已从"最快"变成超时，所以默认停用；
 *  - jsDelivr 单文件上限 20MB，1.1.5 的 fpk 19.6MB 可下，1.1.7 的 21.7MB 不可。
 */

export type GitAccelUseForKey = 'appUpdate' | 'pluginSource' | 'fpk' | 'configImport'

export interface GitProxy {
  id: string
  name: string
  /** 前缀（`https://ghfast.top/`）或模板（`https://example.com/{url}`） */
  prefix: string
  enabled: boolean
  builtin: boolean
  note?: string
}

export interface GitAccelUseFor {
  appUpdate: boolean
  pluginSource: boolean
  fpk: boolean
  configImport: boolean
}

export interface GitAccelPrefs {
  enabled: boolean
  /** 先试直连（失败再走列表）。关掉则直连放最后。 */
  directFirst: boolean
  proxies: GitProxy[]
  useFor: GitAccelUseFor
}

const PRESETS: GitProxy[] = [
  {
    id: 'gh-proxy',
    name: 'gh-proxy.com',
    prefix: 'https://gh-proxy.com/',
    enabled: true,
    builtin: true,
    note: '支持 raw 与公开 api.github.com',
  },
  {
    id: 'ghfast',
    name: 'ghfast.top',
    prefix: 'https://ghfast.top/',
    enabled: true,
    builtin: true,
    note: '通常最快，但可用性会漂移',
  },
  {
    id: 'ghproxy-net',
    name: 'ghproxy.net',
    prefix: 'https://ghproxy.net/',
    enabled: true,
    builtin: true,
    note: 'raw 可用；不支持公开 API',
  },
  {
    id: 'gh-llkk',
    name: 'gh.llkk.cc',
    prefix: 'https://gh.llkk.cc/',
    enabled: false,
    builtin: true,
    note: '历史最快；2026-11-09 实测 12s 超时',
  },
  {
    id: 'jsdelivr',
    name: 'jsDelivr（仅索引 / <20MB）',
    prefix: 'https://cdn.jsdelivr.net/gh/',
    enabled: true,
    builtin: true,
    note: '只对 raw.githubusercontent.com 生效',
  },
]

export const DEFAULT_GIT_ACCEL: GitAccelPrefs = {
  enabled: true,
  directFirst: true,
  proxies: PRESETS.map((p) => ({ ...p })),
  useFor: { appUpdate: true, pluginSource: true, fpk: true, configImport: true },
}

function clonePrefs(p: GitAccelPrefs): GitAccelPrefs {
  return {
    enabled: !!p.enabled,
    directFirst: !!p.directFirst,
    proxies: p.proxies.map((x) => ({ ...x })),
    useFor: { ...p.useFor },
  }
}

/** 前缀规范化：纯前缀没有尾斜杠时补一个；模板原样。非法返回空串。 */
export function normalizeProxyPrefix(input: string): string {
  const v = String(input || '').trim()
  if (!v || /\s/.test(v)) return ''
  if (!/^https:\/\//i.test(v)) return ''
  if (v.includes('{url}')) return v
  return v.endsWith('/') ? v : v + '/'
}

function validProxy(p: unknown): p is GitProxy {
  if (!p || typeof p !== 'object') return false
  const o = p as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.prefix === 'string'
}

/**
 * 合并用户数据与内置预设：
 *  - 内置项永远存在（可停用、不可删）；
 *  - 自定义项保留；非法/重复（规范化后）丢弃；
 *  - 缺失的 useFor 默认 true。
 */
export function normalizeGitAccel(raw: unknown): GitAccelPrefs {
  const out = clonePrefs(DEFAULT_GIT_ACCEL)
  if (!raw || typeof raw !== 'object') return out
  const o = raw as Record<string, unknown>
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.directFirst === 'boolean') out.directFirst = o.directFirst
  if (o.useFor && typeof o.useFor === 'object') {
    const u = o.useFor as Record<string, unknown>
    for (const k of Object.keys(out.useFor) as (keyof GitAccelUseFor)[]) {
      if (typeof u[k] === 'boolean') out.useFor[k] = u[k] as boolean
    }
  }

  const list = Array.isArray(o.proxies) ? o.proxies.filter(validProxy) : []
  const byId = new Map(list.map((p) => [p.id, p]))
  const merged: GitProxy[] = []
  const seen = new Set<string>()

  // 内置项：以预设顺序为主，保留用户的 enabled
  for (const preset of out.proxies) {
    const hit = byId.get(preset.id)
    // 坏前缀（http://、空格）回落到预设值，而不是把内置项整个丢掉
    const prefix =
      normalizeProxyPrefix(hit?.prefix || '') || normalizeProxyPrefix(preset.prefix)
    if (!prefix) continue
    const item: GitProxy = {
      ...preset,
      enabled: hit ? !!hit.enabled : preset.enabled,
      prefix,
    }
    const key = prefix.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }

  // 自定义项：保持用户顺序，追加在内置项之后
  for (const p of list) {
    if (p.builtin || out.proxies.some((x) => x.id === p.id)) continue
    const prefix = normalizeProxyPrefix(p.prefix)
    if (!prefix) continue
    const key = prefix.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      id: p.id || `custom-${merged.length + 1}`,
      name: String(p.name || '').trim() || prefix,
      prefix,
      enabled: !!p.enabled,
      builtin: false,
      note: p.note,
    })
  }

  out.proxies = merged
  return out
}

/** 当前渠道是否启用加速 */
export function accelEnabledFor(prefs: GitAccelPrefs, key: GitAccelUseForKey): boolean {
  return !!prefs.enabled && !!prefs.useFor[key]
}

/** 是否是允许挂代理的公开 GitHub 主机/路径 */
export function isGithubAccelUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (host === 'raw.githubusercontent.com' || host === 'gist.githubusercontent.com') return true
    if (host === 'api.github.com') return true
    if (host === 'github.com') {
      // 只代理 release 资产，别把仓库页面/网页也塞给代理
      return /\/releases\/(latest\/)?download\//.test(u.pathname)
    }
    return false
  } catch {
    return false
  }
}

/** raw.githubusercontent.com/... → cdn.jsdelivr.net/gh/...（不支持带斜杠的 ref） */
export function jsdelivrUrlForRaw(url: string): string {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i.exec(url)
  if (!m) return ''
  return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`
}

/**
 * cdn.jsdelivr.net/gh/... → raw.githubusercontent.com/...（{@link jsdelivrUrlForRaw} 的逆）
 *
 * <p>★ 为什么必须有这个方向：加速候选只认 GitHub 宿主，而 FnDepot 的索引默认就走
 * jsDelivr。缺了这一层，jsDelivr 地址会被 {@link isGithubAccelUrl} 判否 → 整条链路
 * 短路成"只有直连"，而 jsDelivr 对 >20MB 的包直接 403（实测 1.2.5 的 39.5MB fpk），
 * 于是"加速开着却永远下不动包"。
 */
export function rawUrlForJsdelivr(url: string): string {
  const m = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/i.exec(url)
  if (!m) return ''
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`
}

export interface AccelCandidate {
  /** 实际请求的地址 */
  url: string
  /** 逻辑地址（未加代理前缀）；相对 download_url 要按它解析 */
  baseUrl: string
  proxyId?: string
  proxyName?: string
}

const cooling = new Map<string, number>()
const COOLDOWN_MS = 10 * 60 * 1000

/** 单测/设置页「恢复默认」时清掉冷却 */
export function resetGitAccelHealth(): void {
  cooling.clear()
}

function isCooling(id: string): boolean {
  const until = cooling.get(id)
  return !!until && until > Date.now()
}

/** 记录候选结果：代理失败进冷却，成功清除 */
export function markAccelResult(c: AccelCandidate, ok: boolean): void {
  if (!c.proxyId) return
  if (ok) cooling.delete(c.proxyId)
  else cooling.set(c.proxyId, Date.now() + COOLDOWN_MS)
}

export interface AccelOpts {
  for: GitAccelUseForKey
  /** 已知文件大小；raw 包 <20MB 才生成 jsDelivr 候选 */
  size?: number
  /** 索引/清单类小文件：允许 jsDelivr，即使 size 未知 */
  index?: boolean
  /** 是否允许代理 api.github.com（仅在无 token 的公开源时置 true） */
  allowApi?: boolean
}

/**
 * 生成候选（直连 + 代理 + jsDelivr），按顺序去重。
 * 非 GitHub / 未启用 / 未勾选渠道 → 只返回直连。
 */
export function gitAccelCandidates(
  url: string,
  prefs: GitAccelPrefs,
  opts: AccelOpts,
): AccelCandidate[] {
  // jsDelivr 地址先翻成 raw 等价地址：候选只认 GitHub 宿主，不归一就整条短路。
  // 逻辑地址统一用 raw，相对地址（如 fpk 索引里的 ./meow/x.fpk）才解析得到可加速的宿主。
  const rawAlt = rawUrlForJsdelivr(url)
  const logical = rawAlt || url
  // jsDelivr 直连只在"它明确服务不了"时才剔除：知道体积且 ≥20MB。
  // 体积未知（如 packages.json 这类清单）保持原状——jsDelivr 在国内比 raw 稳。
  const bigKnown = typeof opts.size === 'number' && opts.size >= 20_000_000
  const jsdDirectOk = !!rawAlt && !bigKnown
  const direct: AccelCandidate = jsdDirectOk
    ? { url, baseUrl: logical }
    : { url: logical, baseUrl: logical }

  if (!accelEnabledFor(prefs, opts.for) || !isGithubAccelUrl(logical)) return [direct]

  const allowApi = opts.allowApi
  try {
    const host = new URL(logical).hostname.toLowerCase()
    if (host === 'api.github.com' && !allowApi) return [direct]
  } catch {
    return [direct]
  }

  const out: AccelCandidate[] = []
  const seen = new Set<string>()
  const push = (c: AccelCandidate) => {
    if (!c.url || seen.has(c.url)) return
    seen.add(c.url)
    out.push(c)
  }

  if (prefs.directFirst) push(direct)

  for (const p of prefs.proxies) {
    if (!p.enabled || isCooling(p.id)) continue
    if (p.id === 'jsdelivr') {
      const j = jsdelivrUrlForRaw(logical)
      if (!j) continue
      // 索引/清单允许；普通文件必须知道 <20MB 才敢用
      const ok = opts.index || (typeof opts.size === 'number' && opts.size > 0 && opts.size < 20_000_000)
      if (!ok) continue
      push({ url: j, baseUrl: logical, proxyId: p.id, proxyName: p.name })
      continue
    }
    const prefix = normalizeProxyPrefix(p.prefix)
    if (!prefix) continue
    const proxied = prefix.includes('{url}')
      ? prefix.replace('{url}', logical)
      : prefix + logical
    push({ url: proxied, baseUrl: logical, proxyId: p.id, proxyName: p.name })
  }

  if (!prefs.directFirst) push(direct)
  return out
}

/** 启用渠道的代理前缀（给 Java 配置导入 / PC 原生用；不含模板里的 {url}？保留原样） */
export function enabledProxyPrefixes(prefs: GitAccelPrefs, key: GitAccelUseForKey): string[] {
  if (!accelEnabledFor(prefs, key)) return []
  return prefs.proxies
    .filter((p) => p.enabled && p.id !== 'jsdelivr')
    .map((p) => normalizeProxyPrefix(p.prefix))
    .filter(Boolean)
}

/** 设置页「测试」：直接用某个前缀拉一个固定的公开小文件 */
export async function testProxyPrefix(prefix: string, timeoutMs = 8000): Promise<{
  ok: boolean
  status: number
  ms: number
  error?: string
}> {
  const p = normalizeProxyPrefix(prefix)
  if (!p) return { ok: false, status: 0, ms: 0, error: '地址必须是 https://' }
  const target = 'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json'
  const url = p.includes('{url}') ? p.replace('{url}', target) : p + target
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    const body = await res.text()
    let ok = res.ok
    if (ok) {
      try {
        ok = !!JSON.parse(body)?.apps
      } catch {
        ok = false
      }
    }
    return { ok, status: res.status, ms: Date.now() - t0 }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      error: String((e as Error)?.name || e),
    }
  }
}
