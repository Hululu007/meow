/**
 * 转码播放的 seek 判定（issue #17）。
 *
 * <p>转码是**从起点顺序产出分片**的：清单里只有一段真实内容
 * `[startSeconds, aheadSeconds]`（起点重转时前面是黑场填充）。
 * 用户拖到这段之外时，hls.js 会干等不存在的分片/放黑屏 —— 现在不夹回去，
 * 由播放页从目标点重转（后端 start=N）。
 *
 * <p>阈值留 2 秒余量：最后一个分片可能刚好在写，落在边界上会 404。
 */
export function seekOutsideProduced(
  target: number,
  aheadSeconds: number,
  startSeconds = 0,
): boolean {
  if (!Number.isFinite(target)) return false
  const start = startSeconds > 1 ? startSeconds : 0
  // 往回到黑场填充区：也要重转，否则用户看到的是黑屏
  if (start > 0 && target < start) return true
  return aheadSeconds > 0 && target > Math.max(start, aheadSeconds - 2)
}

/**
 * 重转起点：从目标点**回退 5 秒**。
 *
 * <p>目的有两个：① `-ss` 必须落在关键帧附近才能立刻出片，精确到秒容易切在
 * GOP 中间；② 播放器跳到目标点时前一段已经转好，不会又卡在首片。
 */
export const TRANSCODE_SEEK_BACK = 5

export function transcodeRestartStart(target: number): number {
  if (!Number.isFinite(target) || target <= 0) return 0
  return Math.max(0, Math.floor(target) - TRANSCODE_SEEK_BACK)
}

/** 提示文案里的时间（12:30 / 1:02:03）。 */
export function fmtSeekClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
