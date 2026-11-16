/**
 * 弹幕后台补全 / 跨集沿用的纯函数（便于单测）。
 *
 * <p>为什么单独抽出来：这些判断都藏在 VideoPlayer 的异步流程里
 * （首屏、12 秒后的 fresh 检查、seek 事件、切集 watcher），
 * 直接测组件成本太高；把阈值和匹配规则抽出来，行为才有回归门禁。
 */

/** 弹幕候选的最小形状（与 `DanmakuCandidate` 兼容）。 */
export interface DanmakuCandidateLike {
  source?: string
  episode?: number
  url?: string
  label?: string
}

/**
 * 新结果是否「明显更全」。
 *
 * <p>阈值 1.2 倍与后端 `tellLaterIfBetter` 一致：几百条的差异不值得
 * 换一次来源（会让弹幕位置跳动），要换就换明显更全的。
 */
export function isBetterDanmaku(current: number, next: number, factor = 1.2): boolean {
  if (current <= 0 || next <= current) return false
  return next >= Math.ceil(current * factor)
}

/**
 * 当前是否处于可以整份替换弹幕的安全点。
 *
 * <p>`currentTime < 15 秒`：刚开播，换来源用户几乎无感；
 * 或用户刚主动 seek（3 秒内）：画面本来就要跳，此时换不会显得突兀。
 * 播放中途超过 15 秒且没 seek 时绝不静默替换。
 */
export function isSafeDanmakuSwap(
  currentTime: number,
  lastSeekAt: number,
  now = Date.now(),
  paused = false,
): boolean {
  if (!Number.isFinite(currentTime)) return false
  /*
   * 2026-11-16 放宽：原来只有"开头 15 秒 / 3 秒内 seek"才算安全点。
   * 实测续播用户（从 30 分钟处继续看）永远满足不了 → 后台补全明明拿到了
   * 更全的聚合弹幕（有效 42292 vs 28046），却只能挂起等下一次主动拖动，
   * 用户感知就是"弹幕数一直不变"。
   *
   * 现在的判据：
   *   · 暂停中 —— 替换无感，最安全；
   *   · 开头 60 秒 —— "从第 1 集看/刚进这集"的主场景；
   *   · 10 秒内主动 seek —— 画面本来就要跳。
   * 播放中途（非暂停、非开头）仍不静默替换：弹幕突然变密/位置跳动的
   * 观感比"少几千条"更糟，继续走挂起（用户暂停或拖动后自动生效）。
   */
  if (paused) return true
  return currentTime < 60 || now - lastSeekAt < 10_000
}

/**
 * 后台补全用的 fresh 地址。
 *
 * <p>只在 12 秒检查时加 `fresh=1`：后端据此跳过 30 分钟缓存再抓一次。
 * 不加的话，客户端虽然绕过了 IndexedDB，拿到的仍是后端缓存里的同一份，
 * “后台补全”就永远不会生效（2026-11-09 实测踩过）。
 *
 * <p>本地缓存的 key 必须仍用**原地址**，所以这个函数只用于 fetch，
 * 不能拿返回值去读写 IndexedDB。
 */
export function freshDanmakuUrl(url: string): string {
  if (!url) return url
  return url + (url.includes('?') ? '&' : '?') + 'fresh=1'
}

/**
 * 手选源跨集沿用：在候选列表里找「同源同集」。
 *
 * <p>找的是 `dmResults`（手动搜索拿到的全剧候选），不猜 animeId；
 * 找不到就回退自动，绝不拿上一集的 URL 顶替。
 */
export function pickSameSourceCandidate<T extends DanmakuCandidateLike>(
  list: T[],
  source: string,
  episode: number,
): T | undefined {
  if (!source || !episode) return undefined
  return list.find((r) => (r.source || '') === source && (r.episode || 0) === episode)
}
