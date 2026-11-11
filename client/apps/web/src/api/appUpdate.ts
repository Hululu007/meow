/**
 * 应用自身的在线更新（PC / TV）。
 *
 * ## 为什么复用插件的清单格式
 *
 * 插件那套（`packages.json`：`version` / `sha256` / `url`）已经跑通了
 * 「版本比对 → 下载 → 校验 → 安装」全链路，而且用户手上可能已经配了
 * 一个插件源。另造一份更新清单等于让用户再配一个地址，没有收益。
 *
 * ## 为什么用两个 id 而不是一条带多平台的记录
 *
 * 清单里的单个包只有**一个 url + 一个 sha256**。Windows 要 exe、Android 要 apk，
 * 一条记录装不下两个安装包——写成 `platform: [windows, android]` +
 * 单个 url 会让 Windows 客户端去下 apk。所以按平台分两条：
 *
 * ```json
 * "packages": {
  *   "meow-pc": { "version": "0.9.30", "platform": ["windows-x64"],  "url": "meow-setup-0.9.30.exe", ... },
  *   "meow-tv": { "version": "0.9.30", "platform": ["android-arm64"], "url": "meow-tv-0.9.30.apk",     ... }
 * }
 * ```
 *
 * 两条都必须 `hidden: true`，否则会出现在「本机插件」的可安装列表里
 * （那边只过滤 `hidden`），用户点了会走插件安装器、解压找不到 `manifest.json` 而失败。
 *
 * ## 为什么清单和下载都在原生做（★ 换 GitHub 后才成立的关键）
 *
 * 早期版本是页面 XHR 下载、base64 过桥交给原生。换成 GitHub Release 后必然失败：
 *
 * | 位置 | 实测 | 后果 |
 * |---|---|---|
 * | Release 资产 | 最终 200 **无** `Access-Control-Allow-Origin` | 页面 XHR 被浏览器拦 |
 * | `raw.githubusercontent` + `Authorization` | 预检回 **403**，无 `Allow-Headers` | 私有仓的 token 发不出去 |
 * | 11MB apk 过桥 | base64 ≈ 15MB 字符串 | 无谓开销，TV 上勉强 |
 *
 * 所以：**清单读取、下载、校验全在原生**（PC 走 `appupdate.rs`，TV 走 `AppUpdater.java`），
 * 页面只负责比版本、展示、点按钮。
 *
 * ## 安全边界（刻意如此）
 *
 * - **必须校验 sha256，失败必须中止**（在原生侧校验，不匹配的包不落盘）
 * - 只接受 `http(s)` 地址（两端原生都做校验）
 * - **绝不静默安装**：只提示 + 用户点击。静默替换应用自己在本机执行场景下
 *   等于给了远端任意代码执行能力
 * - token 只进原生的请求头，**不进 URL、不进日志**
 */

import { getPrefs, savePrefs } from '../stores/prefs'
import { getPluginSource } from '@/api'
import {
  DEFAULT_GIT_ACCEL,
  gitAccelCandidates,
  markAccelResult,
  type GitAccelPrefs,
} from './gitAccel'

/**
 * 清单里代表「应用自身」的保留 id。
 *
 * <p>用品牌名 `meow` 而不是 `app`：清单是给用户看的（他可能手写、也可能
 * 在浏览器里直接打开它排查问题），`meow-pc` / `meow-tv` 一眼知道是什么。
 * 其它条目也是品牌化的（`apiserver` / `danmu-api` / `drpy`），这里跟着统一。
 */
/** PC 装机包条目 */
export const APP_PC_ID = 'meow-pc'
/** TV / Android 装机包条目 */
export const APP_TV_ID = 'meow-tv'
/** 旧版单条记录 + 更早的 `app-pc`/`app-tv`，仅为兼容读取 */
export const LEGACY_APP_IDS = ['app', 'app-pc', 'app-tv'] as const
export const APP_PACKAGE_ID = 'app'

/** 当前构建的版本号（Vite 注入，见 vite.config.ts 的 define） */
export function currentVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  } catch {
    return ''
  }
}

/** 当前运行平台（决定用哪个保留 id / 挑清单里哪一条） */
export type AppPlatform = 'windows-x64' | 'android-arm64' | 'android-armv7' | 'android-x86_64' | 'web'

/**
 * 内置 GitHub 加速代理（按实测速度排序，失败自动换下一个）。
 *
 * 为什么要内置：从本机到 github.com 的 TLS 握手经常超时
 * （实测 gh 命令连续两次 net TLS handshake timeout，客户端也一样会卡住）。
 * 加一层代理后同一次下载从 12-33s 降到 0.6s。
 *
 * 实测数据（2026-10-29，同一份约 15MB release 资产）：
 *   gh.llkk.cc     200/200/200          0.6-1.3s          Range 206
 *   gh-proxy.com   200/200/200          0.8-15.9s（抖动大） Range 206
 *   ghproxy.net    200/000/000          超时               已降级不推荐
 *
 * 2026-11-09 复测：这些代理对 raw.githubusercontent.com 也可用；新逻辑统一走
 * `gitAccelCandidates`（全局列表），这里的常量只保留给旧脚本/测试。
 */
/**
 * 旧版内置代理（保留导出，兼容外部脚本/测试）。新逻辑一律读全局 `gitAccel`。
 */
export const GITHUB_PROXIES = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
] as const

/** 判断是否是 GitHub release 资产下载地址 */
export function isGitHubDownloadUrl(url: string): boolean {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//i.test(url)
}

function currentAccel(): GitAccelPrefs {
  try {
    return getPrefs().gitAccel || DEFAULT_GIT_ACCEL
  } catch {
    return DEFAULT_GIT_ACCEL
  }
}

/**
 * 给一个 GitHub 地址生成候选列表（直连 + 全局代理 + raw 的 jsDelivr）。
 *
 * <p>只对公开地址生效：`api.github.com` 默认不挂代理（私有仓 token 请求）。
 * 公开仓的 API 由调用方显式传 `allowApi` 的候选函数处理。
 */
export function downloadCandidates(url: string, accel: GitAccelPrefs = currentAccel()): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of gitAccelCandidates(url, accel, { for: 'appUpdate' })) {
    if (seen.has(c.url)) continue
    seen.add(c.url)
    out.push(c.url)
  }
  return out.length ? out : [url]
}

/** TV 原生桥（只需这几个方法；老壳可能没有） */
interface UpdaterBridge {
  appUpdaterPlatform?(): string
  appUpdateManifest?(url: string, token: string): string | null
  appUpdateError?(): string
  appUpdateDownload?(url: string, sha: string, token: string, fileName: string): string
  appUpdateState?(): string
  appUpdateCancel?(): boolean
  appUpdateInstall?(): string
  appUpdateClearCache?(): number
}

interface TauriInternals {
  __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> }
}

function tvBridge(): UpdaterBridge | null {
  try {
    const b = (window as unknown as { meowTv?: UpdaterBridge }).meowTv
    // 用方法存在性判断，不用 `if (b)`：老壳没有这些方法
    return b && typeof b.appUpdateManifest === 'function' ? b : null
  } catch {
    return null
  }
}

function tauriInvoke(): ((cmd: string, args?: unknown) => Promise<unknown>) | null {
  try {
    const inv = (window as unknown as TauriInternals).__TAURI_INTERNALS__?.invoke
    return typeof inv === 'function' ? inv : null
  } catch {
    return null
  }
}

/** 是否跑在 Tauri 桌面端 */
export function isDesktopShell(): boolean {
  return tauriInvoke() !== null
}

/**
 * 当前平台。
 *
 * <p><b>为什么 x86_64 单独一档</b>：模拟器（MuMu/AVD）报 `x86_64`，
 * 归到 armv7 会让清单永远匹配不上（装不上的包 = `INSTALL_FAILED_NO_MATCHING_ABIS`）。
 * 归到自己的档位后，清单里没写 `android-x86_64` 就明确"没有可用更新"，
 * 比下错包好。
 */
export function currentPlatform(): AppPlatform {
  if (isDesktopShell()) return 'windows-x64'
  try {
    const b = (window as unknown as { meowTv?: UpdaterBridge }).meowTv
    if (b && typeof b.appUpdaterPlatform === 'function') {
      const p = String(b.appUpdaterPlatform())
      if (p === 'arm64' || p === 'arm64-v8a') return 'android-arm64'
      if (p === 'x86_64' || p === 'x86') return 'android-x86_64'
      if (p) return 'android-armv7'
    }
  } catch {
    /* 探测失败按 web 处理 */
  }
  return 'web'
}

/** 平台 → 清单里的保留 id */
export function packageIdFor(platform: AppPlatform): string {
  return platform === 'windows-x64' ? APP_PC_ID : APP_TV_ID
}

/** 平台家族（决定"能不能装"的只有两个维度，架构细分在这里不重要） */
export type PlatformFamily = 'windows' | 'android' | 'web'

/** 把具体平台归到家族 */
export function familyOf(platform: AppPlatform): PlatformFamily {
  if (platform === 'windows-x64') return 'windows'
  if (platform === 'web') return 'web'
  return 'android'
}

/**
 * 从清单条目的 id 推出它属于哪个平台家族；推不出返回 null。
 *
 * <p><b>为什么需要按 id 判断，而不只信 `platform` 数组</b>：
 * `platform` 是清单里手写/脚本生成的**可选**字段。旧条目（`app` 单条记录、
 * 早期手工维护的清单）经常没有这个字段，而原来的判据是
 *
 * ```js
 * if (pkg.platform && pkg.platform.length && !pkg.platform.includes(platform)) continue
 * ```
 *
 * 当 `platform` 为空时前两个条件都是 false，整个 `&&` 为 false —— **直接放行**。
 * 于是 PC 端会把 APK 下下来（13MB 白流量 + 安装器报"不是有效的 Win32 应用"）。
 * 更糟的是 `LEGACY_APP_IDS` 里同时有 `app-pc` 和 `app-tv`，
 * 所以 PC 的候选列表**本来就会包含 TV 条目**。
 *
 * <p>id 是清单的**结构**，比可选的 platform 数组可靠：`meow-pc` 就是 PC，
 * `meow-tv` 就是 Android。两者冲突时以 id 为准。
 */
export function platformOfPackageId(id: string): PlatformFamily | null {
  const s = (id || '').trim().toLowerCase()
  if (!s) return null
  if (s.endsWith('-pc')) return 'windows'
  if (s.endsWith('-tv')) return 'android'
  // 旧的单条记录 `app`：当年 PC/TV 共用一条，平台只能看 platform 数组
  return null
}

/**
 * 从安装包地址的扩展名推平台家族；推不出返回 null。
 *
 * <p><b>为什么还要这一层</b>：id 和 platform 都是清单里的**声明**，可以写错，
 * 也可以被自建源手写乱。而"装错包"的物理后果只有扩展名能兜住 ——
 * Windows 只认 `.exe/.msi`，Android 只认 `.apk`。
 *
 * <p>推不出时（自建源用自定义文件名、或带查询串的下载端点）返回 null，
 * 由调用方决定放不放行 —— 不做"猜"，猜错比不判更糟。
 */
export function platformOfUrl(url: string): PlatformFamily | null {
  // 去掉 query 和 hash 后再看扩展名：`/a.apk?token=x` 也要认出来
  const path = (url || '').split('?')[0].split('#')[0].trim().toLowerCase()
  if (!path) return null
  if (/\.(exe|msi)$/.test(path)) return 'windows'
  if (/\.apk$/.test(path)) return 'android'
  return null
}

/**
 * 清单条目能不能装到当前设备上（三层判据，任一层否决就跳过）。
 *
 * <p>三层都要，因为它们拦的是不同的错误：
 * 1. **id** —— 拦「清单里 meow-pc 条目缺失、只剩 meow-tv」这类结构性错配
 * 2. **platform 数组** —— 拦「同一条目声明了具体 ABI，但本机 ABI 不在里面」
 *    （模拟器 x86_64 装 arm64 包会 `INSTALL_FAILED_NO_MATCHING_ABIS`）
 * 3. **扩展名** —— 拦前两者都写错时仍然可能发生的「PC 下到 apk」
 *
 * @param id       清单里的条目 id（meow-pc / meow-tv / app-pc / app-tv / app）
 * @param platforms 条目声明的平台数组（可缺失）
 * @param cur      当前设备平台
 */
export function entryFitsPlatform(
  id: string,
  platforms: string[] | undefined,
  cur: AppPlatform,
): boolean {
  if (cur === 'web') return false
  const want = familyOf(cur)

  // ① id 隐含的平台：结构性判据，与 platform 数组冲突时以它为准
  const byId = platformOfPackageId(id)
  if (byId && byId !== want) return false

  // ② platform 数组存在时必须包含当前平台（精确到架构，不只到家族）
  const list = (platforms || []).filter((x): x is string => typeof x === 'string' && !!x)
  if (list.length) {
    if (!list.includes(cur)) return false
  } else if (!byId) {
    /*
     * ③ 既没有 platform 数组，id 也推不出平台（只有旧的 `app` 单条会走到这里）。
     *
     * 这里是**刻意选择"宁可不下"**：下错包的代价（13MB 流量 + 安装器报错 +
     * 用户以为应用坏了）远大于"这次没提示更新"。旧 `app` 条目当年是
     * PC/TV 共用一条，平台信息只存在于 platform 数组里，没有就只能拒。
     */
    return false
  }
  return true
}

/**
 * 比较两个语义化版本，返回 a 是否比 b 新。
 *
 * 只认 `主.次.修订`，忽略 `-beta` 这类后缀（我们的版本号没有预发布）。
 * 不用字符串比较：`0.9.10` 与 `0.9.9` 字符串比会把 9 判成更大。
 */
export function isNewer(a: string, b: string): boolean {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/** 一个可用的更新 */
export interface AppUpdate {
  /** 新版本号 */
  version: string
  /** 下载地址（已按清单的 base 解析成绝对地址） */
  url: string
  sha256: string
  size: number
  notes?: string
  /**
   * 这一版是什么时候发的（清单里的 `lasttime`，形如 2026-11-04）。
   *
   * <p>用户判断"要不要现在更新"时会看日期：同一个版本号反复弹框、
   * 或者隔了很久才看到，没有日期就只能靠猜。清单生成时间就是发布日。
   */
  lasttime?: string
  /** 清单里命中的 id（meow-pc / meow-tv），下载时用来挑文件名 */
  packageId?: string
}

/**
 * 把清单里的更新说明拆成「带序号的行」。
 *
 * <p>CHANGELOG 现在按 `1. 2. 3.` 写；git log 兜底来源没有序号，这里统一补上。
 * 用户看到的永远是有序列表——"第几条"能直接对上，也方便只看前 4 条时知道还有多少。
 *
 * <p>已经写了序号的（`1.` / `1、` / `1)`）原样保留，避免出现「1. 1. xxx」。
 */
export function formatNoteLines(notes: string): string[] {
  return (notes || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => (/^\d+\s*[.、)]/.test(s) ? s : `${i + 1}. ${s}`))
}

/**
 * 把 GitHub **私有仓**的标准下载链接转成 API 资产端点。
 *
 * <p><b>为什么必须转换</b>（实测 2026-10-29，upchr/meow 为 private）：
 *
 * | 地址 | 匿名 | 带 token |
 * |---|---|---|
 * | `github.com/<o>/<r>/releases/download/<tag>/<file>` | 404 | **404** |
 * | `api.github.com/repos/<o>/<r>/releases/assets/<id>` | 404 | **200** |
 *
 * 标准下载链接对私有仓**根本不工作**，带 token 也一样。所以清单里若写的是
 * 标准链接，配置了 token 时要换成 API 端点。
 *
 * <p>代价：需要先用 API 查一次 tag 的资产列表拿 asset id。这次查询走原生
 * （`app_update_manifest_text` 同一条 curl 通道），所以同样带 token。
 * 查不到就退回原地址——公开仓不需要转换，原地址本来就通。
 *
 * @param url   清单里的下载地址
 * @param token 访问令牌（空 = 公开仓，不需要转换）
 * @returns 可直接下载的地址（转换成功用 API 端点，失败退回原地址）
 */
export async function toDownloadableUrl(url: string, token: string): Promise<string> {
  if (!token.trim()) return url // 公开仓：标准链接本来就能下
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(url)
  if (!m) return url
  const [, owner, repo, tag, file] = m
  try {
    const api = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
    // ★ 必须走 fetchRawText 而不是 fetchManifestText——
    //   tags 端点本身**也是** release 端点（能被 isReleaseEndpoint 匹配），
    //   走 fetchManifestText 会被当成"要去里面找 packages.json"，
    //   而这里要的是它的原始 JSON（资产列表）。踩过：这样写会让
    //   toDownloadableUrl 静默失败，退回标准链接（私有仓 404）。
    const text = await fetchRawText(api, token)
    const rel = JSON.parse(text) as { assets?: Array<{ id: number; name: string }> }
    const hit = (rel.assets || []).find((a) => a.name === decodeURIComponent(file))
    if (hit?.id) {
      // 文件名要留着：原生侧靠它决定落盘的扩展名
      return `https://api.github.com/repos/${owner}/${repo}/releases/assets/${hit.id}`
    }
  } catch {
    /* 查不到就退回原地址：可能不是私有仓，或 token 无权访问 */
  }
  return url
}

/** 原生返回的条目形状（两端同构） */
interface NativeEntry {
  version?: string
  url?: string
  sha256?: string
  size?: number
  desc?: string
  platform?: string[]
  lasttime?: string
}

/**
 * 把清单里的相对 url 解析成绝对地址。
 *
 * 清单里 `url` 通常是相对文件名（`meow-tv-0.9.30.apk`），与清单同目录。
 * 不解析的话请求会打到页面自己的 origin（TV 上是 meow.local，直接 404）。
 */
export function resolveUrl(base: string, rel: string): string {
  if (!rel) return ''
  if (/^https?:\/\//i.test(rel)) return rel
  if (!base) return ''
  try {
    return new URL(rel, base).toString()
  } catch {
    return ''
  }
}

const SOURCE_KEY = 'meow.updateSource'
const TOKEN_KEY = 'meow.updateToken'

function readLs(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeLs(key: string, v: string): void {
  try {
    if (v) localStorage.setItem(key, v)
    else localStorage.removeItem(key)
  } catch {
    /* 无 localStorage 环境 */
  }
}

/**
 * 内置默认更新源（repo 级固定地址，不需要发版时改）。
 *
 * <p><b>为什么必须内置</b>：没有它，全新安装的 TV 上「检查更新」是**静默空转**
 * ——`getUpdateSource()` 的三档里，手填为空、`plugin_source` 在 TV/Web 恒空串，
 * 于是 `checkAppUpdate()` 直接 `return null`，界面显示"已是最新版本"，
 * 而实际上一次网络请求都没发出去。用户以为功能坏了。
 *
 * <p>写成 `releases/latest` 只是**入口**：真正取的是「已发布 + 含
 * packages.json + 版本最大」那条（见 pickManifestRelease）。所以补发旧版
 * hotfix 把 latest 顶回去也不会让客户端降级。
 *
 * <p>优先级：手填 > 内置 > 插件源。手填放最前是为了让自建文件服务器
 * 和内部测试能整体覆盖，不需要动构建。
 */
export const DEFAULT_UPDATE_SOURCE =
  'https://api.github.com/repos/upchr/meow/releases/latest'

/** 构建期可覆盖（`__UPDATE_SOURCE__`，见 vite.config.ts）；未注入时用上面的常量 */
function builtinSource(): string {
  try {
    const v = typeof __UPDATE_SOURCE__ === 'string' ? __UPDATE_SOURCE__ : ''
    if (v.trim()) return v.trim()
  } catch {
    /* 未注入 */
  }
  return DEFAULT_UPDATE_SOURCE
}

/**
 * 读更新源：用户自填 > 内置默认 > 插件的当前源。
 *
 * <p><b>为什么不能只用插件源</b>：`plugin_source` 是 Tauri 命令，TV/Web 上
 * 恒返回空串（实测 TV 上「检查更新」永远显示"已是最新版本"——因为压根没去拉清单）。
 * 所以必须给 TV 一个可用的来源，落地在 localStorage。
 */
export async function getUpdateSource(): Promise<string> {
  // 手填优先；先读 Prefs（手机推送能带过来），legacy localStorage 兜底旧数据
  const manual = (getPrefs().updateSource || readLs(SOURCE_KEY) || '').trim()
  if (manual) return manual
  // 内置源先于插件源：插件源在 TV/Web 上恒空，放在前面等于没配
  const builtin = builtinSource()
  if (builtin) return builtin
  try {
    return (await getPluginSource()) || ''
  } catch {
    return ''
  }
}

/**
 * 「稍后」记住的版本号。
 *
 * <p><b>为什么按版本号记而不是按时间</b>：用户说"稍后"的意思是"这个版本我
 * 现在不装"，不是"一小时后再问我"。按时间记会在播放中途反复弹，按版本记
 * 则只在**出现更高的版本**时再提示一次。
 *
 * <p>不写进 prefs：那是用户可见、可导出、会被 WebDAV 同步的设置项；
 * 这一条是一次性的交互记忆，换设备后重新提示一次更合理。
 */
const SKIP_VERSION_KEY = 'meow.update.skipVersion'

/** 用户是否已经对这个版本说过「稍后」 */
export function isVersionSkipped(version: string): boolean {
  return !!version && readLs(SKIP_VERSION_KEY) === version
}

/** 记住「稍后」（下次只有更高版本才再提示） */
export function skipVersion(version: string): void {
  writeLs(SKIP_VERSION_KEY, version || '')
}

/** 清掉「稍后」记录（设置页手动检查时用：用户主动问就不该被挡住） */
export function clearSkippedVersion(): void {
  writeLs(SKIP_VERSION_KEY, '')
}

/** 写更新源（空串表示清除，回退到插件源） */
export function setUpdateSource(url: string): void {
  const v = (url || '').trim()
  // 写 Prefs（推送会带走）+ legacy localStorage（旧路径仍可能读它）
  savePrefs({ updateSource: v })
  writeLs(SOURCE_KEY, v)
}

/**
 * 显式备用更新源（空串 = 不启用）。
 *
 * 只有用户明确填写才会在主源失败后尝试；**不会**自动回落官方源。
 * 自定义源可能来自 fork / 内网 / 测试版，静默换源会提示错误版本。
 */
export function getBackupUpdateSource(): string {
  return (getPrefs().updateBackupSource || '').trim()
}

export function setBackupUpdateSource(url: string): void {
  savePrefs({ updateBackupSource: (url || '').trim() })
}

/**
 * 读访问令牌（私有仓用；空串表示匿名）。
 *
 * <p>PC 上优先用原生存的那份（`%APPDATA%/com.meow.player/plugin-token.txt`），
 * 这样插件源和应用更新**共用同一个令牌**——用户只填一次。
 * 原生没有时才退回 localStorage（TV 没有原生 token 存储，走这条）。
 */
export function getUpdateToken(): string {
  return (getPrefs().updateToken || readLs(TOKEN_KEY) || '').trim()
}

/**
 * 写访问令牌。
 *
 * <p>两处都写：localStorage（TV / 立即生效）+ 原生文件（PC，插件安装器也要用）。
 * 只写 localStorage 的话，PC 上插件源仍然读不到私有仓。
 */
export function setUpdateToken(token: string): void {
  const t = (token || '').trim()
  savePrefs({ updateToken: t })
  writeLs(TOKEN_KEY, t)
  const inv = tauriInvoke()
  if (inv) {
    // 失败不抛：令牌存不进原生时，应用更新这条仍能用 localStorage 里的那份
    void inv('plugin_token_set', { token: t }).catch(() => {})
  }
}

/** 从原生读插件源令牌（PC 上与应用更新共用一份）。 */
export async function getNativeToken(): Promise<string> {
  const inv = tauriInvoke()
  if (!inv) return ''
  try {
    return String((await inv('plugin_token_get')) || '').trim()
  } catch {
    return ''
  }
}

/** 清单在 Release 里的资产名（与 deploy/scripts/sync-packages.ps1 约定一致） */
export const MANIFEST_ASSET_NAME = 'packages.json'

/**
 * 判断是不是 GitHub 的「releases/latest」这类**列表端点**（而不是清单本身）。
 *
 * <p>这类端点返回的是一份描述 release 的 JSON（资产名 / id / digest 等），
 * 里面的 `packages.json` 是一个资产，内容要再拉一次。
 *
 * <p>★ **只匹配 `latest`，不要匹配 `tags/<tag>`**。两者都能列资产，
 * 但 `tags/*` 在别处（`toDownloadableUrl`）被用于**另一件事**：
 * 查某个具体 tag 的资产 id 来拼下载地址。若这里也把它当成"清单端点"，
 * 那条路径会去找 `packages.json`（那里没有），静默失败后退回标准链接
 * （私有仓 404）。踩过。
 *
 * <p>用户也可以填 `.../releases/tags/<tag>` 当更新源（钉版本），
 * 那时它确实该被当清单端点——见 `manifestEndpointKind`。
 */
export function isReleaseEndpoint(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest\/?$/i.test(url.trim())
}

/**
 * 用户填的地址是不是「某个具体 tag 的 release」。
 *
 * <p>当更新源用它时，语义与 `latest` 相同（去里面找 packages.json）；
 * 但在 `toDownloadableUrl` 里它只用来查资产 id。所以两处不能共用一个判断。
 */
export function isTagReleaseEndpoint(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/tags\/[^/]+\/?$/i.test(
    url.trim(),
  )
}

/** release 列表里的一条（只声明用到的字段） */
interface ReleaseListItem {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string | null
  assets?: Array<{ id?: number; name?: string }>
}

/**
 * 壳更新只看壳 tag。
 *
 * 模块（18.20.4.x）和插件批次是独立版本线；它们的 Release 里也有
 * `packages.json`（由 sync-packages 生成），但 tag 数字远大于壳版本。
 * 如果混进来，`pickManifestRelease` 会永远选中模块 Release，导致壳
 * 永远看不到真正的新版本。
 */
export function isShellReleaseTag(tag: string): boolean {
  const t = String(tag || '').trim()
  return !/^(tv-plugins|plugins|docker|fpk)-v/i.test(t)
}

/**
 * 从 release 列表里挑出「应该用来做更新源」的那一个。
 *
 * <p><b>为什么不直接用 `/releases/latest`</b>（2026-10-29 加固）：
 * GitHub 的 latest 有四个坑，每一个都会让更新链路失效：
 *
 * 1. **按发布时间挑，不按版本号**。给旧版补一个 hotfix（比当前版晚发），
 *    latest 会**退回**旧版，所有客户端被"降级"。
 * 2. **draft 完全不参与**。`release.yml` 建的是 draft，忘了点 Publish
 *    就永远看不到。
 * 3. **不检查里面有没有清单**。历史上没有 `packages.json` 的 release
 *    一旦成为 latest，客户端会报"该 release 里没有 packages.json"——
 *    **整个更新链路瘫痪**，不只是插件没了。
 * 4. 私有仓 + 网络抖动时 latest 端点还会偶发 5xx。
 *
 * <p>所以自己挑：**非 draft、非 prerelease、有 packages.json 资产，
 * 然后按 tag 里的版本号取最大**。
 *
 * @param listJson `/releases` 返回的 JSON 数组文本
 * @returns 选中那条 release 的 tag；挑不出来返回空串
 */
export function pickManifestRelease(listJson: string): string {
  let list: ReleaseListItem[]
  try {
    const parsed = JSON.parse(listJson)
    list = Array.isArray(parsed) ? parsed : []
  } catch {
    return ''
  }
  const candidates = list.filter(
    (r) =>
      r &&
      !r.draft &&
      !r.prerelease &&
      typeof r.tag_name === 'string' &&
      isShellReleaseTag(r.tag_name) &&
      (r.assets || []).some((a) => a?.name === MANIFEST_ASSET_NAME),
  )
  if (!candidates.length) return ''
  // 按 tag 里的版本号**降序**排（不是按发布时间），取最大的
  candidates.sort((a, b) => tagVersionCmp(b.tag_name || '', a.tag_name || ''))
  return candidates[0].tag_name || ''
}

/**
 * 比较两个 tag 里的版本号：返回正数表示 a 更新。
 *
 * `<p>`抽数字段逐位比较（`release-v0.9.10` > `release-v0.9.9`），
 * 字符串比较会把 `'10' < '9'` 判反。
 */
function tagVersionCmp(a: string, b: string): number {
  const pa = (a.match(/\d+/g) || []).map((x) => parseInt(x, 10))
  const pb = (b.match(/\d+/g) || []).map((x) => parseInt(x, 10))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y // 正数 = a 更新
  }
  return 0
}

/**
 * 从 release 端点里找出清单资产的下载地址。
 *
 * @returns 可直接拉的资产地址；找不到返回空串
 */
export function manifestAssetUrlFrom(relJson: string, token = ''): string {
  try {
    const j = JSON.parse(relJson) as {
      assets?: Array<{ id?: number; name?: string; browser_download_url?: string }>
    }
    const hit = (j.assets || []).find((a) => a?.name === MANIFEST_ASSET_NAME)
    if (!hit) return ''
    // 私有仓必须走 API 资产端点（标准 download 链接带 token 也是 404，实测）；
    // 公开仓（无 token）优先 browser_download_url——这样 downloadCandidates
    // 的代理才会对 github.com/.../releases/download/... 生效。
    if (!token.trim() && hit.browser_download_url) return hit.browser_download_url
    if (hit.id) return `https://api.github.com/repos/${repoOf(relJson)}/releases/assets/${hit.id}`
    return hit.browser_download_url || ''
  } catch {
    return ''
  }
}

// 重复声明已清理（MANIFEST_ASSET_NAME 在文件上方定义一次即可）

/** 从 release JSON 里取 owner/repo（用于拼 API 资产地址） */
function repoOf(relJson: string): string {
  try {
    const j = JSON.parse(relJson) as { url?: string }
    // url 形如 https://api.github.com/repos/<owner>/<repo>/releases/<id>
    const m = /\/repos\/([^/]+\/[^/]+)\/releases\//.exec(j.url || '')
    if (m) return m[1]
  } catch {
    /* 落到空 */
  }
  return ''
}

/**
 * 取清单原文。两端都走原生——页面的 fetch 会在 GitHub 上被 CORS 拦。
 *
 * @param url 清单地址，或 release 端点（会自动再取一层资产内容）
 * @returns JSON 文本
 */
export const DEFAULT_MIRROR_SOURCE =
  'https://raw.githubusercontent.com/upchr/meow/updates/packages.json'

/** 是否官方私有仓的 release 端点（决定要不要试公开静态清单兜底） */
function isOfficialReleaseSource(url: string): boolean {
  return /^https:\/\/api\.github\.com\/repos\/upchr\/meow\/releases\//i.test(url.trim())
}

/**
 * 按全局加速候选拉一段原生文本（清单/资产）。
 *
 * <p>`allowApi` 只对公开源置 true；私有仓 token 请求一律直连。
 */
async function fetchRawTextCandidates(
  url: string,
  token: string,
  opts: { allowApi?: boolean; index?: boolean } = {},
): Promise<string> {
  const accel = currentAccel()
  const cands = gitAccelCandidates(url, accel, {
    for: 'appUpdate',
    allowApi: !!opts.allowApi && !token.trim(),
    index: !!opts.index,
  })
  let last = ''
  for (const c of cands) {
    try {
      const text = await fetchRawText(c.url, token)
      markAccelResult(c, true)
      return text
    } catch (e) {
      markAccelResult(c, false)
      last = (e as Error).message || String(e)
    }
  }
  throw new Error(last || `拉取失败：${url}`)
}

async function fetchManifestText(url: string, token: string): Promise<string> {
  let firstErr: unknown = null
  try {
    return await fetchManifestPrimary(url, token)
  } catch (e) {
    firstErr = e
  }

  // ① 用户显式配置的备用源（不会回落到官方源）
  const backup = getBackupUpdateSource()
  if (backup && backup !== url) {
    try {
      return await fetchManifestPrimary(backup, token)
    } catch {
      /* 备用源也失败，继续试官方静态清单 */
    }
  }

  // ② 官方源失败时试公开静态清单（开源前 404，开源后可用）
  if (isOfficialReleaseSource(url)) {
    try {
      // index: true 允许 jsDelivr；静态清单是小文件，和 release 资产不同
      const mirror = await fetchRawTextCandidates(DEFAULT_MIRROR_SOURCE, '', { index: true })
      const doc = JSON.parse(mirror) as { packages?: Record<string, unknown> }
      if (doc && doc.packages) return mirror
    } catch {
      /* 镜像也不可用：抛原始错误 */
    }
  }
  throw firstErr instanceof Error ? firstErr : new Error(String(firstErr || '拉取更新清单失败'))
}

async function fetchManifestPrimary(url: string, token: string): Promise<string> {
  let target = url

  // ★ 方案：清单做成 Release 资产，客户端填 **repo 级固定地址**
  //   `https://api.github.com/repos/<o>/<r>/releases/latest`
  //   为什么要多这一层：清单若进 git，每次发版都要往 main 提交一次，
  //   用户本地每次都得 pull（这是被明确否掉的摩擦）。挂 Release 后
  //   git 完全不碰，而地址里没有 asset id，所以永远不用改。
  //
  //   ★ 加固（2026-10-29）：`latest` 端点**不直接用**，改成拉 `/releases`
  //     列表后自己挑（见 pickManifestRelease 的注释）。理由：
  //       · latest 按发布时间挑 → 补发旧版 hotfix 会让客户端"降级"
  //       · latest 不检查有没有 packages.json → 落到没清单的 release
  //         上会让**整个更新链路**瘫痪（不只是插件没了）
  //       · draft 不参与 latest，忘了 Publish 就永远看不到
  if (isReleaseEndpoint(url)) {
    const m = /^(https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+)\/releases\/latest\/?$/i.exec(
      url.trim(),
    )
    if (m) {
      // 拉列表（一页 30 个足够：旧 release 里没有清单的会被跳过）
      const listJson = await fetchRawTextCandidates(`${m[1]}/releases?per_page=30`, token, {
        allowApi: true,
      })
      const pickedTag = pickManifestRelease(listJson)
      if (!pickedTag) {
        throw new Error(
          `没有可用的 release：需要「已发布 + 含 ${MANIFEST_ASSET_NAME} 资产」的版本（发版时 sync-packages 负责上传）`,
        )
      }
      const relJson = await fetchRawTextCandidates(`${m[1]}/releases/tags/${pickedTag}`, token, {
        allowApi: true,
      })
      const assetUrl = manifestAssetUrlFrom(relJson, token)
      if (!assetUrl) {
        throw new Error(`release ${pickedTag} 里没有 ${MANIFEST_ASSET_NAME} 资产`)
      }
      return fetchRawTextCandidates(assetUrl, token, {})
    }
  }

  // 钉版本：`.../releases/tags/<tag>` 直接用它
  if (isTagReleaseEndpoint(url)) {
    const relJson = await fetchRawTextCandidates(url, token, { allowApi: true })
    const assetUrl = manifestAssetUrlFrom(relJson, token)
    if (!assetUrl) {
      throw new Error(
        `该 release 里没有 ${MANIFEST_ASSET_NAME} 资产（发版时 sync-packages 应上传它）`,
      )
    }
    target = assetUrl
  }

  return fetchRawTextCandidates(target, token, {})
}

/** 直接用原生通道拉一段文本（不解析） */
async function fetchRawText(url: string, token: string): Promise<string> {
  const inv = tauriInvoke()
  if (inv) {
    // PC：Rust 侧用 curl 拉，支持 token
    return (await inv('app_update_manifest_text', { url, token })) as string
  }
  const b = tvBridge()
  if (b?.appUpdateManifest) {
    const text = b.appUpdateManifest(url, token)
    if (text == null) {
      const why = b.appUpdateError?.() || '拉取清单失败'
      throw new Error(why)
    }
    return text
  }
  // 纯 Web / 老壳：明确报错，不要静默当成"已是最新版本"
  throw new Error('当前端不支持检查更新（需要 PC 或 TV 应用）')
}

/**
 * 检查更新。
 *
 * @param sourceUrl 清单地址；不传则用设置里的更新源
 * @returns 有更新返回详情，否则 null
 */
export async function checkAppUpdate(sourceUrl?: string): Promise<AppUpdate | null> {
  const platform = currentPlatform()
  if (platform === 'web') return null // 纯 Web 没有"安装包"这个概念

  const src = (sourceUrl ?? (await getUpdateSource()) ?? '').trim()
  if (!src) return null

  const cur = currentVersion()
  if (!cur) return null

  // localStorage 优先（用户刚在这一页填的），否则用原生存共用的那份
  // （PC 上插件源和应用更新共用同一个令牌，用户只填一次）
  const token = getUpdateToken() || (await getNativeToken())
  const text = await fetchManifestText(src, token)

  let index: { packages?: Record<string, NativeEntry> }
  try {
    index = JSON.parse(text)
  } catch {
    throw new Error('清单不是合法 JSON')
  }
  const pkgs = index?.packages || {}

  // 先找当前的品牌 id（meow-pc / meow-tv），再退回旧的 app-pc/app-tv/app。
  // 顺序很重要：新版清单里两者可能并存（过渡期），必须优先新的。
  const id = packageIdFor(platform)
  const candidates: Array<[string, NativeEntry]> = []
  if (pkgs[id]) candidates.push([id, pkgs[id]])
  for (const legacy of LEGACY_APP_IDS) {
    if (legacy !== id && pkgs[legacy]) candidates.push([legacy, pkgs[legacy]])
  }

  for (const [pid, pkg] of candidates) {
    /*
     * 三层平台校验（id → platform 数组 → 扩展名），见 entryFitsPlatform。
     *
     * ★ 这里原来是单独一句 `pkg.platform && pkg.platform.length && ...`，
     *   当 platform 缺失时会**整体放行** —— 而 LEGACY_APP_IDS 里同时有
     *   app-pc 和 app-tv，所以 PC 端本来就会把 TV 条目当候选。
     */
    if (!entryFitsPlatform(pid, pkg.platform, platform)) continue
    if (!pkg.version || !isNewer(pkg.version, cur)) continue
    const url = resolveUrl(src, pkg.url || '')
    if (!url) continue
    // 扩展名兜底：id 和 platform 都写对、但 url 指错文件的情况
    const byUrl = platformOfUrl(url)
    if (byUrl && byUrl !== familyOf(platform)) continue
    return {
      version: pkg.version,
      url,
      sha256: (pkg.sha256 || '').toLowerCase(),
      size: pkg.size || 0,
      notes: pkg.desc,
      lasttime: pkg.lasttime,
      packageId: pid,
    }
  }
  return null
}

/** 原生下载进度（两端同构） */
export interface NativeProgress {
  stage: string
  percent: number
  received: number
  total: number
  message: string
  /** PC 侧才有：落盘的绝对路径 */
  path?: string
}

/** 开始下载（立即返回；进度用 pollDownload 轮询） */
export async function startDownload(update: AppUpdate): Promise<void> {
  if (!/^https?:\/\//i.test(update.url)) throw new Error('下载地址必须是 http(s)')
  if (!update.sha256) throw new Error('清单缺 sha256，拒绝下载')

  /*
   * ★ 下载前再校验一次平台，即使 checkAppUpdate 已经筛过。
   *
   * 为什么不能省：
   *   · `AppUpdate` 是普通对象，会穿过后端存储（localStorage / 原生状态）
   *     —— 两个函数之间不是同一个调用栈，中间可能夹着"用户手动编辑清单"
   *     或"上一轮检查的残留结果"。
   *   · 真正造成损失的是**这一步**（13MB 流量 + 拉起错误安装器），
   *     只拦检查不拦下载等于把闸门装在了错误的位置。
   *   · 报错要能指认问题：只说"平台不匹配"用户不知道去改什么。
   */
  const cur = currentPlatform()
  if (cur === 'web') throw new Error('当前端不支持自动下载（需要 PC 或 TV 应用）')
  const want = familyOf(cur)
  const byId = platformOfPackageId(update.packageId || '')
  if (byId && byId !== want) {
    throw new Error(
      `清单里的「${update.packageId}」是 ${byId === 'windows' ? 'Windows' : 'Android'} 安装包，` +
        `本机是 ${want === 'windows' ? 'Windows' : 'Android'}，已拒绝下载（清单可能配错了 id）`,
    )
  }
  const byUrl = platformOfUrl(update.url)
  if (byUrl && byUrl !== want) {
    throw new Error(
      `下载地址指向 ${byUrl === 'windows' ? 'exe/msi' : 'apk'}，` +
        `本机是 ${want === 'windows' ? 'Windows' : 'Android'}，已拒绝下载（清单里的 url 可能配错了）`,
    )
  }

  const token = getUpdateToken() || (await getNativeToken())
  // 私有仓的标准下载链接一律 404（实测），有 token 时先换成 API 资产端点
  const resolved = await toDownloadableUrl(update.url, token)
  // 再补上代理候选：GitHub 直连经常 TLS 超时，让原生逐个试
  const urls = downloadCandidates(resolved)

  const inv = tauriInvoke()
  if (inv) {
    await inv('app_update_download', {
      // 传数组：原生按顺序试，第一个能下通的胜出
      urls,
      sha256: update.sha256,
      size: update.size || 0,
      token,
      fileName: fileNameFor(update),
    })
    return
  }
  const b = tvBridge()
  if (!b?.appUpdateDownload) throw new Error('当前端不支持自动下载')
  const r = String(b.appUpdateDownload(urls.join('|'), update.sha256, token, fileNameFor(update)))
  if (r && r !== '已开始下载') throw new Error(r)
}

/**
 * 从 url 取个像样的文件名（原生侧还会再净化一次）。
 *
 * ★ 要判扩展名：`http://x/` 这种地址取最后一段会得到主机名 `x`，
 * 拿它当文件名会把包装成 `x`（没有扩展名，用户看不出是什么）。
 */
export function fileNameFor(update: AppUpdate): string {
  try {
    const last = update.url.split('?')[0].split('/').filter(Boolean).pop() || ''
    // 必须长得像文件名：带扩展名且不是纯主机名
    if (/\.[A-Za-z0-9]{2,8}$/.test(last)) return last
  } catch {
    /* 落到默认名 */
  }
  return update.packageId === APP_TV_ID ? 'meow-tv.apk' : 'meow-setup.exe'
}

/** 读一次下载进度（不轮询，由调用方定时调） */
export async function readProgress(): Promise<NativeProgress> {
  const inv = tauriInvoke()
  if (inv) {
    return (await inv('app_update_state')) as NativeProgress
  }
  const b = tvBridge()
  if (b?.appUpdateState) {
    try {
      const j = JSON.parse(b.appUpdateState())
      return {
        stage: String(j.state || 'idle'),
        percent: Number(j.percent) || 0,
        received: Number(j.received) || 0,
        total: Number(j.total) || 0,
        message: String(j.message || ''),
        path: j.path ? String(j.path) : undefined,
      }
    } catch {
      return { stage: 'idle', percent: 0, received: 0, total: 0, message: '' }
    }
  }
  return { stage: 'idle', percent: 0, received: 0, total: 0, message: '' }
}

/** 取消下载 */
export async function cancelDownload(): Promise<boolean> {
  const inv = tauriInvoke()
  if (inv) return (await inv('app_update_cancel')) as boolean
  const b = tvBridge()
  return b?.appUpdateCancel ? !!b.appUpdateCancel() : false
}

/**
 * 把已下载并校验通过的包交给平台安装器。
 *
 * Windows 走 Tauri 命令（清掉缓存后 `cmd /C start` 拉起 NSIS 安装向导），
 * Android 走 `ACTION_VIEW` 让系统安装器接管。两者都不是"应用自己覆盖自己"。
 *
 * @returns 给用户看的一句话
 */
export async function installDownloaded(): Promise<string> {
  const inv = tauriInvoke()
  if (inv) {
    // PC 侧要传路径：Rust 只能接受下载缓存里的路径（防"运行任意 exe"）
    const state = await readProgress()
    if (!state.path) throw new Error('还没有下载好的安装包')
    return (await inv('app_update_install', { path: state.path })) as string
  }
  const b = tvBridge()
  if (!b?.appUpdateInstall) throw new Error('当前端不支持自动安装')
  const r = String(b.appUpdateInstall())
  if (r && r !== 'ok') throw new Error(r)
  return '已交给系统安装器，请按提示完成安装'
}

/** 清理下载缓存，返回释放的字节数（失败返回 0） */
export async function clearUpdateCache(): Promise<number> {
  try {
    const inv = tauriInvoke()
    if (inv) return (await inv('app_update_clear')) as number
    const b = tvBridge()
    if (b?.appUpdateClearCache) return b.appUpdateClearCache() || 0
  } catch {
    /* 清理失败不影响主流程 */
  }
  return 0
}

/**
 * sha256 纯 JS 实现（FIPS 180-4）。
 *
 * <p><b>现在主路径不再用它</b>——校验在原生做（Java `MessageDigest` / Rust `sha2`）。
 * 保留它有两个用途：① 单测里用已知向量锁死"sha256 该怎么算"，
 * 给两端原生实现一个对照标准；② 万一将来需要在浏览器里校验（比如 Web 端
 * 做包完整性展示），有一条不依赖安全上下文的实现。
 *
 * <p>为什么当初需要它：TV 壳的页面是 `http://meow.local`（非安全上下文），
 * `crypto.subtle` 直接是 undefined，而 TV 恰恰是最需要校验的一端。
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const c = globalThis.crypto
  if (c?.subtle) {
    try {
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      const hash = await c.subtle.digest('SHA-256', buf)
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
    } catch {
      // 落到下面的纯 JS 实现
    }
  }
  return sha256HexJs(data)
}

/** 纯 JS 的 SHA-256（FIPS 180-4），用于非安全上下文。 */
export function sha256HexJs(data: Uint8Array): string {
  // 消息填充：0x80 + 若干 0 + 64 位长度
  const bitLen = data.length * 8
  const withPad = new Uint8Array((((data.length + 8) >> 6) + 1) << 6)
  withPad.set(data)
  withPad[data.length] = 0x80
  // 长度写在大端末尾 8 字节（高 32 位恒为 0，我们的输入远小于 2^32 位）
  const dv = new DataView(withPad.buffer)
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false)
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false)

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

  const w = new Uint32Array(64)
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('')
}
