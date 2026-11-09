/**
 * 运行时诊断采集器。
 *
 * 为什么要有：桌面端有内置 MCP（见 src-tauri/src/mcp.rs），AI 可以通过
 * `pc_console` / `pc_network` 读取诊断信息来自动冒烟。但浏览器原生的
 * 错误和请求不会自己进任何数组 —— 必须在这里主动挂钩子。
 *
 * 只记录最近 N 条（环形缓冲），避免长时间运行把内存吃满。
 * 全部挂在 window 上，MCP 侧用 pc_eval 读取。
 */

export interface RuntimeError {
  kind: 'error' | 'unhandledrejection' | 'console.error'
  message: string
  stack: string
  at: number
  url: string
}

export interface NetRecord {
  method: string
  url: string
  status: number | null
  ok: boolean
  ms: number
  bytes: number
  error: string | null
  at: number
}

const MAX_ERRORS = 50
const MAX_NET = 100
/**
 * 失败请求单独存一条队列，且**不受 MAX_NET 淘汰影响**。
 *
 * 为什么要有：hls.js 播一集几百个分片，`net` 环里 100 条很快全被分片占满，
 * 播放前那几条关键请求（detail / play / 清单）被挤掉，诊断时什么都查不到。
 * 诊断真正需要的是失败项——成功的分片零信息量。
 * 上限比 net 大：失败通常只有几条，留余量给"整片都 404"这种极端情况。
 */
const MAX_NET_FAIL = 200

const errors: RuntimeError[] = []
const net: NetRecord[] = []
const netFail: NetRecord[] = []

function push<T>(arr: T[], item: T, max: number) {
  arr.push(item)
  if (arr.length > max) arr.splice(0, arr.length - max)
}

/** 记录一条网络元数据：成功进 net；失败同时进 netFail（不会被分片冲掉）。 */
function recordNet(r: NetRecord) {
  push(net, r, MAX_NET)
  if (!r.ok) push(netFail, r, MAX_NET_FAIL)
}

/** 把内部实现藏起来，只暴露只读快照，避免页面代码误改。 */
export function installDiagnostics() {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.__meowDiag) return // 只装一次

  // ---- JS 错误 ----
  window.addEventListener('error', (e) => {
    push(
      errors,
      {
        kind: 'error',
        message: e.message || String(e.error ?? 'unknown error'),
        stack: e.error?.stack || '',
        at: Date.now(),
        url: location.hash || location.href,
      },
      MAX_ERRORS,
    )
  })

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    push(
      errors,
      {
        kind: 'unhandledrejection',
        message: r?.message ? String(r.message) : String(r),
        stack: r?.stack || '',
        at: Date.now(),
        url: location.hash || location.href,
      },
      MAX_ERRORS,
    )
  })

  // ---- fetch 与 XHR 的网络记录 ----
  //
  // 只记录元数据，不碰请求/响应体：
  //   1. 体里可能有 WebDAV 密码，落进诊断数组会被 MCP 读走
  //   2. 大响应（比如 m3u8）复制一份会明显拖慢
  const origFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET') || 'GET').toUpperCase()
    const t0 = performance.now()
    try {
      const res = await origFetch(input as RequestInfo, init)
      const len = Number(res.headers.get('content-length') || 0)
      recordNet({
        method,
        url,
        status: res.status,
        ok: res.ok,
        ms: Math.round(performance.now() - t0),
        bytes: Number.isFinite(len) ? len : 0,
        error: null,
        at: Date.now(),
      })
      return res
    } catch (e: any) {
      recordNet({
        method,
        url,
        status: null,
        ok: false,
        ms: Math.round(performance.now() - t0),
        bytes: 0,
        error: e?.message || String(e),
        at: Date.now(),
      })
      throw e
    }
  }

  // XHR：视频流用它（Range 请求），fetch 拦不到
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const t0 = performance.now()
    const u = typeof url === 'string' ? url : url.href
    this.addEventListener('loadend', () => {
      recordNet({
        method: String(method).toUpperCase(),
        url: u,
        status: this.status || null,
        ok: this.status >= 200 && this.status < 300,
        ms: Math.round(performance.now() - t0),
        bytes: Number(this.getResponseHeader('content-length') || 0) || 0,
        error: this.status === 0 ? 'network error or aborted' : null,
        at: Date.now(),
      })
    })
    // @ts-expect-error 透传给原生 open，参数个数不定
    return origOpen.call(this, method, url, ...rest)
  }

  w.__meowDiag = {
    // MCP 侧只读这些
    errors: () => errors.slice(),
    net: () => net.slice(),
    /**
     * 只含失败请求，**不受分片冲击**（见 MAX_NET_FAIL 的说明）。
     * 诊断层优先读这个：成功的分片请求对归因没有信息量。
     */
    netFail: () => netFail.slice(),
    clear: () => {
      errors.length = 0
      net.length = 0
      netFail.length = 0
    },
    version: 2,
  }
}
