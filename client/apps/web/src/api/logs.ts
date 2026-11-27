import { apiBase } from './index'

/**
 * 运行日志的前端接口。
 *
 * 两个来源合并展示：
 * - **服务端**：`GET /api/logs`（后端环形缓冲 2000 条，见 core/LogBuffer.java）
 * - **客户端**：`diagnostics.ts` 已在采集的 JS 错误与网络请求
 *
 * 为什么要合并而不是只做后端：绝大多数"点了没反应"发生在请求发出之前
 * （或根本没发出），只看服务端日志会得出"后端没问题"的错误结论。
 */

export type LogLevel = 'info' | 'warn' | 'error'

/** 统一的日志条目（服务端与客户端都归一成这个形状） */
export interface LogItem {
  /** 稳定 key：svc-<id> / cli-<序号> */
  key: string
  /** 来源：server=后端，client=浏览器 */
  origin: 'server' | 'client'
  at: number
  level: LogLevel
  /** 模块标签：req/cache/search/danmaku/proxy/import/cors/net/ui… */
  tag: string
  text: string
  /**
   * 同一文本在 5 秒窗口内重复了几次（服务端合并）。
   * 缺省/1 = 没合并过。有了它，刷屏的循环只占一行而不是几百行。
   */
  count?: number
  /**
   * 最后一次出现的时间。`at` 保持**首次**时间（列表按 at 排序，改了会乱序），
   * 去重窗口按 lastAt 算。只有合并过的条目才有。
   */
  lastAt?: number
}

/** 日志端点的四种结果：ok / 后端没有这个端点（旧版）/ 后端不可达 / 其他错误 */
export type LogsFetchState = 'ok' | 'unsupported' | 'unreachable' | 'error'

/**
 * 拉服务端日志，并把失败**分类**。
 *
 * ★ 为什么必须分类：`/api/logs` 是 0.9.16 才有的端点，连旧后端时是 404。
 *   原先任何非 2xx 都 throw，页面 catch 到就显示「后端不可达」——
 *   而实测同一屏里 `/api/health`、`/api/sites` 全是 200，后端明明活着。
 *   把「端点不存在」说成「后端不可达」会让人往网络/进程方向排查，方向就错了。
 */
export interface LogsFetchResult {
  state: LogsFetchState
  /** state=ok 时的数据 */
  data?: LogsResponse
  /** 给人看的原因；供页面直接展示 */
  detail?: string
}

export interface LogsResponse {
  ok: boolean
  stats: {
    total: number
    errors: number
    warns: number
    capacity: number
    lastId: number
    /** 被环形挤掉的条数（不是"一共只有这些"）。旧后端没有这个字段 */
    dropped?: number
    /** 当前日志级别（MEOW_LOG_LEVEL，默认 info） */
    level?: string
    /** 落盘文件绝对路径（重启后去这里看现场） */
    file?: string
    bytes?: number
    bytesCap?: number
  }
  items: Array<{
    id: number
    at: number
    level: string
    tag: string
    text: string
    count?: number
    lastAt?: number
  }>
  /** 队尾快照（请求带 tail 时才有）：用于刷新"同一文本 ×N"的计数 */
  tail?: Array<{
    id: number
    at: number
    level: string
    tag: string
    text: string
    count?: number
    lastAt?: number
  }>
  /**
   * 落盘文件的末尾若干行（请求带 file=1 时才有）。
   *
   * 内存缓冲重启即清空，而"崩了之后重启再看日志"是最常见的排查姿势 ——
   * 这一段就是**重启前**写下的现场。
   */
  fileItems?: Array<{
    at: number
    level: string
    tag: string
    text: string
  }>
}

/** 拉服务端日志。since>0 时只取增量。 */
export async function fetchServerLogs(opts: {
  level?: string
  tag?: string
  since?: number
  limit?: number
  /** 额外返回最新 N 条（不看 since），用于刷新重复计数 */
  tail?: number
  /** 读落盘文件的末尾（重启后的现场） */
  file?: boolean
  /** 落盘文件读多少行（默认 200） */
  lines?: number
}): Promise<LogsFetchResult> {
  const q = new URLSearchParams()
  if (opts.tail) q.set('tail', String(opts.tail))
  if (opts.file) {
    q.set('file', '1')
    q.set('lines', String(opts.lines || 200))
  }
  if (opts.level) q.set('level', opts.level)
  if (opts.tag) q.set('tag', opts.tag)
  if (opts.since) q.set('since', String(opts.since))
  q.set('limit', String(opts.limit || 500))
  let r: Response
  try {
    r = await fetch(`${apiBase()}/api/logs?${q}`)
  } catch (e) {
    // fetch 本身抛错才是「连不上」（DNS/拒连/断网）
    return { state: 'unreachable', detail: e instanceof Error ? e.message : String(e) }
  }
  if (r.status === 404) {
    // 两种 404：后端没有这个端点（旧版），或反代把 /api 转发到了别处
    return {
      state: 'unsupported',
      detail: '后端没有 /api/logs 端点（需要 0.9.16 及以上；当前后端版本更旧，或 nginx 未转发该路径）',
    }
  }
  if (!r.ok) {
    return { state: 'error', detail: `HTTP ${r.status}` }
  }
  try {
    return { state: 'ok', data: (await r.json()) as LogsResponse }
  } catch (e) {
    return { state: 'error', detail: '响应不是合法 JSON：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/** 清空服务端缓冲（不动 stdout）。 */
export async function clearServerLogs(): Promise<boolean> {
  const r = await fetch(`${apiBase()}/api/logs`, { method: 'DELETE' })
  return r.ok
}

/**
 * 把 diagnostics.ts 的采集结果转成统一条目。
 *
 * 访问 window.__meowDiag 而不是 import 那个模块：它是给外部工具（MCP）
 * 读的全局快照，直接读能拿到**已被页面写过**的最新值；import 进来只会
 * 拿到本模块自己创建的另一个实例，永远是空的。
 */
export function readClientLogs(): LogItem[] {
  const w = window as unknown as {
    __meowDiag?: {
      errors: () => Array<{ kind: string; message: string; stack: string; at: number; url: string }>
      net: () => Array<{
        method: string
        url: string
        status: number | null
        ok: boolean
        ms: number
        bytes: number
        error: string | null
        at: number
      }>
    }
  }
  const d = w.__meowDiag
  if (!d) return []
  const out: LogItem[] = []
  try {
    d.errors().forEach((e, i) => {
      out.push({
        key: `cli-err-${e.at}-${i}`,
        origin: 'client',
        at: e.at,
        level: 'error',
        tag: e.kind === 'unhandledrejection' ? 'promise' : 'ui',
        text: `${e.message}${e.stack ? '\n' + e.stack.split('\n').slice(0, 3).join('\n') : ''} @ ${e.url}`,
      })
    })
  } catch {
    /* 采集器异常不影响页面 */
  }
  try {
    /*
     * 客户端网络记录降噪（2026-11-27 真机实测后改了两处）。
     *
     * ① **掐掉面板自己的轮询**：日志页每 3 秒 `GET /api/logs?limit=500`，
     *    不掐的话每刷一次就多一条"我自己在读日志"，把要看的现场挤走。
     *    健康检查同理（服务端 isNoisyPath 早就滤了，客户端却还留着）。
     * ② **按 (方法+URL+状态) 在 5 秒窗口内聚合**，而不是只看"相邻"：
     *    实测真机上客户端与服务端日志是**交错**的（cli:net / srv:req / cli:ui），
     *    相邻合并几乎命中不了，投屏轮询照样铺满一屏（197 条）。
     */
    const nets = d.net()
    const seen = new Map<string, number>()
    for (let i = 0; i < nets.length; i++) {
      const n = nets[i]
      const url = String(n.url || '')
      if (url.includes('/api/logs') || url.includes('/api/health')) continue
      const text = `${n.method} ${url} → ${n.status === null ? 'ERR' : n.status} · ${n.ms}ms · ${n.bytes}B${
        n.error ? ' · ' + n.error : ''
      }`
      const k = `${n.method} ${url} ${n.status} ${n.error || ''}`
      const hit = seen.get(k)
      if (hit !== undefined) {
        const prev = out[hit]
        // 窗口按"最近一次"算，但 at 保持首次（否则列表会乱序 —— 真机实测过）
        if (n.at - (prev.lastAt ?? prev.at) <= 5000) {
          prev.count = (prev.count || 1) + 1
          prev.lastAt = n.at
          prev.text = text
          continue
        }
      }
      seen.set(k, out.length)
      out.push({
        key: `cli-net-${n.at}-${i}`,
        origin: 'client',
        at: n.at,
        level: n.ok ? 'info' : 'warn',
        tag: 'net',
        text,
      })
    }
  } catch {
    /* 同上 */
  }
  return out
}

/**
 * 打一条自定义事件日志（客户端侧）。
 *
 * 用于"关键业务动作"——切换线路、起播失败、解析失败这类。它们不是 JS 错误，
 * 但恰恰是用户报"播不了"时最需要看的上下文。
 *
 * 只进内存环形缓冲（复用 diagnostics 的 errors 数组会污染"错误"语义），
 * 所以这里自己维护一份：最多 300 条，页面刷新即清空。
 */
const events: LogItem[] = []
const MAX_EVENTS = 300

export function logEvent(level: LogLevel, tag: string, text: string): void {
  const at = Date.now()
  events.push({ key: `cli-ev-${at}-${events.length}`, origin: 'client', at, level, tag, text })
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

/** 读自定义事件（与 readClientLogs 合并展示）。 */
export function readEvents(): LogItem[] {
  return events.slice()
}

export function clearClientLogs(): void {
  events.length = 0
  const w = window as unknown as { __meowDiag?: { clear?: () => void } }
  w.__meowDiag?.clear?.()
}
