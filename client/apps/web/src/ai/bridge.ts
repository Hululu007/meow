/**
 * 外部 MCP 的工具桥（docs/47 §1.8 方案 A）。
 *
 * ## 为什么需要这个东西
 *
 * 9 个 `meow_*` 语义工具原来只在应用内 AI 可用。PC 的 MCP 暴露 18 个 `pc_*`、
 * TV 暴露 13 个 `tv_*`，**全是 UI 原语**——外部 AI 操作猫窝时仍要
 * "先 pc_dom 找元素、再 pc_click 点按钮"，享受不到 `meow_search` 一次调用
 * 完成搜索的便利。
 *
 * 打通有两条路（§9.1）：
 *   A. 壳代理到前端（本文件）—— 业务逻辑只留在 tools.ts
 *   B. 后端开 MCP 端点 —— 要把 9 个工具在 Java 里重写一遍
 *
 * 选 A：唯一真源留在前端，壳只做转发，不会出现"Rust 版和 TS 版行为不一致"。
 *
 * ## 两种调用形态
 *
 * PC（Tauri）的 CDP `Runtime.evaluate` 带 `awaitPromise: true`，可以直接
 * `await window.__meowTool('meow_search', {keyword:'庆余年'})`。
 *
 * TV 的 `evaluateJavascript` 是**同步回调**，拿不到 Promise 结果。所以额外提供
 * 一个"投任务 + 轮询"的通道：
 *     __meowToolStart(id, name, args)   → 立刻返回，后台跑
 *     __meowToolPoll(id)                → 返回 {pending} | {done, result}
 *
 * 两条通道共用同一个 `dispatch()`，行为必然一致。
 */

import * as tools from './tools'

type ToolName = keyof typeof TOOL_IMPL

/** 名字 → 实现。只收**只读**工具：写操作要用户确认，不该由外部 AI 直接触发。 */
const TOOL_IMPL = {
  meow_state: () => tools.meowState(),
  /*
   * 日志查询：只读，安全。
   *
   * 参数原样透传 —— **看多少条、什么级别、哪个模块、多长时间窗由调用方
   * （模型）决定**，bridge 不做任何预设。这正是把它做成独立工具的理由：
   * 塞进 meow_state 固定取 20 条时，实测取到的全是 `GET /api/...` 噪音。
   */
  meow_logs: (a: Record<string, unknown>) =>
    tools.meowLogs({
      minLevel:
        a.minLevel === 'warn' || a.minLevel === 'error' || a.minLevel === 'info'
          ? a.minLevel
          : undefined,
      tag: a.tag ? String(a.tag) : undefined,
      keyword: a.keyword ? String(a.keyword) : undefined,
      minutes: typeof a.minutes === 'number' ? a.minutes : undefined,
      limit: typeof a.limit === 'number' ? a.limit : undefined,
    }),
  meow_diagnose: () => tools.meowDiagnose(),
  meow_search: (a: Record<string, unknown>) => tools.meowSearch(String(a.keyword ?? ''), {
    limit: typeof a.limit === 'number' ? a.limit : undefined,
  }),
  meow_play: (a: Record<string, unknown>) =>
    tools.meowPlay({
      site: String(a.site ?? ''),
      vod_id: String(a.vod_id ?? ''),
      line: a.line ? String(a.line) : undefined,
      episode: a.episode ? String(a.episode) : undefined,
    }),
  meow_sources: () => tools.meowSources(),
  meow_library: () => tools.meowLibrary(),
  meow_live: () => tools.meowLive(),
  meow_danmaku: (a: Record<string, unknown>) =>
    tools.meowDanmaku({
      name: a.name ? String(a.name) : undefined,
      episode: a.episode ? String(a.episode) : undefined,
    }),
  // ★ meow_cache 只走 list。start/export 是写操作（§4.9 纪律二），
  //   外部 AI 不该能直接触发，必须由用户在界面上确认。
  meow_cache: () => tools.meowCache('list'),
} as const

/** 给外部 MCP 用的工具名清单（壳按它生成 tools/list，避免两边漂移） */
export function bridgeToolNames(): string[] {
  return Object.keys(TOOL_IMPL)
}

/** 工具实现的统一返回形状 */
interface ToolLike {
  ok?: boolean
  data?: unknown
  error?: string
  summary?: string
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolLike> {
  const fn = TOOL_IMPL[name as ToolName]
  if (!fn) {
    return {
      ok: false,
      error: `没有名为 ${name} 的工具。可用：${bridgeToolNames().join('、')}`,
    }
  }
  try {
    // 所有实现都是 async，统一 await 一次即可
    return (await (fn as (a: Record<string, unknown>) => Promise<ToolLike>)(args)) ?? {
      ok: false,
      error: '工具没有返回结果',
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------------------------------------------------------------- 投任务通道（TV）

interface Pending {
  done: boolean
  result?: ToolLike
  at: number
}

const pending = new Map<string, Pending>()
/** 超过这个时间的任务直接丢掉：外部 AI 早就不等了，留着占内存 */
const PENDING_TTL_MS = 120_000

function gcPending() {
  const now = Date.now()
  for (const [id, p] of pending) {
    if (now - p.at > PENDING_TTL_MS) pending.delete(id)
  }
}

/**
 * 安装到 window。幂等：重复调用不会重装。
 *
 * 挂在 window 上而不是做成模块导出，是因为壳只能通过 `evaluate` 触达页面上下文，
 * 拿不到 webpack/vite 的模块图。
 */
export function installToolBridge() {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.__meowTool) return // 只装一次

  /** 直接调用（PC：CDP 支持 awaitPromise，可以 `await` 它） */
  w.__meowTool = (name: string, args?: Record<string, unknown>) =>
    dispatch(String(name || ''), args && typeof args === 'object' ? args : {})

  /** 投任务（TV：evaluateJavascript 同步回调，拿不到 Promise） */
  w.__meowToolStart = (id: string, name: string, args?: Record<string, unknown>) => {
    gcPending()
    const key = String(id || '')
    if (!key) return false
    pending.set(key, { done: false, at: Date.now() })
    void dispatch(String(name || ''), args && typeof args === 'object' ? args : {}).then((r) => {
      pending.set(key, { done: true, result: r, at: Date.now() })
    })
    return true
  }

  /** 取任务结果（未完成时 pending=true） */
  w.__meowToolPoll = (id: string) => {
    const key = String(id || '')
    const p = pending.get(key)
    if (!p) return { pending: false, missing: true }
    if (!p.done) return { pending: true }
    pending.delete(key) // 取走即清，避免重复消费
    return { pending: false, result: p.result }
  }

  /** 供壳自检：有哪些工具可用 */
  w.__meowTools = () => bridgeToolNames()
}
