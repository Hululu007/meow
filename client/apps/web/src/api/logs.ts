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
  }
  items: Array<{ id: number; at: number; level: string; tag: string; text: string }>
}

/** 拉服务端日志。since>0 时只取增量。 */
export async function fetchServerLogs(opts: {
  level?: string
  tag?: string
  since?: number
  limit?: number
}): Promise<LogsFetchResult> {
  const q = new URLSearchParams()
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
    d.net().forEach((n, i) => {
      out.push({
        key: `cli-net-${n.at}-${i}`,
        origin: 'client',
        at: n.at,
        level: n.ok ? 'info' : 'warn',
        tag: 'net',
        text: `${n.method} ${n.url} → ${n.status === null ? 'ERR' : n.status} · ${n.ms}ms · ${n.bytes}B${
          n.error ? ' · ' + n.error : ''
        }`,
      })
    })
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
