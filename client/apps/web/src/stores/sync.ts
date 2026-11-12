/**
 * WebDAV 同步。
 *
 * 两个功能刻意分开，因为它们的语义完全不同：
 *
 * ## 历史记录（简单并集）
 * 各端都会写入，谁看谁写，读的时候按时间倒序即可。
 * 不需要"版本"，也不需要冲突处理——同一部片取最近一次观看就行。
 *
 * ## 设置备份（时间点快照）
 * 设置是"一个确定的状态"，改坏了要能回到某个历史时刻。
 * 所以每次备份都写一个新文件，文件名带时间戳，可以按需挑一个还原。
 *
 * 远端结构：
 *   {dir}/history.json               —— 单一文件，并集
 *   {dir}/backups/prefs-<ts>.json    —— 多份快照，保留最近 N 份
 */

import {
  applyBackup,
  friendlyDavError,
  getPrefs,
  getWebdav,
  makeBackup,
  savePrefs,
  saveWebdav,
  type Backup,
  type WebdavConfig,
} from './prefs'
import { listHistory, restoreHistoryFrom, type HistoryItem } from './history'
import { listFavorites } from './favorites'
import { exportSearchHistory, importSearchHistory, listSearchHistory } from './searchHistory'

/** 保留多少份设置快照 */
export const MAX_SNAPSHOTS = 10

export type SyncState = 'idle' | 'syncing' | 'ok' | 'error' | 'off'

export interface SyncStatus {
  state: SyncState
  at?: number
  message?: string
}

let status: SyncStatus = { state: 'idle' }
const listeners = new Set<(s: SyncStatus) => void>()

function emit(next: SyncStatus) {
  status = next
  listeners.forEach((fn) => fn(next))
  // 自动同步产生了新快照时，设置页的备份列表需要刷新
  if (next.state === 'ok' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:synced'))
  }
}

export function getSyncStatus(): SyncStatus {
  return status
}

export function onSyncStatus(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn)
  fn(status)
  return () => listeners.delete(fn)
}

// ---------------------------------------------------------------- 底层请求

interface DavResult {
  ok: boolean
  status: number
  body: string
  msg?: string
}

async function davCall(
  apiBase: string,
  cfg: WebdavConfig,
  method: string,
  path: string,
  body?: string,
  depth?: string,
): Promise<DavResult> {
  const base = cfg.url.replace(/\/$/, '')
  const dir = cfg.dir.replace(/^\/|\/$/g, '')
  const url = `${base}/${dir}${path}`
  const res = await fetch(`${apiBase}/api/webdav`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      method,
      user: cfg.user,
      pass: cfg.pass,
      body,
      ...(depth ? { depth } : {}),
    }),
  })
  if (!res.ok) return { ok: false, status: res.status, body: '', msg: `代理错误 ${res.status}` }
  return res.json()
}

function reason(r: DavResult): string {
  if (r.status === 401) return '认证失败'
  if (r.status === 403) return '没有写入权限'
  if (r.status === 404) return '目录不存在'
  if (r.status === 0) return friendlyDavError(r.msg)
  return `HTTP ${r.status}`
}

/** 确保子目录存在（'' 表示根目录）。405 = 已存在，属正常。 */
async function ensureDir(apiBase: string, cfg: WebdavConfig, sub = ''): Promise<void> {
  const r = await davCall(apiBase, cfg, 'MKCOL', sub)
  if (r.ok || r.status === 405 || r.status === 301) return
  if (r.status === 401) throw new Error('WebDAV 认证失败')
  if (r.status === 403) throw new Error('没有创建目录的权限')
  if (r.status === 404) throw new Error('WebDAV 路径不存在（检查共享文件夹是否已放开）')
  // status=0 = 代理层连不上（后端把异常摘要放在 msg 里）。透出真实原因，
  // 否则用户只看到「HTTP 0」——分不清是网络、端口还是地址写错（2026-11-12 实测）。
  throw new Error(`创建目录失败：${reason(r)}`)
}

function requireCfg(): WebdavConfig {
  const cfg = getWebdav()
  if (!cfg.url) throw new Error('未配置 WebDAV 地址')
  return cfg
}

// ================================================================ 历史
//
// 各端都写，读的时候并集去重、按时间倒序。
// 不做"谁覆盖谁"的判断——同一部片取最近一次观看就够。

/**
 * 合并两份历史。
 *
 * 字段级合并，不是整条替换：
 *  - 元信息（片名/封面/时间）取 `at` 较新的一条
 *  - 播放进度取 `ep_at` 较新的一条
 *
 * 分开判的原因是：手机上打开首页点一下封面就会把 `at` 刷成最新，
 * 若按 `at` 整条覆盖，PC 上看到 20:00 的进度会被清成 0。
 */
export function mergeHistory(a: HistoryItem[], b: HistoryItem[]): HistoryItem[] {
  const map = new Map<string, HistoryItem>()
  for (const item of [...a, ...b]) {
    if (!item || typeof item.vod_id !== 'string' || typeof item.site !== 'string') continue
    const key = `${item.site}|${item.vod_id}`
    const prev = map.get(key)
    if (!prev) {
      map.set(key, item)
      continue
    }
    // 元信息：at 较大的胜出
    const newer = (item.at || 0) > (prev.at || 0) ? item : prev
    // 进度：ep_at 较大的胜出（两边都有进度才比较）
    const hasA = !!prev.ep_at
    const hasB = !!item.ep_at
    const prog = hasA && hasB ? ((item.ep_at || 0) > (prev.ep_at || 0) ? item : prev) : hasA ? prev : hasB ? item : null
    map.set(key, {
      ...prev,
      ...newer,
      ...(prog
        ? {
            pos: prog.pos,
            dur: prog.dur,
            flag: prog.flag,
            ep: prog.ep,
            ep_url: prog.ep_url,
            ep_at: prog.ep_at,
          }
        : {}),
    })
  }
  return [...map.values()]
    .sort((x, y) => (y.at || 0) - (x.at || 0))
    .slice(0, getPrefs().historyLimit)
}

function setLocalHistory(items: HistoryItem[]) {
  localStorage.setItem('meow.history.list', JSON.stringify(items))
}

/**
 * 读远端历史。
 *
 * 404 = 还没上传过（空），其余失败必须抛：旧实现把 401/连不上都当"空"，
 * 启动拉取失败被静默吞掉，用户看到"已同步"却不知道远端根本没取到。
 */
async function fetchRemoteHistory(
  apiBase: string,
  cfg: WebdavConfig,
): Promise<HistoryItem[]> {
  const r = await davCall(apiBase, cfg, 'GET', '/history.json')
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`读取远端历史失败：${reason(r)}`)
  if (!r.body) return []
  try {
    const parsed = JSON.parse(r.body)
    return Array.isArray(parsed?.items) ? (parsed.items as HistoryItem[]) : []
  } catch {
    return []
  }
}

/**
 * 上传历史（**先读-改-写**）。
 *
 * 两台设备同时同步时，各自直接 PUT 自己那份会把对方刚写的新条目覆盖掉
 * （后写者赢）。先 GET 远端并进本地（notify:false，避免再触发一轮上传），
 * 再 PUT 合并结果，冲突窗口从"整份历史"缩到"GET→PUT 之间"。
 */
export async function pushHistory(apiBase: string): Promise<{ count: number }> {
  const cfg = requireCfg()
  await ensureDir(apiBase, cfg)
  const remote = await fetchRemoteHistory(apiBase, cfg)
  if (remote.length) restoreHistoryFrom(remote, { notify: false })
  const items = listHistory()
  const payload = JSON.stringify({ version: 2, exportedAt: Date.now(), items })
  const r = await davCall(apiBase, cfg, 'PUT', '/history.json', payload)
  if (!r.ok) throw new Error(`上传历史失败：${reason(r)}`)
  return { count: items.length }
}

/** 拉取历史并与本地合并（只补新增/较新，不删本地） */
export async function pullHistory(
  apiBase: string,
): Promise<{ added: number; total: number }> {
  const cfg = requireCfg()
  const local = listHistory()
  const remote = await fetchRemoteHistory(apiBase, cfg)
  if (!remote.length) return { added: 0, total: local.length }

  const merged = mergeHistory(local, remote)
  const before = new Set(local.map((x) => `${x.site}|${x.vod_id}`))
  const added = merged.filter((x) => !before.has(`${x.site}|${x.vod_id}`)).length
  setLocalHistory(merged)
  return { added, total: merged.length }
}

// ================================================================ 搜索关键词
//
// 和观看历史一样走「各端都能写、读时并集」，只是数据量很小（最多 20 条），
// 单独一个文件便于和观看历史分开管理。

/** 合并两组关键词：按出现顺序保留，去重 */
export function mergeSearchWords(a: string[], b: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of [...a, ...b]) {
    const s = String(w || '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.slice(0, 20)
}

async function fetchRemoteSearch(apiBase: string, cfg: WebdavConfig): Promise<string[]> {
  const r = await davCall(apiBase, cfg, 'GET', '/search-history.json')
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`读取远端搜索词失败：${reason(r)}`)
  if (!r.body) return []
  try {
    const parsed = JSON.parse(r.body)
    return Array.isArray(parsed?.items)
      ? parsed.items.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : []
  } catch {
    return []
  }
}

/** 上传搜索词（同样先读-改-写，避免多端互相覆盖）。 */
export async function pushSearchHistory(apiBase: string): Promise<{ count: number }> {
  const cfg = requireCfg()
  await ensureDir(apiBase, cfg)
  const remote = await fetchRemoteSearch(apiBase, cfg)
  if (remote.length) {
    importSearchHistory(mergeSearchWords(listSearchHistory(), remote), { notify: false })
  }
  const items = listSearchHistory()
  const payload = JSON.stringify({ version: 1, exportedAt: Date.now(), items })
  const r = await davCall(apiBase, cfg, 'PUT', '/search-history.json', payload)
  if (!r.ok) throw new Error(`上传搜索词失败：${reason(r)}`)
  return { count: items.length }
}

export async function pullSearchHistory(
  apiBase: string,
): Promise<{ added: number; total: number }> {
  const cfg = requireCfg()
  const local = listSearchHistory()
  const remote = await fetchRemoteSearch(apiBase, cfg)
  const merged = mergeSearchWords(local, remote)
  const before = new Set(local)
  const added = merged.filter((x) => !before.has(x)).length
  // 静默写：拉取不是"用户搜了新词"，不能广播 meow:search-history 再触发上传
  if (added) importSearchHistory(merged, { notify: false })
  return { added, total: merged.length }
}

// ================================================================ 设置备份
//
// 每次备份写一个新文件，文件名带时间戳，可回滚到任意一个时间点。

export interface Snapshot {
  /** 文件名，如 prefs-20261021-093012.json */
  name: string
  /** 备份时间（毫秒，来自文件名里的**设备本地时间**） */
  at: number
  /**
   * 远端 Last-Modified（毫秒）。
   *
   * 文件名是客户端时钟生成的——多端时钟不齐时（实测 76 号机慢 9 小时）
   * 按名排序会把旧快照当"最新"。有服务器时间就优先用它排序和展示。
   */
  mtime?: number
  /** 设置里的历史条数（展示用） */
  historyCount: number
  /** 当时的源 */
  site?: string
}

/** 时间戳格式化：20261021-093012 */
function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** 从文件名还原时间；解析失败返回 0 */
function parseStamp(name: string): number {
  const m = /prefs-(\d{8})-(\d{6})\.json/.exec(name)
  if (!m) return 0
  const [, d, t] = m
  const y = +d.slice(0, 4)
  const mo = +d.slice(4, 6) - 1
  const da = +d.slice(6, 8)
  const h = +t.slice(0, 2)
  const mi = +t.slice(2, 4)
  const s = +t.slice(4, 6)
  return new Date(y, mo, da, h, mi, s).getTime()
}

/**
 * 创建一份设置快照。
 *
 * 如果和最新一份内容完全一致就跳过，避免"改一下午设置产生 50 个相同快照"。
 */
/**
 * 判断两份快照的内容是否"值得跳过"。
 *
 * 只比**稳定**的部分：prefs + 搜索词 + 手动片头标记。
 * 历史/收藏/观看统计每次都在变，比它们会导致每次播放都产出一份快照。
 * skipMarks 必须比——否则用户只标了片头、没改设置时，新标记永远不会被上传
 * （dedupe 认为"和上一份一样"）。watchDays 同理不比（天天在涨）。
 */
export function snapshotEquivalent(prev: Backup, next: Backup): boolean {
  return (
    JSON.stringify(prev.prefs) === JSON.stringify(next.prefs) &&
    JSON.stringify(prev.searchHistory ?? []) === JSON.stringify(next.searchHistory ?? []) &&
    JSON.stringify(prev.aux?.skipMarks ?? []) === JSON.stringify(next.aux?.skipMarks ?? [])
  )
}

export async function createSnapshot(
  apiBase: string,
  opts: { force?: boolean } = {},
): Promise<{ name: string; skipped: boolean }> {
  const cfg = requireCfg()
  await ensureDir(apiBase, cfg)
  await ensureDir(apiBase, cfg, '/backups')

  const backup = makeBackup(listHistory(), exportSearchHistory(), listFavorites())
  const content = JSON.stringify(backup)

  // 与最新快照比较，相同则跳过。历史每次都在变，只比 prefs + 搜索词，
  // 否则改一下午设置会产出几十个内容完全相同的快照。
  //
  // favorites 同理不比：收藏也属于"经常变"的用户数据，让它自己触发快照会造成
  // 同样的刷屏；它随下一次快照一起写进去就够了。真正的跨端收藏同步走
  // /api/state/favorites 那条通道，不依赖备份。
  if (!opts.force) {
    const latest = (await listSnapshots(apiBase))[0]
    if (latest) {
      const r = await davCall(apiBase, cfg, 'GET', `/backups/${latest.name}`)
      if (r.ok && r.body) {
        try {
          const prev = JSON.parse(r.body) as Backup
          if (snapshotEquivalent(prev, backup)) {
            return { name: latest.name, skipped: true }
          }
        } catch {
          /* 旧快照坏了就照常写新的 */
        }
      }
    }
  }

  const name = `prefs-${stamp()}.json`
  const r = await davCall(apiBase, cfg, 'PUT', `/backups/${name}`, content)
  if (!r.ok) throw new Error(`创建快照失败：${reason(r)}`)

  await pruneSnapshots(apiBase).catch(() => {
    /* 清理失败不影响本次备份 */
  })
  return { name, skipped: false }
}

/** 列出所有快照，按时间倒序 */
export async function listSnapshots(apiBase: string): Promise<Snapshot[]> {
  const cfg = requireCfg()
  const r = await davCall(apiBase, cfg, 'PROPFIND', '/backups', undefined, '1')
  if (!r.ok) {
    if (r.status === 404) return []
    throw new Error(`读取备份列表失败：${reason(r)}`)
  }
  /*
   * 每个 <D:response> 自带 href 与 getlastmodified，按块配对；
   * 全局扫会张冠李戴。服务器前缀不统一（D: / d: / dav:），正则放宽。
   * 没有 response 包裹的实现退回纯 href 扫描（拿不到 mtime）。
   */
  const blocks = r.body.split(/<(?:\w+:)?response\b/gi).slice(1)
  const entries = blocks.length
    ? blocks.map((b) => ({
        href: /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/i.exec(b)?.[1] || '',
        lm: /<(?:\w+:)?getlastmodified>([^<]+)<\/(?:\w+:)?getlastmodified>/i.exec(b)?.[1] || '',
      }))
    : [...r.body.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi)].map((m) => ({
        href: m[1],
        lm: '',
      }))

  const out: Snapshot[] = []
  for (const { href, lm } of entries) {
    if (!href) continue
    const rawName = href.split('/').filter(Boolean).pop() || ''
    let name = rawName
    try {
      name = decodeURIComponent(rawName)
    } catch {
      /* 文件名里有坏 % 序列：按原样用，不让整个列表失败 */
    }
    if (!name.startsWith('prefs-') || !name.endsWith('.json')) continue
    const ms = lm ? Date.parse(lm) : NaN
    out.push({
      name,
      at: parseStamp(name),
      mtime: Number.isFinite(ms) ? ms : undefined,
      historyCount: 0,
    })
  }
  // 服务器时间优先；没有 Last-Modified 的服务器退回文件名时间。
  return out.sort((a, b) => (b.mtime ?? b.at) - (a.mtime ?? a.at))
}

/**
 * 手动清理：只保留最近 keep 份快照（默认 3）。
 *
 * 和自动 prune（保留 MAX_SNAPSHOTS=10）分开：用户可能想主动收缩，
 * 不想一份份点删除。返回实际删掉几份。
 */
export async function pruneSnapshotsTo(
  apiBase: string,
  keep = 3,
): Promise<{ deleted: number; kept: number }> {
  const cfg = requireCfg()
  const all = await listSnapshots(apiBase)
  const extra = all.slice(Math.max(0, keep))
  let deleted = 0
  for (const s of extra) {
    const r = await davCall(apiBase, cfg, 'DELETE', `/backups/${s.name}`).catch(() => null)
    if (r?.ok) deleted++
  }
  return { deleted, kept: Math.min(all.length, Math.max(0, keep)) }
}

/** 只保留最近 MAX_SNAPSHOTS 份 */
async function pruneSnapshots(apiBase: string): Promise<void> {
  const cfg = getWebdav()
  const all = await listSnapshots(apiBase)
  const extra = all.slice(MAX_SNAPSHOTS)
  for (const s of extra) {
    await davCall(apiBase, cfg, 'DELETE', `/backups/${s.name}`).catch(() => {})
  }
}

/** 读取某份快照并应用（**只还原设置**，历史有独立文件与合并逻辑） */
export async function restoreSnapshot(apiBase: string, name: string): Promise<void> {
  const cfg = requireCfg()
  const r = await davCall(apiBase, cfg, 'GET', `/backups/${name}`)
  if (!r.ok || !r.body) throw new Error(`读取快照失败：${reason(r)}`)
  const backup = JSON.parse(r.body) as Backup
  applyBackup(backup, { prefsOnly: true })
}

/** 删除某份快照 */
export async function deleteSnapshot(apiBase: string, name: string): Promise<void> {
  const cfg = requireCfg()
  const r = await davCall(apiBase, cfg, 'DELETE', `/backups/${name}`)
  if (!r.ok) throw new Error(`删除失败：${reason(r)}`)
}

// ---------------------------------------------------------------- 兼容：手动上传/还原

/** 手动上传：历史 + 一份新快照 */
export async function upload(
  apiBase: string,
  opts: { history?: boolean; prefs?: boolean } = {},
): Promise<{ files: string[] }> {
  const cfg = getWebdav()
  if (!cfg.url) throw new Error('未配置 WebDAV 地址')
  const wantHistory = opts.history ?? cfg.syncHistory
  const wantPrefs = opts.prefs ?? cfg.syncPrefs
  if (!wantHistory && !wantPrefs) throw new Error('没有勾选要同步的内容')

  emit({ state: 'syncing' })
  try {
    const files: string[] = []
    if (wantHistory) {
      await pushHistory(apiBase)
      files.push('history.json')
    }
    if (wantPrefs) {
      const s = await createSnapshot(apiBase, { force: true })
      files.push(s.name)
    }
    const at = Date.now()
    saveWebdav({ lastSyncAt: at })
    emit({ state: 'ok', at, message: `已上传 ${files.length} 项` })
    return { files }
  } catch (e: any) {
    emit({ state: 'error', message: e?.message || String(e) })
    throw e
  }
}

// ---------------------------------------------------------------- 自动同步

let uploadTimer: number | undefined

/** 标记本地有变更，防抖后自动同步 */
export function scheduleUpload(apiBase: string, delayMs = 5000): void {
  const cfg = getWebdav()
  if (!cfg.enabled || !cfg.url) return
  clearTimeout(uploadTimer)
  uploadTimer = window.setTimeout(() => {
    autoSyncNow(apiBase).catch(() => {
      /* 状态里已体现，不打断用户 */
    })
  }, delayMs)
}

/** 自动同步一次：按开关决定推历史 / 搜索词 / 设置快照 */
/** 自动同步失败后的重试间隔（毫秒）；0 = 首次立即执行 */
let RETRY_DELAYS = [0, 3000, 10000]

/** 测试用：把重试间隔缩短，避免单测真等 13 秒 */
export function __setRetryDelaysForTest(d: number[]): void {
  RETRY_DELAYS = d.length ? d : [0]
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

let syncingNow = false
let rerunRequested = false

async function pushOnce(apiBase: string, cfg: WebdavConfig): Promise<void> {
  if (cfg.syncHistory) await pushHistory(apiBase)
  if (cfg.syncSearchHistory) await pushSearchHistory(apiBase)
  if (cfg.syncPrefs) await createSnapshot(apiBase)
  // 片库配置默认不备份（见 WebdavConfig.syncLibrary 的说明）
  if (cfg.syncLibrary) await pushLibraryConfig(apiBase)
}

/**
 * 执行一轮自动同步（失败退避重试 2 次：3s / 10s）。
 *
 * 为什么要重试：一次网络抖动（换 WiFi、NAS 休眠刚唤醒）就让徽标红到
 * 下一次变更，用户看到的是"同步坏了"。重试仍失败才报错。
 * 同一时刻只跑一轮；期间又有变更就记个标记，结束后补跑一次。
 */
export async function autoSyncNow(apiBase: string): Promise<void> {
  const cfg = getWebdav()
  if (!cfg.enabled || !cfg.url) return
  if (syncingNow) {
    rerunRequested = true
    return
  }
  syncingNow = true
  emit({ state: 'syncing' })
  let lastErr: unknown
  try {
    for (let i = 0; i < RETRY_DELAYS.length; i++) {
      if (RETRY_DELAYS[i]) await sleep(RETRY_DELAYS[i])
      try {
        await pushOnce(apiBase, cfg)
        const at = Date.now()
        saveWebdav({ lastSyncAt: at })
        emit({ state: 'ok', at, message: i ? `已同步（重试 ${i} 次后成功）` : '已同步' })
        lastErr = undefined
        return
      } catch (e) {
        lastErr = e
      }
    }
    const raw = lastErr instanceof Error ? lastErr.message : String(lastErr)
    const times = RETRY_DELAYS.length - 1
    emit({ state: 'error', message: `${raw}${times ? `（已重试 ${times} 次）` : ''}` })
    throw lastErr
  } finally {
    syncingNow = false
    if (rerunRequested) {
      rerunRequested = false
      void autoSyncNow(apiBase)
    }
  }
}

let pulledThisSession = false
let pulling = false

export interface PullError {
  at: number
  message: string
}

let lastPullError: PullError | null = null

/** 上次启动拉取失败的原因（成功一次后清空）。设置页据此提示，不阻塞启动。 */
export function getLastPullError(): PullError | null {
  return lastPullError
}

function setPullError(e: unknown): void {
  lastPullError = { at: Date.now(), message: e instanceof Error ? e.message : String(e) }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('meow:sync-pull-error'))
}

function clearPullError(): void {
  if (!lastPullError) return
  lastPullError = null
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('meow:sync-pull-error'))
}

/**
 * 启动时拉一次历史与搜索词（只合并，设置不自动还原）。
 *
 * 失败**不阻塞启动**，但也不再静默吞掉：记进 lastPullError，设置页显示
 * "上次拉取失败：…"。否则换机时远端没取到，用户看到"已同步"（上次的
 * 状态）会以为历史已经合并好了。
 */
export async function autoPullOnStart(apiBase: string): Promise<void> {
  const cfg = getWebdav()
  if (!cfg.enabled || !cfg.url || pulledThisSession || pulling) return
  pulling = true
  try {
    if (cfg.syncHistory) await pullHistory(apiBase)
    if (cfg.syncSearchHistory) await pullSearchHistory(apiBase)
    pulledThisSession = true
    clearPullError()
  } catch (e) {
    setPullError(e)
  } finally {
    pulling = false
  }
}

/**
 * 把外部操作（设置页的手动按钮）也纳入顶栏同步状态。
 *
 * 之前手动"上传历史/立即备份"成功或失败都不 emit，顶栏会一直挂着上一次
 * 的"同步失败"（或明明成功却不显示已同步），用户以为按钮无效。
 */
export async function withSyncStatus<T>(
  fn: () => Promise<T>,
  okText: (r: T) => string,
): Promise<T> {
  emit({ state: 'syncing' })
  try {
    const r = await fn()
    const at = Date.now()
    saveWebdav({ lastSyncAt: at })
    emit({ state: 'ok', at, message: okText(r) })
    return r
  } catch (e: any) {
    emit({ state: 'error', message: e?.message || String(e) })
    throw e
  }
}

/** 立即把待发的变更发出去（页面隐藏时用） */
export function flushUpload(apiBase: string): void {
  const cfg = getWebdav()
  if (!cfg.enabled || !cfg.url) return
  if (uploadTimer === undefined) return
  clearTimeout(uploadTimer)
  uploadTimer = undefined
  autoSyncNow(apiBase).catch(() => {})
}

export function cancelPending(): void {
  clearTimeout(uploadTimer)
  uploadTimer = undefined
  emit({ state: 'off' })
}

// ================================================================ 片库配置
//
// 片库配置（SMB/WebDAV 地址、账号、子目录）换机时最烦——手打一遍地址错一个
// 字符就连不上，而它不属于"历史/设置"任何一类，之前完全没备份。
//
// ★ **绝不备份密码**。远端文件可能是别人的 WebDAV、也可能被同步到云盘，
//   把 SMB 密码写进去等于泄露。只备份地址/账号/子目录，密码换机后由用户
//   在配置页重填一次（配置页本来就有这个输入框）。
//
// 也不做自动还原：片库"连哪个 NAS"是每台设备的本地决定（家里 NAS、
// 公司 NAS 不该互相覆盖），所以只提供"读回来核对"。

export interface LibraryBackupEntry {
  name: string
  type: string
  base: string
  user: string
  root: string
  domain?: string
}

/** 把当前片库配置（不含密码）推到 WebDAV。 */
export async function pushLibraryConfig(apiBase: string): Promise<{ count: number }> {
  const cfg = requireCfg()
  await ensureDir(apiBase, cfg)
  const r = await fetch(`${apiBase}/api/library`)
  if (!r.ok) throw new Error(`读取片库配置失败：HTTP ${r.status}`)
  const j = (await r.json()) as { libs?: Array<Record<string, unknown>> }
  const entries: LibraryBackupEntry[] = (j.libs || []).map((x) => ({
    name: String(x.name || ''),
    type: String(x.type || ''),
    base: String(x.base || ''),
    user: String(x.user || ''),
    root: String(x.root || ''),
    ...(x.domain ? { domain: String(x.domain) } : {}),
  }))
  const payload = JSON.stringify({
    version: 1,
    exportedAt: Date.now(),
    // 明确写出来，避免以后有人"顺手"把密码加进去
    note: '不含密码；换机后需在片库配置页重填',
    libs: entries,
  })
  const res = await davCall(apiBase, cfg, 'PUT', '/library.json', payload)
  if (!res.ok) throw new Error(`上传片库配置失败：${reason(res)}`)
  return { count: entries.length }
}

/** 读回远端片库配置（不自动应用，只给设置页展示/核对）。 */
export async function fetchLibraryBackup(apiBase: string): Promise<LibraryBackupEntry[]> {
  const cfg = requireCfg()
  const r = await davCall(apiBase, cfg, 'GET', '/library.json')
  if (!r.ok || !r.body) return []
  try {
    const parsed = JSON.parse(r.body)
    return Array.isArray(parsed?.libs) ? (parsed.libs as LibraryBackupEntry[]) : []
  } catch {
    return []
  }
}
