/**
 * 弹幕质量统计：给播放信息面板用，帮助判断「这集弹幕少/分布怪」是
 * 源数据问题还是渲染问题。
 *
 * <p>不是评分，只给三个可核对的事实：
 *  - 模式分布（滚动/顶/底）：聚合源常常只有滚动；
 *  - 覆盖片长（最大弹幕时间 / 视频时长）：明显小于 1 说明源不完整或集错；
 *  - 分布集中度（最大 10% 区间的占比）：>55% 说明时间轴可能错位。
 */
export interface DmQualityStats {
  count: number
  scroll: number
  top: number
  bottom: number
  /** 最大弹幕时间（秒） */
  maxTime: number
  /** 最大弹幕时间 / 片长，0–1；片长未知时为 0 */
  cover: number
  /** 最大一个桶占全部弹幕的比例，0–1 */
  peakShare: number
}

export function dmQualityStats(
  list: Array<{ time: number; mode: number }>,
  durationSec: number,
  buckets = 10,
): DmQualityStats {
  let scroll = 0
  let top = 0
  let bottom = 0
  let maxTime = 0
  for (const d of list) {
    if (d.mode === 5) top++
    else if (d.mode === 4) bottom++
    else scroll++
    if (d.time > maxTime) maxTime = d.time
  }
  const count = list.length
  const dur = durationSec > 0 && Number.isFinite(durationSec) ? durationSec : 0
  const cover = dur > 0 ? Math.min(1, maxTime / dur) : 0
  let peakShare = 0
  if (count > 0 && dur > 0) {
    const n = Math.max(1, Math.floor(buckets))
    const width = dur / n
    const counts = new Array<number>(n).fill(0)
    for (const d of list) {
      if (!(d.time >= 0)) continue
      const i = Math.min(n - 1, Math.floor(d.time / width))
      counts[i]++
    }
    peakShare = Math.max(...counts) / count
  }
  return { count, scroll, top, bottom, maxTime, cover, peakShare }
}

/** 面板上的一句话提示；没有异常返回空串。 */
export function dmQualityWarn(s: DmQualityStats): string {
  if (s.count <= 0) return ''
  if (s.cover > 0 && s.cover < 0.8 && s.count > 200) return '覆盖不足'
  if (s.peakShare > 0.55 && s.count > 500) return '分布集中'
  return ''
}
