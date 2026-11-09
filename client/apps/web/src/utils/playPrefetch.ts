/**
 * 下集地址预取（2026-11-03，用户要的"方案 B"）。
 *
 * <p><b>为什么是"预取地址"而不是"预拉分片"</b>：
 * 影视仓 / Fongmi 的"秒切"靠的是 **ExoPlayer 两个实例**（一个在播、一个在后台
 * 预载下一集的前几个分片，切集时把 surface 换过去）。那是原生播放器才有的
 * 能力——Web 的 `<video>` + MediaSource 没有"预挂一个源再无缝切换"的接口，
 * 两个 `<video>` 也**不能共享已下载的分片**（各自独立的 MediaSource）。
 * 而在投影仪那种 armeabi-v7a 老内核上开第二个解码器，正是踩过的 ART 崩溃路径。
 *
 * <p>真正的耗时大头也不在分片：实测一次切集 = `detail`（0.38s）+
 * `play`（1.82s）+ 可能的 `parse`，而一个 6 秒分片在源站正常时只要 0.2s。
 * 所以先把**地址解析**这一步提前做掉，切集就是从"转圈 2 秒"变成"直接播"。
 *
 * <p><b>取走即删</b>：源站直链普遍带时效签名（实测 `?token=…&time=…`），
 * 缓存下来复用第二次大概率已经过期。所以是"预取一次、用一次"的语义，
 * 不是长期缓存。
 */

export interface PlayPrefetchEntry {
  /** 与 PlayResult.url 同型：绝大多数是 string，个别源给多地址数组 */
  url: string | string[]
  /** 与 PlayResult.header 同型：可能是 JSON 字符串或对象 */
  header?: string | Record<string, string>
  /** 0 = 不需要解析；非 0 说明存的是已解析过的地址 */
  parse?: number
  /** 预取时刻，用于 TTL 判定 */
  at: number
}

/** 预取结果最多留 10 分钟：超过这个时间签名多半已经失效，留着是坑 */
export const PREFETCH_TTL_MS = 10 * 60_000

const cache = new Map<string, PlayPrefetchEntry>()

/** 缓存键：线路名必须参与——同一集在不同线路上是不同地址 */
export function prefetchKey(site: string, flag: string, epUrl: string): string {
  return `${site}\u0001${flag}\u0001${epUrl}`
}

export function putPlayPrefetch(key: string, entry: Omit<PlayPrefetchEntry, 'at'>, now = Date.now()): void {
  cache.set(key, { ...entry, at: now })
}

/**
 * 取预取结果（**取走即删**）。
 *
 * <p>过期的条目也一并删掉：它留着只会占内存，且下一次查也不会用。
 */
export function takePlayPrefetch(key: string, now = Date.now()): PlayPrefetchEntry | null {
  const e = cache.get(key)
  if (!e) return null
  cache.delete(key)
  if (now - e.at > PREFETCH_TTL_MS) return null
  return e
}

/** 只查不取：用于"这一集是不是已经预取过了"的去重判断 */
export function hasPlayPrefetch(key: string): boolean {
  return cache.has(key)
}

export function clearPlayPrefetch(): void {
  cache.clear()
}

/** 仅供测试/诊断 */
export function playPrefetchSize(): number {
  return cache.size
}

/** 仅供诊断：列出当前缓存的键（不含地址本体，避免把签名 URL 打到日志里） */
export function __prefetchKeyList(): Array<{ site: string; flag: string; epUrlLen: number; ageMs: number }> {
  return [...cache.entries()].map(([k, v]) => {
    const [site, flag] = k.split('\u0001')
    return { site, flag, epUrlLen: (k.split('\u0001')[2] || '').length, ageMs: Date.now() - v.at }
  })
}

// ---------------------------------------------------------------- 预取诊断
/*
 * 预取失败必须是静默的（不能影响正常播放），代价是**从外部完全看不出
 * 它到底有没有触发、卡在哪一步**。2026-11-03 排查"一次都没命中"时
 * 只能往代码里插日志，插完还得再删一遍。
 *
 * 所以留一份常驻的轻量记录：只存事件名和进度，不存地址本体
 * （源站直链带签名，不能进日志）。播放页里读 `window.__playPrefetch()` 即可。
 */

export interface PrefetchDiag {
  /** onProgress 回调次数 —— 0 说明父组件根本没收到进度事件 */
  progressCalls: number
  /** 收到过的最大播放位置（秒）—— 用来判断有没有越过 30 秒门槛 */
  maxPos: number
  /** 缓存里有几条预取结果（**必须从这里读**，见下方注释） */
  cached: number
  /** 最近 N 条预取事件（触发 / 跳过 / 失败的原因） */
  events: Array<{ at: number; event: string }>
}

const TRACE_MAX = 24
const trace: Array<{ at: number; event: string }> = []
let progressCalls = 0
let maxPos = 0

/** 记录一次进度回调（由 PlayView 的 onProgress 调用，开销可忽略） */
export function notePrefetchProgress(pos: number): void {
  progressCalls++
  if (Number.isFinite(pos) && pos > maxPos) maxPos = pos
}

/** 记录一条预取事件（由 PlayView / 本模块调用） */
export function notePrefetch(event: string): void {
  trace.push({ at: Date.now(), event })
  if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX)
}

/**
 * 读诊断快照。
 *
 * <p>★ 缓存条数**必须**从这里取，不要在控制台 `import('/src/utils/playPrefetch.ts')`
 * 再调 `playPrefetchSize()`：HMR 之后那个 URL 会带 `?t=` 变成**另一个模块实例**，
 * 拿到的是空 Map —— 2026-11-03 就是这样误判成"预取一次都没触发"，白查了两轮。
 */
export function prefetchDiag(): PrefetchDiag {
  return { progressCalls, maxPos, cached: cache.size, events: trace.slice() }
}

/** 清零（测试用；页面重进不需要，模块级状态随路由重建） */
export function __resetPrefetchDiag(): void {
  progressCalls = 0
  maxPos = 0
  trace.length = 0
}
