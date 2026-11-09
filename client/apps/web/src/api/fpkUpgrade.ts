/**
 * fnOS fpk 应用内一键升级（只升到最新版本）。
 *
 * <p>整条链路都在**浏览器同源**里跑：
 *   ① meowd `/api/_shell/info` 取当前 fpk 版本与架构；
 *   ② 浏览器下载 FnDepot 索引与 fpk（raw.githubusercontent 有 CORS）；
 *   ③ fpk 字节交给 meowd 落到 `$TRIM_PKGVAR/updates/`（应用中心要一个 NAS 绝对路径）；
 *   ④ `download/task` 让应用中心登记（生成 `<app>-<ver>-tpk`）；
 *   ⑤ `update/task` + `update/status` 完成升级。
 *
 * <p>★ 为什么不用 meowd 直接下载：`reqwest` 没开 TLS feature（体积优先），
 * 只能访问 http；GitHub 是 https。浏览器下载还顺带给了真实进度与 sha256 校验。
 *
 * <p>★ 为什么不自己拿 Cookie：`/app-center/v1/*` 与页面同源（`/app/meow/`），
 * `credentials:'include'` 就够了。自己存 token 既没必要也会泄露。
 */
import { apiBase } from '@/api'
import { formatNoteLines, isNewer, resolveUrl, sha256Hex } from '@/api/appUpdate'
import { getPrefs } from '@/stores/prefs'
import { gitAccelCandidates, markAccelResult, type AccelCandidate } from '@/api/gitAccel'

/** 应用中心里的应用名（= fpk manifest 的 appname） */
export const FPK_APP_NAME = 'meow'

/**
 * 索引地址。默认走 jsDelivr 的**主域名**（Cloudflare）。
 *
 * <p>★ 为什么不是 `raw.githubusercontent.com`：NAS 实测 `Connection reset by peer`
 * （2026-11-06，root 下 curl）。
 *
 * <p>★ 为什么不是 `gcore` / `fastly` / `testingcf` 这些分节点：jsDelivr 的
 * purge 接口只清**主域名**（返回体里只有 `providers: {CF, FY}`），分节点各自
 * 缓存分支引用（`@main`）最长 12 小时。实测推完新索引再 purge：
 * `cdn.jsdelivr.net` 立刻是新内容，而 `gcore` / `fastly` / `testingcf`
 * 仍返回上一提交（2026-11-06 15:44Z）。**"发版后要等最长 12 小时"不叫能更新**。
 *
 * <p>★ NAS 本机 curl 打不通 `cdn.jsdelivr.net` 是它自己的 DNS 只给了 AAAA
 * （IPv6 不通）——但索引与安装包都是**浏览器**下载的，走用户自己的网络，
 * 和 NAS 的 shell 环境无关。实测 PC 侧该域名 200。
 *
 * <p>允许用 localStorage `meow.fpkIndex` 覆盖：私有源/内网镜像要用，
 * 本机联调也是靠它指向 mock。设置页「应用更新」区块有明面入口改它。
 */
export const DEFAULT_INDEX_URL =
  'https://cdn.jsdelivr.net/gh/upchr/FnDepot@main/fnpack.json'

export function fpkIndexUrl(): string {
  try {
    return localStorage.getItem('meow.fpkIndex') || DEFAULT_INDEX_URL
  } catch {
    return DEFAULT_INDEX_URL
  }
}

/** 设置索引地址；传空值表示恢复默认。 */
export function setFpkIndexUrl(url: string): void {
  try {
    const v = String(url || '').trim()
    if (v) localStorage.setItem('meow.fpkIndex', v)
    else localStorage.removeItem('meow.fpkIndex')
  } catch {
    /* 隐私模式下 localStorage 不可写，忽略 */
  }
}

export const DEFAULT_FPK_REPO = 'upchr/FnDepot'
const DEFAULT_FPK_BRANCH = 'main'

/**
 * 用户输入 → 索引基础地址列表。
 *
 * 支持：
 *   - `owner/repo`
 *   - `https://github.com/owner/repo`（可带 `/tree/<branch>`）
 *   - 完整 `.json` URL（jsDelivr 地址会额外补一个 raw 等价地址，便于走代理）
 *
 * 返回的是**逻辑地址**；代理候选由 gitAccelCandidates 生成。
 */
export function fpkIndexBases(input: string): string[] {
  const raw = String(input || '').trim()
  if (!raw) return []
  const repoRe = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
  const ghRe = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/(.+?))?\/?$/i
  const jsdRe = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/i
  let m = repoRe.exec(raw)
  if (m) {
    return [`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${DEFAULT_FPK_BRANCH}/fnpack.json`]
  }
  m = ghRe.exec(raw)
  if (m) {
    const branch = (m[3] || DEFAULT_FPK_BRANCH).replace(/\/+$/, '')
    return [`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${branch}/fnpack.json`]
  }
  try {
    const u = new URL(raw, location.href)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return []
    const out = [u.toString()]
    m = jsdRe.exec(u.toString())
    if (m) out.push(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`)
    return out
  } catch {
    return []
  }
}

export interface FpkShellInfo {
  app: string
  role: string
  version: string
  port?: number
  apiPort?: number
  /** `x86_64` / `aarch64` …（meowd 注入；老版本壳没有 */
  arch?: string
}

export interface FpkPackageInfo {
  download_url: string
  sha256: string
  size: number
}

export interface FpkReleaseInfo {
  version?: string
  changelog?: string
  updated_at?: string
  os_min_version?: string
  packages?: Record<string, FpkPackageInfo>
}

export interface FpkLatest {
  version: string
  release: FpkReleaseInfo
  pkg: FpkPackageInfo
  /** 已按索引地址解析成绝对 URL */
  url: string
  /** 命中的架构键（x86 / arm） */
  arch: string
  /** 更新说明拆成行，给 UI 直接渲染 */
  notes: string[]
}

/** 安装进度阶段（UI 只认这几种，避免文案散落在模板里） */
export type FpkPhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'saving'
  | 'registering'
  | 'installing'
  | 'done'
  | 'error'

export interface FpkProgress {
  phase: FpkPhase
  percent: number
  text: string
}

let shellCache: Promise<FpkShellInfo | null> | null = null

/**
 * 探测 fnOS 壳（meowd 的 `/api/_shell/info`）。
 *
 * <p>★ 不能只看这个端点：直接访问 `http://<NAS>:30010/` 时 meowd 也在服务，
 * 但 `/app-center/*` 是 5666 的网关才有的。所以调用方还要能打通 app-center。
 * 这里只负责"是不是 meowd 托管"，是不是 fpk 入口由 {@link detectFpkShell} 判。
 */
export function shellInfo(): Promise<FpkShellInfo | null> {
  if (shellCache) return shellCache
  shellCache = (async () => {
    try {
      const res = await fetch(`${apiBase()}/api/_shell/info`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) return null
      const info = (await res.json()) as FpkShellInfo
      return info && info.app === 'meow' && info.role === 'shell' ? info : null
    } catch {
      return null
    }
  })()
  return shellCache
}

/** 索引 URL + 解析结果（相对于哪个索引地址解析 download_url） */
export interface FpkIndex {
  url: string
  apps: Record<string, { releases?: Record<string, FpkReleaseInfo> }>
}

export async function fetchIndex(input = fpkIndexUrl()): Promise<FpkIndex> {
  const prefs = getPrefs().gitAccel
  const bases = fpkIndexBases(input)
  if (!bases.length) {
    throw new Error('更新索引地址不合法（支持 owner/repo、GitHub 仓库地址或完整 URL）')
  }
  let tried = 0
  let lastErr = ''
  for (const base of bases) {
    // 相对地址先绝对化；否则 resolveUrl/URL 会抛错，fetch('') 会把页面 HTML 当索引
    let logical = base
    try {
      logical = new URL(base, location.href).href
    } catch {
      /* 保持原样，让 fetch 报错 */
    }
    const cands = gitAccelCandidates(logical, prefs, { for: 'fpk', index: true })
    for (const c of cands) {
      tried++
      try {
        const res = await fetch(c.url, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        let doc: { apps?: Record<string, { releases?: Record<string, FpkReleaseInfo> }> }
        try {
          doc = await res.json()
        } catch {
          throw new Error('不是合法 JSON')
        }
        if (!doc || !doc.apps) throw new Error('没有 apps 段')
        markAccelResult(c, true)
        // 相对 download_url 按逻辑地址解析，不按代理/镜像地址
        return { url: c.baseUrl || logical, apps: doc.apps }
      } catch (e) {
        markAccelResult(c, false)
        lastErr = `${c.url} → ${(e as Error).message || '失败'}`
      }
    }
  }
  throw new Error(`读取更新索引失败（已试 ${tried} 个地址）：${lastErr}`)
}

function archKeyOf(info: FpkShellInfo | null): 'x86' | 'arm' {
  const raw = String(info?.arch || '').toLowerCase()
  if (raw.includes('aarch64') || raw.includes('arm64') || raw.startsWith('arm')) return 'arm'
  return 'x86'
}

/**
 * 从索引里挑「比当前新」的最高版本。
 *
 * <p>返回 null 表示没有更新（不是错误）。`release.packages` 里没有当前架构的包
 * 也要算"没有可用包"，由调用方提示——不能静默当成已是最新。
 */
export function pickLatest(
  index: FpkIndex,
  info: FpkShellInfo | null,
  current: string,
): { latest: FpkLatest } | { noPackage: true; version: string } | null {
  const releases = index.apps[FPK_APP_NAME]?.releases || {}
  const versions = Object.keys(releases).filter(
    (v) => isNewer(v, current) && !!releases[v],
  )
  if (!versions.length) return null
  const version = versions.sort((a, b) => (isNewer(a, b) ? 1 : -1)).at(-1) as string
  const release = releases[version]
  const arch = archKeyOf(info)
  const pkg = release.packages?.[arch]
  if (!pkg || !pkg.download_url) return { noPackage: true, version }
  return {
    latest: {
      version,
      release,
      pkg,
      url: resolveUrl(index.url, pkg.download_url),
      arch,
      notes: formatNoteLines(release.changelog || ''),
    },
  }
}

/**
 * 是不是 fpk 入口。
 *
 * <p>判据 = meowd 壳 + `/app-center/v1/app/installed` 能打通（后者只有 5666 网关有）。
 * 顺带把已安装信息拿回来，省一次请求。
 */
export async function detectFpkShell(): Promise<{
  info: FpkShellInfo
  installed: InstalledApp | null
} | null> {
  const info = await shellInfo()
  if (!info) return null
  try {
    const list = await acInstalled()
    const app = findApp(list)
    if (app) await fillVolume(app)
    return { info, installed: app }
  } catch {
    return null
  }
}

export interface InstalledApp {
  name: string
  version: string
  volumeID: number | null
  installType: string
}

function findApp(list: unknown): InstalledApp | null {
  const arr = Array.isArray(list)
    ? list
    : ((list as { list?: unknown[]; apps?: unknown[]; items?: unknown[] } | null)?.list ||
      (list as { apps?: unknown[] } | null)?.apps ||
      (list as { items?: unknown[] } | null)?.items ||
      [])
  for (const item of arr || []) {
    const o = item as Record<string, unknown>
    if (!o) continue
    const name = String(o.appName ?? o.name ?? o.appKey ?? o.id ?? '').trim()
    if (name !== FPK_APP_NAME) continue
    return {
      name,
      version: String(o.version ?? o.installedVersion ?? '').trim(),
      volumeID: Number(o.installedVolumeID ?? o.volumeID ?? 0) || null,
      installType: String(o.installType ?? o.type ?? '').trim(),
    }
  }
  return null
}

interface ShellAppDetail {
  ok?: boolean
  installVolumeID?: unknown
  installType?: unknown
}

/**
 * 回查应用所在卷（`app/installed` **恒缺**这些字段）。
 *
 * <p>★ 实测 1.1.2 / 1.1.3 两版、20 个字段的条目里没有
 * `installVolumeID` / `installType` / `volumeID` —— 这是该 HTTP 接口的固定形状，
 * 不是"暂时没返回"。而 `update/task` 的 `systemParameters.installVolumeID`
 * 必须是真实卷号，拿 0 顶替会把第三方应用装到系统分区。
 *
 * <p>卷号只在应用中心的 unix socket RPC 里，浏览器够不到，所以由 meowd 代查
 * （`/api/_shell/app/detail`，见 `meowd/src/appcenter.rs`）。壳那边 socket 不可用时
 * 会退回启动环境变量 `TRIM_APPDEST_VOL`，这里不用区分来源。
 */
async function fillVolume(app: InstalledApp): Promise<void> {
  if (app.volumeID != null) return
  let d: ShellAppDetail | null = null
  try {
    const res = await fetch(`${apiBase()}/api/_shell/app/detail?app=${FPK_APP_NAME}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return
    d = (await res.json()) as ShellAppDetail
  } catch {
    return
  }
  if (!d || !d.ok) return
  // root 类型应用合法地装在 0 号（系统分区）；其它类型只接受正整数卷号
  const root = String(d.installType || app.installType || '').toLowerCase() === 'root'
  const v = Number(d.installVolumeID)
  if (Number.isFinite(v) && (v > 0 || root)) app.volumeID = v
  if (!app.installType) app.installType = String(d.installType || '').trim()
}

/** app-center 业务错误（带错误码，UI 用 code 给人话提示） */
export class AppCenterError extends Error {
  code: number
  constructor(message: string, code = 0) {
    super(message)
    this.code = code
    this.name = 'AppCenterError'
  }
}

type AcBody = Record<string, unknown> | undefined

/**
 * 调应用中心。
 *
 * <p>★ 响应有两种形状：`{code:0,data:{…}}` 和直接 `{…}`。业务错误是
 * `code!=0 且没有 data`，必须抛出去——RROrg 的 fn-installer 也是这么判的，
 * HTTP 200 不代表安装成功，看 `update/status` 的状态码才算。
 */
async function ac<T = unknown>(path: string, body?: AcBody, timeoutMs = 30000): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/app-center/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      cache: 'no-store',
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new AppCenterError(`连不上应用中心（${(e as Error).message || '网络错误'}）`)
  }
  if (!res.ok) throw new AppCenterError(`应用中心返回 HTTP ${res.status}`)
  let json: Record<string, unknown>
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    throw new AppCenterError('应用中心返回的不是 JSON')
  }
  const code = Number(json.code || 0)
  if (code && json.data == null) {
    throw new AppCenterError(String(json.message || json.msg || `应用中心错误码 ${code}`), code)
  }
  return (json.data != null ? json.data : json) as T
}

async function acInstalled(): Promise<unknown> {
  return ac('app/installed?language=zh-CN', undefined, 8000)
}

function taskIdOf(res: unknown): string {
  const o = res as Record<string, unknown>
  const data = (o?.data as Record<string, unknown>) || o
  for (const v of [data?.installTaskId, data?.taskId, data?.id, data?.downloadTaskId]) {
    if (v != null && String(v).trim()) return String(v)
  }
  return ''
}

interface TaskStatus {
  status: number
  progress: number
  message: string
  data: Record<string, unknown>
}

function readStatus(res: unknown): TaskStatus {
  const o = (res || {}) as Record<string, unknown>
  const data = ((o.data as Record<string, unknown>) || o) as Record<string, unknown>
  const raw = data.status ?? data.installStatus ?? data.downloadStatus ?? o.status
  const status = Number(raw) || 0
  return {
    status,
    progress: Math.max(0, Math.min(100, Number(data.progress) || 0)),
    message: String(data.outputText || data.message || data.msg || o.message || '').trim(),
    data,
  }
}

/** 轮询直到完成；超时抛错（超时不是"失败"，但 UI 也只给一句人话） */
async function poll(
  fetchStatus: () => Promise<unknown>,
  opts: { timeoutMs: number; intervalMs: number; onTick?: (s: TaskStatus) => void },
): Promise<TaskStatus> {
  const deadline = Date.now() + opts.timeoutMs
  let last: TaskStatus = { status: 0, progress: 0, message: '', data: {} }
  while (Date.now() < deadline) {
    last = readStatus(await fetchStatus())
    opts.onTick?.(last)
    if (last.status === 2) return last
    if (last.status === 3 || last.status === 4 || last.status === 5) {
      throw new AppCenterError(
        last.message ||
          (last.status === 3
            ? '应用中心报告安装失败'
            : last.status === 4
              ? '任务被取消'
              : '任务不存在（可能已重启）'),
        last.status,
      )
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs))
  }
  throw new AppCenterError('等待应用中心响应超时，请稍后在应用中心里确认结果')
}

// ---------------------------------------------------------------- 流程

/**
 * 浏览器侧把 fpk 读成字节，带进度与 sha256 校验。
 *
 * <p>★ 不用 `response.blob()` 是为了进度：12MB 在局域网里也要几秒，
 * 没进度条的"立即更新"看起来像卡死。
 */
async function downloadFpkOne(
  url: string,
  size: number,
  sha: string,
  onProgress: (percent: number) => void,
): Promise<Uint8Array> {
  let res: Response
  // ★ 不用整体超时：实测 NAS 从 jsDelivr 拉 19.6MB 只有约 90 KB/s（2026-11-06），
  // 120 秒的整体超时会在 11MB 左右把下载掐断，报成"下载安装包失败（signal timed out）"。
  // 换成**停滞检测**：只有连续 60 秒没有新字节才中止。慢但还在走 ≠ 失败。
  const STALL_MS = 60_000
  const ctrl = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const bump = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => ctrl.abort(new Error(`超过 ${STALL_MS / 1000} 秒没有收到新数据`)), STALL_MS)
  }
  bump()
  try {
    res = await fetch(url, { cache: 'no-store', signal: ctrl.signal })
  } catch (e) {
    if (stall) clearTimeout(stall)
    throw new Error(`下载安装包失败（${(e as Error).message || '网络不可达'}）`)
  }
  if (!res.ok) {
    if (stall) clearTimeout(stall)
    throw new Error(`下载安装包失败：HTTP ${res.status}`)
  }

  const total = Number(res.headers.get('content-length')) || size || 0
  let received = 0
  try {
    if (res.body) {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bump()
          chunks.push(value)
          received += value.length
          if (total) onProgress(Math.min(99, Math.round((received / total) * 100)))
        }
      }
      const out = new Uint8Array(received)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.length
      }
      if (size && received !== size) {
        throw new Error(`安装包大小不符（期望 ${size}，实际 ${received}）`)
      }
      return out
    }
  } finally {
    if (stall) clearTimeout(stall)
  }
  // 老内核没有 streams：退化成一次性读取（没有进度，但能装）
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * 依次尝试候选；网络失败换下一个，sha256 不符由调用方统一判死（不换候选，防投毒）。
 */
async function downloadFpk(
  cands: AccelCandidate[],
  size: number,
  sha: string,
  onProgress: (percent: number) => void,
): Promise<Uint8Array> {
  let lastErr = ''
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    try {
      const bytes = await downloadFpkOne(c.url, size, sha, onProgress)
      markAccelResult(c, true)
      return bytes
    } catch (e) {
      markAccelResult(c, false)
      lastErr = (e as Error).message || String(e)
      if (i < cands.length - 1) onProgress(0)
    }
  }
  throw new Error(`下载安装包失败（已试 ${cands.length} 个地址）：${lastErr}`)
}

/** 交给 meowd 落盘，拿到应用中心可读的 NAS 绝对路径 */
async function saveFpk(bytes: Uint8Array, fileName: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(`${apiBase()}/api/_shell/upgrade/fpk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Meow-Filename': fileName,
      },
      body: bytes,
      signal: AbortSignal.timeout(60000),
    })
  } catch (e) {
    throw new Error(`保存安装包失败（${(e as Error).message || '网络中断'}）`)
  }
  if (!res.ok) {
    throw new Error(
      res.status === 413
        ? '保存安装包失败：网关拒绝了上传（包体超过限制）'
        : `保存安装包失败：HTTP ${res.status}`,
    )
  }
  const json = (await res.json()) as { ok?: boolean; path?: string; error?: string }
  if (!json.ok || !json.path) throw new Error(json.error || '保存安装包失败：壳没有返回路径')
  return json.path
}

function fileNameOf(latest: FpkLatest): string {
  const base = latest.pkg.download_url.split('/').pop() || ''
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_')
  return safe.endsWith('.fpk') ? safe : `meow_${latest.version}_${latest.arch}.fpk`
}

/** 升级失败时把人话原因给出来；错误码来自 fnOS `ErrCode` */
export function humanReason(e: unknown): string {
  const err = e as AppCenterError
  const code = Number(err?.code || 0)
  const map: Record<number, string> = {
    10236: '这个版本已经安装过了',
    10300: '应用中心里找不到已安装的 meow',
    10370: '没有可用的更新',
    10371: '该应用不允许更新',
    10372: '应用更新失败',
    10373: '升级初始化失败',
    10375: '应用正在更新中，请稍后再试',
    10376: '升级权限不足',
    10390: '该应用不允许卸载',
  }
  if (map[code]) return map[code]
  const msg = String(err?.message || e || '').trim()
  return msg || '升级失败（原因未知）'
}

/**
 * 执行一次升级。调用方只负责把 {@link FpkProgress} 画出来。
 *
 * @param latest      索引里挑出的目标版本
 * @param installed   应用中心里已安装的信息（取 installVolumeID / installType）
 * @param info        meowd 壳信息（取当前端口）
 */
export async function runFpkUpgrade(
  latest: FpkLatest,
  installed: InstalledApp | null,
  info: FpkShellInfo,
  onProgress: (p: FpkProgress) => void,
): Promise<void> {
  onProgress({ phase: 'downloading', percent: 0, text: '正在下载安装包…' })
  const cands = gitAccelCandidates(latest.url, getPrefs().gitAccel, {
    for: 'fpk',
    size: latest.pkg.size,
  })
  const bytes = await downloadFpk(cands, latest.pkg.size, latest.pkg.sha256, (percent) =>
    onProgress({ phase: 'downloading', percent, text: '正在下载安装包…' }),
  )

  onProgress({ phase: 'verifying', percent: 100, text: '校验安装包…' })
  if (latest.pkg.sha256) {
    const got = await sha256Hex(bytes)
    if (got.toLowerCase() !== latest.pkg.sha256.toLowerCase()) {
      throw new Error('安装包校验失败（sha256 与索引不一致），文件可能损坏，请重试')
    }
  }

  onProgress({ phase: 'saving', percent: 100, text: '保存到 NAS…' })
  const path = await saveFpk(bytes, fileNameOf(latest))

  onProgress({ phase: 'registering', percent: 0, text: '交给应用中心登记…' })
  const dl = await ac<Record<string, unknown>>(
    'download/task',
    { packageSourceType: 'file', path },
    30000,
  )
  const dlId = taskIdOf(dl)
  if (!dlId) throw new Error('应用中心没有返回下载任务号')
  const dlDone = await poll(() => ac(`download/status?downloadTaskId=${encodeURIComponent(dlId)}&language=zh-CN`, undefined, 15000), {
    timeoutMs: 180000,
    intervalMs: 1000,
    onTick: (s) =>
      onProgress({
        phase: 'registering',
        percent: s.progress,
        text: `应用中心登记中… ${s.progress}%`,
      }),
  })
  // packageType / updateVersion 都要用 download/status 给的"真实值"：
  // 官方前端与 RROrg 都是从登记结果里读（app.js:945-952 / 1660-1681），
  // 自己猜 "file"/"path" 或拿索引版本号会让 update/task 找不到已登记的包。
  const packageType = String(dlDone.data.packageType || 'file')
  const realVersion = String(dlDone.data.version || dlDone.data.app_version || latest.version)

  // 云端安装的应用不允许本地 fpk 升级（RROrg app.js:1028-1048 同判据）。
  const installedInfo = dlDone.data.installedInfo as Record<string, unknown> | undefined
  if (installedInfo && installedInfo.canUpgrade === false) {
    throw new AppCenterError('该应用是云端安装，不支持用本地安装包升级')
  }

  // 卷号必须真实：`app/installed` 不给，靠 fillVolume 回查补；两条都失败就中止。
  // 拿 0 顶替会让第三方应用被装到系统分区——宁可不升级也不能装错地方。
  const isRootApp = (installed?.installType || '').toLowerCase() === 'root'
  if (!isRootApp && !installed?.volumeID) {
    throw new AppCenterError(
      '读不到应用所在的存储卷，为避免装错分区已中止；请到应用中心手动更新',
    )
  }

  onProgress({ phase: 'installing', percent: 0, text: '正在升级，服务会重启…' })
  const upd = await ac<Record<string, unknown>>(
    'update/task',
    {
      appName: FPK_APP_NAME,
      packageType,
      updateVersion: realVersion,
      systemParameters: {
        agreedToProtocol: true,
        // root 应用装系统分区（0）；第三方应用跟已装卷走
        installVolumeID: (installed?.installType || '').toLowerCase() === 'root' ? 0 : installed?.volumeID || 0,
        dataVolumeId: installed?.volumeID || 0,
        immediateStart: true,
      },
      // wizard 三项是硬性必填（实测缺一个 update/task 直接报 10030）。
      // 端口回填当前值，避免升级把用户改过的端口重置成默认。
      // `wizard_library_mode` 全仓只有 wizard 声明、没有脚本消费（升级流程也不跑
      // config_init），所以固定 share 不会覆盖用户原有选择；若将来有脚本读它，
      // 这里必须改成从当前配置回填。
      customParameters: [
        { key: 'wizard_port', value: String(info.port || 30010) },
        { key: 'wizard_api_port', value: String(info.apiPort || 30011) },
        { key: 'wizard_library_mode', value: 'share' },
      ],
    },
    60000,
  )
  const updId = taskIdOf(upd)
  if (!updId) throw new Error('应用中心没有返回升级任务号')
  await poll(
    () =>
      ac(
        'update/status',
        { taskId: updId, language: 'zh-CN' },
        15000,
      ),
    {
      timeoutMs: 600000,
      intervalMs: 1500,
      onTick: (s) =>
        onProgress({
          phase: 'installing',
          percent: s.progress,
          text: `正在升级… ${s.progress}%`,
        }),
    },
  )
  onProgress({ phase: 'done', percent: 100, text: '升级完成' })
}

/**
 * 升级完成后等新进程起来。
 *
 * <p>应用中心返回 success 时服务往往还在重启，直接 reload 会拿到半截静态资源
 * 或 502。这里轮询 `/api/health`（经壳转发到 Java），通了再刷。
 */
export async function waitForRestart(timeoutMs = 90000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase()}/api/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; shell?: { version?: string } }
        if (json?.ok) return true
      }
    } catch {
      /* 重启中连不上是正常的 */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}
