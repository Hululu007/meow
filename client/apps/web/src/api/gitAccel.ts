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

/**
 * 更新链路的共享阈值（三端同一份**数值契约**）。
 *
 * <p>★ 为什么放这里：执行环境不同（PC 的 curl / TV 的 OkHttp / Web 的 fetch），
 * 实现没法共用；但**数值必须共用**——否则会出现「PC 8 秒换线、TV 5 秒换线、
 * Web 永不换线」这种同一件事三种表现。三端各自实现时引用这里的数，
 * 调参只改这一处（PC 端 Rust 侧与 TV 端 Java 侧的注释都指向这里）。
 */
export const ACCEL_LIMITS = {
  /** jsDelivr 单文件硬上限：≥ 这个体积它直接 403，不再生成候选 */
  jsdelivrMaxBytes: 20_000_000,
  /** 低速换线：判定窗口内平均速度低于该值就放弃这条线路 */
  slowSpeedBps: 32 * 1024,
  /** 低速判定的窗口长度（毫秒） */
  slowWindowMs: 8000,
  /** 只有大于这个体积才做低速判定（小文件换线比下完还慢） */
  slowMinBytes: 5 * 1024 * 1024,
  /** 清单并发竞速：最多同时几条（含直连） */
  raceMaxCandidates: 3,
} as const

/** 单测/设置页「恢复默认」时清掉冷却 */
export function resetGitAccelHealth(): void {
  cooling.clear()
}

function isCooling(id: string): boolean {
  const until = cooling.get(id)
  return !!until && until > Date.now()
}

// ---------------------------------------------------------------- 成功线路记忆
//
// 冷却只解决"别反复试死掉的线路"，不解决"每次从第一条开始试"。
// 这里记住**上次成功的那条**（按 索引 / 文件 分开记），下次把它提到直连之后。
// ★ 不记 jsDelivr：raw 文件它可能返回小时级缓存，旧清单会冒充「已是最新」。
// ★ 24h 过期 + 该线路失败即清：网络换了（公司/家里/热点）不能一直朝老路上撞。

const BEST_KEY = 'meow.accel.best'
const BEST_TTL_MS = 24 * 60 * 60 * 1000

export type AccelKind = 'index' | 'file'

interface BestEntry {
  id: string
  at: number
}

function readBestMap(): Record<string, BestEntry> {
  try {
    const raw = localStorage.getItem(BEST_KEY)
    if (!raw) return {}
    const doc = JSON.parse(raw) as Record<string, { id?: unknown; at?: unknown }>
    const out: Record<string, BestEntry> = {}
    for (const [k, v] of Object.entries(doc || {})) {
      if (v && typeof v.id === 'string' && typeof v.at === 'number') out[k] = { id: v.id, at: v.at }
    }
    return out
  } catch {
    return {}
  }
}

function writeBestMap(m: Record<string, BestEntry>): void {
  try {
    if (!Object.keys(m).length) localStorage.removeItem(BEST_KEY)
    else localStorage.setItem(BEST_KEY, JSON.stringify(m))
  } catch {
    /* 隐私模式/配额满：退化成"每次都按默认顺序试"，不影响功能 */
  }
}

/** 记住这次成功的线路（只记线路 id，不记 URL） */
export function rememberAccelWinner(kind: AccelKind, c: AccelCandidate): void {
  if (!c.proxyId || c.proxyId === 'jsdelivr') return
  const m = readBestMap()
  m[kind] = { id: c.proxyId, at: Date.now() }
  writeBestMap(m)
}

/** 某条线路失败后，引用它的记忆全部作废 */
function forgetWinnerOf(proxyId: string): void {
  const m = readBestMap()
  let dirty = false
  for (const k of Object.keys(m)) {
    if (m[k].id === proxyId) {
      delete m[k]
      dirty = true
    }
  }
  if (dirty) writeBestMap(m)
}

/** 单测/「恢复默认」用：清掉成功线路记忆 */
export function resetAccelMemory(): void {
  writeBestMap({})
}

/** 记录候选结果：代理失败进冷却（并清掉它的成功记忆），成功清除冷却 */
export function markAccelResult(c: AccelCandidate, ok: boolean): void {
  if (!c.proxyId) return
  if (ok) {
    cooling.delete(c.proxyId)
    return
  }
  cooling.set(c.proxyId, Date.now() + COOLDOWN_MS)
  forgetWinnerOf(c.proxyId)
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
  const bigKnown = typeof opts.size === 'number' && opts.size >= ACCEL_LIMITS.jsdelivrMaxBytes
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

  // ★ 直连也要能被冷却（2026-11-13 .77 实测）：直连失败时没有任何记录，
  //   于是每次检查都先花 15s 在它身上，用户看到的就是「点了很久没反应」。
  //   冷却期内把它排到最后（不是丢弃：所有代理都挂了时它仍是最后希望）。
  const directCooling = isCooling('direct')
  const directCand: AccelCandidate = { ...direct, proxyId: 'direct', proxyName: '直连' }

  if (prefs.directFirst && !directCooling) push(directCand)

  // ★ 全部代理都在冷却时**不能一个都不用**：那样候选只剩直连，
  //   等于「加速开着却完全不生效」，而冷却恰恰是因为网差才产生的
  //   （一次失败 → 10 分钟全灭 → 之后每次都必然超时）。
  //   判据是「实际产生了几条代理候选」：只冷却了 gh-proxy/ghfast，
  //   而 jsdelivr 对 release 资产不产生候选，那也等于全灭。
  const enabledProxies = prefs.proxies.filter((p) => p.enabled)
  let usable = enabledProxies.filter((p) => !isCooling(p.id))

  const pushProxies = (list: GitProxy[]) => {
    const before = out.length
    for (const p of list) {
      if (p.id === 'jsdelivr') {
        const j = jsdelivrUrlForRaw(logical)
        if (!j) continue
        // 索引/清单允许；普通文件必须知道 <20MB 才敢用
        const ok = opts.index
          || (typeof opts.size === 'number' && opts.size > 0 && opts.size < ACCEL_LIMITS.jsdelivrMaxBytes)
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
    return out.length - before
  }

  if (pushProxies(usable) === 0 && usable.length !== enabledProxies.length) {
    // 冷却期把所有「能用的」代理都剔掉了 → 忽略冷却重来，宁可再试一次
    pushProxies(enabledProxies)
  }

  if (directCooling || !prefs.directFirst) push(directCand)

  // 上次成功的线路提前到直连之后：第二次起不用再从头试一遍
  // （只提前、不越过直连；冷却中的不提前——它刚失败过）
  const best = readBestMap()[opts.index ? 'index' : 'file']
  if (best && Date.now() - best.at < BEST_TTL_MS && !isCooling(best.id)) {
    const at = out.findIndex((c) => c.proxyId === best.id)
    if (at > 0) {
      const [hit] = out.splice(at, 1)
      const directAt = out.findIndex((c) => c.proxyId === 'direct')
      out.splice(directAt >= 0 ? directAt + 1 : 0, 0, hit)
    }
  }

  return out
}

/**
 * 并发竞速：同时发起前 N 条候选，按**完成顺序**取第一条通过 `validate` 的。
 *
 * <p>为什么不用 `Promise.any`：它只判 promise 是否成功，而代理的 HTML 错误页会
 * 返回 200 —— 必须靠内容二次确认（`validate`），不通过就等下一份。
 *
 * <p>★ 调用方负责把 jsDelivr 剔除：raw 文件的它是 CDN 缓存（小时级），
 * 竞速会拿到旧清单/旧文件，反而更糟。
 */
export async function raceFirst<T>(
  items: T[],
  run: (item: T) => Promise<string>,
  validate: (text: string) => boolean,
  max = ACCEL_LIMITS.raceMaxCandidates,
): Promise<{ text: string; item: T }> {
  const pick = items.slice(0, Math.max(1, max))
  if (!pick.length) throw new Error('没有候选地址')
  return await new Promise<{ text: string; item: T }>((resolve, reject) => {
    let left = pick.length
    let lastErr: unknown = null
    for (const item of pick) {
      run(item).then(
        (text) => {
          if (validate(text)) {
            resolve({ text, item })
            return
          }
          lastErr = new Error('返回内容不是目标文件（代理错误页？）')
          if (--left === 0) reject(lastErr)
        },
        (err) => {
          lastErr = err
          if (--left === 0) reject(lastErr)
        },
      )
    }
  })
}

// ---------------------------------------------------------------- 预热
//
// 检查更新/下载之前先把 DNS+TLS 暖好（只加 <link rel=preconnect>，不发请求）。
// 目标：省掉第一次的那 200–500ms；失败的 preconnect 浏览器自己忽略。
let warmedHosts = false

export function warmUpdateHosts(prefs: GitAccelPrefs, extra: string[] = []): void {
  if (warmedHosts || typeof document === 'undefined') return
  warmedHosts = true
  const origins = new Set<string>(['https://github.com', 'https://raw.githubusercontent.com'])
  for (const p of prefs.proxies) {
    if (!p.enabled) continue
    if (p.id === 'jsdelivr') {
      origins.add('https://cdn.jsdelivr.net')
      continue
    }
    try {
      const base = normalizeProxyPrefix(p.prefix).split('{url}')[0]
      origins.add(new URL(base).origin)
    } catch {
      /* 自定义模板/非法前缀：忽略 */
    }
  }
  for (const u of extra) {
    try {
      origins.add(new URL(u).origin)
    } catch {
      /* 非 http(s) 地址：忽略 */
    }
  }
  for (const origin of [...origins].slice(0, 6)) {
    const link = document.createElement('link')
    link.rel = 'preconnect'
    link.href = origin
    link.crossOrigin = ''
    document.head.appendChild(link)
  }
}

/**
 * 低速判定：窗口内平均速度是否低于 `ACCEL_LIMITS.slowSpeedBps`。
 *
 * <p>抽成纯函数是为了可测（三端实现不同，但判定必须是同一个口径）。
 */
export function isLineTooSlow(windowBytes: number, elapsedMs: number): boolean {
  if (elapsedMs <= 0) return false
  return (windowBytes * 1000) / elapsedMs < ACCEL_LIMITS.slowSpeedBps
}

/**
 * 低速换线开关：默认开，`localStorage['meow.accel.slow'] = '0'` 关掉。
 *
 * <p>为什么留开关：32KB/s 这条线对"极慢但能通"的网络是一个取舍——
 * 按 PC/TV 现有口径换线下一条，但如果所有线路都只有 20KB/s，
 * 用户会看到"线路太慢"而永远装不上（旧行为是慢慢爬完）。出问题时可一键关。
 */
export function accelSlowDisabled(): boolean {
  try {
    return localStorage.getItem('meow.accel.slow') === '0'
  } catch {
    return false
  }
}

/**
 * 竞速开关：默认开，`localStorage['meow.accel.race'] = '0'` 退回串行。
 *
 * <p>为什么要开关：竞速是唯一可能"抢答拿到旧清单"的改动（排除 jsDelivr 之后
 * 风险已经很小，但仍留一条一键退回的路，不用等发版）。
 */
export function accelRaceDisabled(): boolean {
  try {
    return localStorage.getItem('meow.accel.race') === '0'
  } catch {
    return false
  }
}

/** 单测用：清掉"已预热"标记 */
export function resetWarmHosts(): void {
  warmedHosts = false
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
