import { describe, it, expect } from 'vitest'
import {
  danmakuHeatCounts,
  heatRefOf,
  danmakuHeatGradient,
  danmakuHeatData,
  danmakuHeatGradientFromCounts,
  danmakuHeatPath,
  heatLevel,
} from '../src/components/player/dmHeat'

describe('弹幕时间轴热度', () => {
  const list = [
    { time: 0 },
    { time: 5 },
    { time: 15 },
    { time: 25 },
    { time: 25.5 },
    { time: 95 },
  ]

  it('按时间分桶，总和守恒', () => {
    const c = danmakuHeatCounts(list, 100, 10)
    expect(c).not.toBeNull()
    expect(c!.reduce((a, b) => a + b, 0)).toBe(list.length)
    expect(c![0]).toBe(2) // 0s + 5s
    expect(c![1]).toBe(1) // 15s
    expect(c![2]).toBe(2) // 25 / 25.5
    expect(c![9]).toBe(1) // 95s
  })

  it('片长未知/空列表返回 null / 空串', () => {
    expect(danmakuHeatCounts(list, 0)).toBeNull()
    expect(danmakuHeatCounts([], 100)).toBeNull()
    expect(danmakuHeatGradient(list, 0)).toBe('')
  })

  it('渐变包含全部桶，峰值桶更亮', () => {
    const g = danmakuHeatGradient(list, 100, 10)
    expect(g.startsWith('linear-gradient(to right,')).toBe(true)
    // 10 桶 × 2 个 stop（中性灰 neutral-400）
    expect(g.match(/rgba\(102,102,110,/g)?.length).toBe(20)
    // 25s 桶（密度 2）应比 0s 桶（密度 1）亮
    const alphas = [...g.matchAll(/rgba\(102,102,110,([0-9.]+)\)/g)].map((m) => Number(m[1]))
    expect(alphas[4]).toBeGreaterThan(alphas[2])
  })

  it('超出片长的弹幕不计入（与可用口径一致）', () => {
    const c = danmakuHeatCounts([{ time: 101 }], 100, 10)
    expect(c!.reduce((a, b) => a + b, 0)).toBe(0)
  })
})

describe('自适应分桶（B 站同款峰谷）', () => {
  it('100 秒 → 1 秒/桶、100 桶', () => {
    const d = danmakuHeatData([{ time: 1 }, { time: 99 }], 100, 300)
    expect(d!.bucketSec).toBe(1)
    expect(d!.counts).toHaveLength(100)
  })

  it('45 分钟 → 9 秒/桶、最多 300 桶（长片不被 60 桶抹平）', () => {
    const d = danmakuHeatData([{ time: 1 }], 2700, 300)
    expect(d!.bucketSec).toBe(9)
    expect(d!.counts.length).toBeLessThanOrEqual(300)
    expect(d!.counts).toHaveLength(300)
  })

  it('heatLevel 单调且 0 计数为 0', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(10, 10)).toBe(1)
    expect(heatLevel(4, 10)).toBeGreaterThan(heatLevel(1, 10))
    // sqrt + 12% 基线：极稀疏的桶也有山脚（参考图效果），不会整条贴地
    expect(heatLevel(1, 10)).toBeGreaterThanOrEqual(0.12)
    // 峰值与中段要拉得开：中段（半峰）约七成，谷底（1/10）不到四成
    expect(heatLevel(5, 10)).toBeLessThan(0.8)
    expect(heatLevel(1, 10)).toBeLessThan(0.4)
  })

  it('归一化参考取非零桶 p95，单个尖峰压不扁其余桶', () => {
    const counts = [...new Array(99).fill(100), 10000]
    const ref = heatRefOf(counts)
    expect(ref).toBe(100)
    expect(heatLevel(100, ref)).toBe(1)
    expect(heatLevel(100, Math.max(...counts))).toBeLessThan(0.25)
  })

  it('内嵌渐变色把 300 桶降采样到 ≤120 档', () => {
    const counts = new Array(300).fill(1)
    const g = danmakuHeatGradientFromCounts(counts, 1)
    expect(g.startsWith('linear-gradient')).toBe(true)
    // 降采样后 ≤120 档 × 2 stop
    const stops = g.match(/rgba\(102,102,110,/g)?.length ?? 0
    expect(stops).toBeGreaterThan(0)
    expect(stops).toBeLessThanOrEqual(240)
  })
})

describe('峰谷面积路径（SVG）', () => {
  it('空桶返回空串，正常桶闭合到条带底部', () => {
    expect(danmakuHeatPath([], 10)).toBe('')
    const d = danmakuHeatPath([1, 2, 3, 4, 5], 5)
    expect(d.startsWith('M0,')).toBe(true)
    expect(d.endsWith('L100,100L0,100Z')).toBe(true)
    expect(d).not.toMatch(/NaN|Infinity/)
  })

  it('单桶也能画出有效路径（不除以 0）', () => {
    const d = danmakuHeatPath([7], 10)
    expect(d).toContain('M0,')
    expect(d.endsWith('Z')).toBe(true)
  })

  it('平滑削掉单桶毛刺：孤立尖峰不会顶满整条带', () => {
    const counts = new Array(30).fill(10)
    counts[15] = 1000
    const d = danmakuHeatPath(counts, 1000, 2)
    // 尖峰两侧的点被 [0.25,0.5,0.25] 两遍平滑后仍应保留坡形，
    // 但不能出现两段完全相同的顶边（说明尖峰被抹成方波）
    const ys = [...d.matchAll(/Q[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]))
    expect(Math.min(...ys)).toBeLessThan(60)
    expect(new Set(ys).size).toBeGreaterThan(3)
  })
})
