import { describe, it, expect } from 'vitest'
import {
  danmakuHeatCounts,
  danmakuHeatGradient,
  danmakuHeatData,
  danmakuHeatGradientFromCounts,
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
    // 10 桶 × 2 个 stop
    expect(g.match(/rgba\(125,211,252,/g)?.length).toBe(20)
    // 25s 桶（密度 2）应比 0s 桶（密度 1）亮
    const alphas = [...g.matchAll(/rgba\(125,211,252,([0-9.]+)\)/g)].map((m) => Number(m[1]))
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
  })

  it('内嵌渐变色把 300 桶降采样到 ≤120 档', () => {
    const counts = new Array(300).fill(1)
    const g = danmakuHeatGradientFromCounts(counts, 1)
    expect(g.startsWith('linear-gradient')).toBe(true)
    // 降采样后 ≤120 档 × 2 stop
    const stops = g.match(/rgba\(125,211,252,/g)?.length ?? 0
    expect(stops).toBeGreaterThan(0)
    expect(stops).toBeLessThanOrEqual(240)
  })
})
