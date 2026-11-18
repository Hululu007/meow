/**
 * 版本历史（设置 → 关于 → 版本历史）。
 *
 * <p>数据源是 `updates` 分支的 `history.json`，由 `deploy/scripts/gen-history.ps1`
 * 从 `CHANGELOG.md` 生成（packages.json 每个包只留最新一条 desc，历史没人存）。
 *
 * <p><b>为什么运行时拉、不打包进 bundle</b>：历史随发版增长，打包等于每版都要跟；
 * 而且这一屏是低频入口，多一次网络请求比多几十 KB 包体划算。
 *
 * <p><b>走应用更新同一套加速候选</b>（`downloadCandidates`：直连 → 全局 git 加速
 * 代理 → jsDelivr），否则国内 / TV 上大概率拉不到 GitHub。全部候选都失败才算失败，
 * UI 给「重试」。
 */
import { downloadCandidates } from './appUpdate'

const REPO = 'upchr/meow'
const BRANCH = 'updates'
const FILE = 'history.json'

export interface ChangelogEntry {
  version: string
  /** 发版日期 YYYY-MM-DD（来自 release tag）；老版本没打过 tag 时缺省 */
  date?: string
  lines: string[]
}

/** 会话级缓存：同一个页面生命周期里反复开关弹框不再打网络 */
let cache: ChangelogEntry[] | null = null

export function historyUrl(): string {
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE}`
}

/** 候选地址（直连 + 加速代理 + jsDelivr）。顺序即优先级。 */
export function historyCandidates(): string[] {
  // index: true —— 这是几 KB 的清单类小文件，必须允许 jsDelivr 候选
  return downloadCandidates(historyUrl(), undefined, { index: true })
}

/**
 * 解析 history.json。
 *
 * <p>容错原则：**结构不对就整份丢掉**，不做"尽力猜"——把半截数据展示成
 * "最新版本没有更新说明"比明确报错更误导。版本号非法 / lines 不是字符串数组
 * 的条目直接跳过（个别条目坏掉不该让整份历史消失）。
 */
export function parseHistory(text: string): ChangelogEntry[] {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('版本历史格式不对（不是 JSON）')
  }
  const raw = (doc as { versions?: unknown }).versions
  if (!Array.isArray(raw)) throw new Error('版本历史里没有 versions 数组')
  const out: ChangelogEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = (item as { version?: unknown }).version
    const lines = (item as { lines?: unknown }).lines
    const date = (item as { date?: unknown }).date
    if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) continue
    if (!Array.isArray(lines)) continue
    const entry: ChangelogEntry = {
      version: v,
      lines: lines.filter((l): l is string => typeof l === 'string' && l.trim().length > 0),
    }
    // 日期是可选字段：格式不对就当没给，不要显示一个怪字符串
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) entry.date = date
    out.push(entry)
  }
  if (!out.length) throw new Error('版本历史是空的')
  return out
}

/** 单条候选的超时：被墙的地址会连上却不回数据，必须自己砍 */
const CANDIDATE_TIMEOUT_MS = 6000

async function fetchOne(url: string, timeoutMs: number): Promise<string> {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetch(url, {
      signal: ctrl?.signal,
      cache: 'no-store',
      // 公开文件，不带凭证；带上反而会触发 CORS 预检失败
      credentials: 'omit',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 拉版本历史（带候选轮询 + 会话缓存）。
 *
 * @param force 忽略缓存重新拉（「重试」按钮用）
 */
export async function fetchChangelogHistory(force = false): Promise<ChangelogEntry[]> {
  if (!force && cache) return cache
  let lastErr = ''
  for (const url of historyCandidates()) {
    try {
      const text = await fetchOne(url, CANDIDATE_TIMEOUT_MS)
      const list = parseHistory(text)
      cache = list
      return list
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }
  throw new Error(lastErr || '版本历史拉取失败')
}

/** 测试/切源用：清掉会话缓存 */
export function clearHistoryCache(): void {
  cache = null
}
