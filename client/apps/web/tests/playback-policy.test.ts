import { describe, expect, it } from 'vitest'
import {
  capLevelForRate,
  shouldDropRate,
  shouldRestoreRate,
} from '../src/components/player/playbackPolicy'

const levels = [
  { bitrate: 1_000_000 },
  { bitrate: 2_000_000 },
  { bitrate: 4_000_000 },
]

describe('倍速联动降档', () => {
  it('1x 不限制', () => {
    expect(capLevelForRate(levels, 10_000_000, 1)).toBe(-1)
  })

  it('带宽 3Mbps + 1.25x：2M 档刚好（2×1.25=2.5 ≤ 2.4？不）', () => {
    // 2.0 × 1.25 = 2.5；3.0 × 0.8 = 2.4 → 不够，只能 1M 档
    expect(capLevelForRate(levels, 3_000_000, 1.25)).toBe(0)
  })

  it('带宽 4Mbps + 1.25x：2M 档够用（2.5 ≤ 3.2）', () => {
    expect(capLevelForRate(levels, 4_000_000, 1.25)).toBe(1)
  })

  it('带宽很紧时落到最低档，不返回 -1', () => {
    expect(capLevelForRate(levels, 500_000, 1.25)).toBe(0)
  })

  it('没有带宽估计/没有档位时不干预', () => {
    expect(capLevelForRate(levels, 0, 1.25)).toBe(-1)
    expect(capLevelForRate([], 5_000_000, 1.25)).toBe(-1)
  })
})

describe('欠载临时降速', () => {
  it('第一次缓冲不降速', () => {
    expect(shouldDropRate({ wantedRate: 1.25, dropped: false, hits: 1, bufferedAhead: 0 })).toBe(false)
  })

  it('连续两次 + 垫子见底才降', () => {
    expect(shouldDropRate({ wantedRate: 1.25, dropped: false, hits: 2, bufferedAhead: 0.5 })).toBe(true)
    expect(shouldDropRate({ wantedRate: 1.25, dropped: false, hits: 2, bufferedAhead: 3 })).toBe(false)
  })

  it('1x 不降（本来就没得降）', () => {
    expect(shouldDropRate({ wantedRate: 1, dropped: false, hits: 5, bufferedAhead: 0 })).toBe(false)
  })

  it('已经在降速状态不重复降', () => {
    expect(shouldDropRate({ wantedRate: 1.25, dropped: true, hits: 5, bufferedAhead: 0 })).toBe(false)
  })
})

describe('缓冲恢复后回到用户倍速', () => {
  it('观察不够久不恢复', () => {
    expect(shouldRestoreRate({ dropped: true, sinceMs: 3_000, bufferedAhead: 60 })).toBe(false)
  })

  it('缓冲不够深不恢复', () => {
    expect(shouldRestoreRate({ dropped: true, sinceMs: 10_000, bufferedAhead: 5 })).toBe(false)
  })

  it('观察够久且缓冲够深 → 恢复', () => {
    expect(shouldRestoreRate({ dropped: true, sinceMs: 9_000, bufferedAhead: 25 })).toBe(true)
  })

  it('没降过速就不谈恢复', () => {
    expect(shouldRestoreRate({ dropped: false, sinceMs: 99_000, bufferedAhead: 99 })).toBe(false)
  })
})
