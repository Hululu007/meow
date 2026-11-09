import { describe, it, expect } from 'vitest'
import { dayKey, dayLabel, groupByDay } from '../src/utils/historyGroup'

/**
 * 历史按天分组（2026-11-03 用户要求「按每日观看拆分加日期小标题」）。
 *
 * 容易写错的三处都在这里锁住：
 *   · `toISOString` 是 UTC，晚上 8 点后会跨天（必须用本地时区）
 *   · 「今天/昨天」要同时给相对说法和具体日期（只说"今天"不知道几号）
 *   · 跨年要写年份，同年不写（否则每隔一行重复 2026）
 */

/** 构造本地时间戳：不依赖运行机器的时区 */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime()
}

const NOW = at(2026, 11, 3, 10, 0)

describe('dayKey 用本地时区而不是 UTC', () => {
  it('深夜 23:30 仍算当天', () => {
    expect(dayKey(at(2026, 11, 3, 23, 30))).toBe('2026-11-03')
  })

  it('凌晨 00:20 算新的一天', () => {
    expect(dayKey(at(2026, 11, 4, 0, 20))).toBe('2026-11-04')
  })

  it('补零', () => {
    expect(dayKey(at(2026, 1, 5))).toBe('2026-01-05')
  })
})

describe('dayLabel 的三个层次', () => {
  it('今天：相对说法 + 具体日期', () => {
    expect(dayLabel('2026-11-03', NOW)).toBe('今天 · 11月3日')
  })

  it('昨天：同样带日期', () => {
    expect(dayLabel('2026-11-02', NOW)).toBe('昨天 · 11月2日')
  })

  it('今年内：月日 + 星期，不写年份', () => {
    const l = dayLabel('2026-10-31', NOW)
    expect(l).toBe('10月31日 周六')
    expect(l).not.toContain('2026')
  })

  it('跨年：必须带年份（年份是定位关键）', () => {
    expect(dayLabel('2025-12-31', NOW)).toBe('2025年12月31日 周三')
  })

  it('跨年的"昨天"仍然写昨天（12月31日 → 1月1日）', () => {
    const newYear = at(2027, 1, 1, 9, 0)
    expect(dayLabel('2026-12-31', newYear)).toBe('昨天 · 12月31日')
  })

  it('跨月边界的"昨天"（11月1日 → 10月31日）', () => {
    const n = at(2026, 11, 1, 9, 0)
    expect(dayLabel('2026-10-31', n)).toBe('昨天 · 10月31日')
  })
})

describe('groupByDay 切段不重排', () => {
  const items = [
    { at: at(2026, 11, 3, 10, 12), name: '异物志' },
    { at: at(2026, 11, 3, 9, 5), name: '小城良方' },
    { at: at(2026, 11, 3, 1, 30), name: '我不是大师' },
    { at: at(2026, 11, 2, 22, 40), name: '庆余年第二季' },
    { at: at(2026, 11, 2, 20, 10), name: '空枪' },
    { at: at(2025, 12, 31, 21, 0), name: '毛骗' },
  ]

  it('按天切成 3 段，组数与顺序正确', () => {
    const g = groupByDay(items, NOW)
    expect(g.map((x) => x.key)).toEqual(['2026-11-03', '2026-11-02', '2025-12-31'])
    expect(g.map((x) => x.items.length)).toEqual([3, 2, 1])
  })

  it('组内保持原顺序（最近打开的在最前）', () => {
    const g = groupByDay(items, NOW)
    expect(g[0].items.map((x) => x.name)).toEqual(['异物志', '小城良方', '我不是大师'])
  })

  it('每段带好小标题', () => {
    const g = groupByDay(items, NOW)
    expect(g[0].label).toBe('今天 · 11月3日')
    expect(g[1].label).toBe('昨天 · 11月2日')
    expect(g[2].label).toBe('2025年12月31日 周三')
  })

  it('空列表 → 空分组，不报错', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })

  it('同一天但跨午夜的两条不会被合并', () => {
    const g = groupByDay(
      [
        { at: at(2026, 11, 3, 23, 59), name: 'a' },
        { at: at(2026, 11, 4, 0, 1), name: 'b' },
      ],
      at(2026, 11, 4, 10, 0),
    )
    expect(g).toHaveLength(2)
  })
})
