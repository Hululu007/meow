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

/** 峰谷配色唯一真源：面积填充/内嵌渐变都用这一支中性灰 */
export const HEAT_RGB = '102,102,110'

export interface DanmakuHeat {
  counts: number[]
  /** 每桶多少秒（画 tooltip 与定位用） */
  bucketSec: number
  /** 最大桶计数（归一化已按 γ 处理，调用方仍可用于文案） */
  max: number
  /** 归一化参考值：非零桶 p95（峰谷图用它当满格基准） */
  ref: number
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
  return { counts, bucketSec, max: Math.max(1, ...counts), ref: heatRefOf(counts) }
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
 * 归一化参考值：非零桶的 p95（桶太少时退化成最大值）。
 *
 * 用最大值当分母时，一个异常尖峰会把它下面的桶全压扁（实测 25% 的桶
 * 顶到上限，长段平顶）；p95 只让最高的 5% 撞顶，中间段才拉得开。
 */
export function heatRefOf(counts: number[]): number {
  const pos = counts.filter((c) => c > 0).sort((a, b) => a - b)
  if (!pos.length) return 1
  if (pos.length < 20) return Math.max(1, pos[pos.length - 1])
  return Math.max(1, pos[Math.floor((pos.length - 1) * 0.95)])
}

/**
 * 密度归一化高度（0–1）：sqrt + 12% 基线。
 *
 * 弹幕密度是长尾分布（中位桶只有峰值的 5%），线性映射会把几乎所有
 * 非零桶压到地板（用户 2026-11-20 反馈「不是过平就是只剩几根柱子」）。
 * sqrt 把低密度段抬成一条可读的带，峰顶仍拉满；12% 基线保证
 * 极稀疏段也有山脚。参考值用 p95（见 heatRefOf），避免单个尖峰压扁其余桶。
 */
export function heatLevel(count: number, ref: number): number {
  if (count <= 0) return 0
  return 0.12 + 0.88 * Math.sqrt(Math.min(1, count / Math.max(1, ref)))
}

/**
 * 峰谷面积路径（SVG，viewBox 0..100 双向拉伸）。
 *
 * <p>参考图是**连续山形**，不是一根根竖条：150 个柱子在 700px 宽里
 * 只隔 4.7px，带缺口会读成横脉冲。这里做两件事：
 * ① 3 抽头 [0.25,0.5,0.25] 平滑两遍，压掉单桶毛刺；
 * ② 二次贝塞尔穿过点中点，得到参考图那种圆滑山脊。
 *
 * 返回 `M...Q...L...Z` 的闭合路径，填充到条带底部。
 */
export function danmakuHeatPath(counts: number[], ref: number, passes = 2): string {
  if (!counts.length) return ''
  let c = counts.slice()
  for (let p = 0; p < passes; p++) {
    const next = c.slice()
    for (let i = 0; i < c.length; i++) {
      const l = c[Math.max(0, i - 1)]
      const r = c[Math.min(c.length - 1, i + 1)]
      next[i] = l * 0.25 + c[i] * 0.5 + r * 0.25
    }
    c = next
  }
  const n = c.length
  const xs = (i: number) => (n <= 1 ? 0 : (i * 100) / (n - 1))
  const ys = (i: number) => 100 - heatLevel(c[i], ref) * 100
  let d = `M0,${ys(0).toFixed(2)}`
  for (let i = 1; i < n; i++) {
    const mx = (xs(i - 1) + xs(i)) / 2
    const my = (ys(i - 1) + ys(i)) / 2
    d += `Q${xs(i - 1).toFixed(2)},${ys(i - 1).toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`
  }
  d += `L${xs(n - 1).toFixed(2)},${ys(n - 1).toFixed(2)}L100,100L0,100Z`
  return d
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
    // 与面积图同一支中性灰（HEAT_RGB），和青绿进度、白色缓冲区分
    const color = `rgba(${HEAT_RGB},${alpha.toFixed(3)})`
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
