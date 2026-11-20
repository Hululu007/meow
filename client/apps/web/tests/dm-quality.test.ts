import { describe, it, expect } from 'vitest'
import { dmQualityStats, dmQualityWarn } from '../src/components/player/dmQuality'

const mk = (time: number, mode = 1) => ({ time, mode })

describe('弹幕质量统计（播放信息面板）', () => {
  it('按模式分开计数', () => {
    const s = dmQualityStats([mk(1, 1), mk(2, 5), mk(3, 5), mk(4, 4)], 100)
    expect(s.count).toBe(4)
    expect(s.scroll).toBe(1)
    expect(s.top).toBe(2)
    expect(s.bottom).toBe(1)
  })

  it('覆盖片长 = 最大弹幕时间 / 片长，夹到 1', () => {
    expect(dmQualityStats([mk(10), mk(40)], 100).cover).toBe(0.4)
    expect(dmQualityStats([mk(10), mk(120)], 100).cover).toBe(1)
    expect(dmQualityStats([mk(10)], 0).cover).toBe(0)
  })

  it('分布集中度：全部落在前 10% 时为 1', () => {
    const list = Array.from({ length: 100 }, (_, i) => mk(i % 10))
    expect(dmQualityStats(list, 100, 10).peakShare).toBe(1)
    const even = Array.from({ length: 100 }, (_, i) => mk((i / 100) * 100))
    expect(dmQualityStats(even, 100, 10).peakShare).toBeLessThan(0.2)
  })

  it('告警：覆盖不足 / 分布集中；样本太小时不报', () => {
    expect(dmQualityWarn({ count: 300, scroll: 300, top: 0, bottom: 0, maxTime: 10, cover: 0.1, peakShare: 0.2 })).toBe('覆盖不足')
    expect(dmQualityWarn({ count: 600, scroll: 600, top: 0, bottom: 0, maxTime: 100, cover: 1, peakShare: 0.9 })).toBe('分布集中')
    expect(dmQualityWarn({ count: 50, scroll: 50, top: 0, bottom: 0, maxTime: 10, cover: 0.1, peakShare: 0.9 })).toBe('')
    expect(dmQualityWarn({ count: 0, scroll: 0, top: 0, bottom: 0, maxTime: 0, cover: 0, peakShare: 0 })).toBe('')
  })
})
