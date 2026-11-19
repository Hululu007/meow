/**
 * 弹幕时间轴热度：按片长自适应分桶，供进度条上方的“峰谷图”
 * 或进度条内部热力底色使用。
 *
 * <p>桶宽取 `ceil(片长 / maxBuckets)` 秒（至少 1 秒）：
 * 100 秒 → 1 秒/桶；45 分钟 → 9 秒/桶、最多 300 桶。
 * 长片不会被固定 60 桶抹平，短片也不会一个桶占半分钟。
 *
 * <p>纯函数，方便单测；空列表/片长未知返回 null。
 */
export interface DanmakuHeat {
  counts: number[]
  /** 每桶多少秒（画 tooltip 与定位用） */
  bucketSec: number
  /** 最大桶计数（归一化已按 sqrt 处理，调用方仍可用于文案） */
  max: number
}

export function danmakuHeatData(
  list: Array<{ time: number }>,
  durationSec: number,
  maxBuckets = 300,
): DanmakuHeat | null {
  if (!(durationSec > 0) || !Number.isFinite(durationSec) || !list.length) return null
  const cap = Math.max(1, Math.floor(maxBuckets))
  const bucketSec = Math.max(1, Math.ceil(durationSec / cap))
  const buckets = Math.max(1, Math.ceil(durationSec / bucketSec))
  const counts = new Array<number>(buckets).fill(0)
  for (const d of list) {
    if (!(d.time >= 0) || d.time > durationSec) continue
    const i = Math.min(buckets - 1, Math.floor(d.time / bucketSec))
    counts[i]++
  }
  return { counts, bucketSec, max: Math.max(1, ...counts) }
}

/** 兼容旧调用：只要桶数组时用这个 */
export function danmakuHeatCounts(
  list: Array<{ time: number }>,
  durationSec: number,
  buckets = 60,
): number[] | null {
  return danmakuHeatData(list, durationSec, buckets)?.counts ?? null
}

/**
 * 密度归一化高度（0–1）：sqrt 让中等密度也看得见，
 * 线性时 90% 的桶都接近贴地。
 */
export function heatLevel(count: number, max: number): number {
  return Math.sqrt(Math.max(0, count) / Math.max(1, max))
}

/**
 * 供进度条内部热力底色用：把 counts 降采样到 ≤120 档，
 * 生成 CSS 渐变（300 桶直接铺会得到 600 个 stop，太长）。
 */
export function danmakuHeatGradientFromCounts(counts: number[], max: number, samples = 120): string {
  if (!counts.length) return ''
  const step = Math.max(1, Math.ceil(counts.length / Math.max(1, samples)))
  const merged: number[] = []
  for (let i = 0; i < counts.length; i += step) {
    let sum = 0
    let n = 0
    for (let j = i; j < Math.min(counts.length, i + step); j++) {
      sum += counts[j]
      n++
    }
    merged.push(n ? sum / n : 0)
  }
  const m = Math.max(1, max)
  const stops: string[] = []
  for (let i = 0; i < merged.length; i++) {
    const a = (i * 100) / merged.length
    const b = ((i + 1) * 100) / merged.length
    const alpha = 0.1 + 0.75 * heatLevel(merged[i], m)
    const color = `rgba(125,211,252,${alpha.toFixed(3)})`
    stops.push(`${color} ${a.toFixed(2)}%`, `${color} ${b.toFixed(2)}%`)
  }
  return `linear-gradient(to right, ${stops.join(',')})`
}

/** 兼容旧调用：直接从弹幕列表生成渐变 */
export function danmakuHeatGradient(
  list: Array<{ time: number }>,
  durationSec: number,
  buckets = 60,
): string {
  const data = danmakuHeatData(list, durationSec, buckets)
  return data ? danmakuHeatGradientFromCounts(data.counts, data.max, buckets) : ''
}
