import { beforeEach, describe, expect, it } from 'vitest'
import {
  addWatchTime,
  clearWatchStats,
  fmtDuration,
  getWatchStats,
  recentDays,
  summary,
} from '../src/stores/watchStats'
import {
  isUpdated,
  markSeen,
  getSeenRemarks,
  pruneRemarks,
  rememberRemarks,
  shouldCheck,
  markChecked,
} from '../src/stores/favUpdates'

describe('观看时长统计', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('累加后能读回，且今日汇总正确', () => {
    addWatchTime(10)
    addWatchTime(20)
    expect(summary().today).toBe(30)
    expect(getWatchStats().total).toBe(30)
  })

  it('单次超过 30 秒被截断（切后台回来不该算成看了几分钟）', () => {
    addWatchTime(300)
    expect(summary().today).toBe(30)
  })

  it('小于 1 秒不计数（暂停时的抖动不累加）', () => {
    addWatchTime(0.4)
    expect(summary().today).toBe(0)
  })

  it('recentDays 补零且长度正确', () => {
    addWatchTime(5)
    const d = recentDays(7)
    expect(d).toHaveLength(7)
    expect(d[d.length - 1].seconds).toBe(5)
    expect(d[0].seconds).toBe(0)
  })

  it('fmtDuration 分档正确', () => {
    expect(fmtDuration(30)).toBe('30 秒')
    expect(fmtDuration(120)).toBe('2 分钟')
    expect(fmtDuration(3600)).toBe('1 小时')
    expect(fmtDuration(3900)).toBe('1 小时 5 分')
  })

  it('清空后归零', () => {
    addWatchTime(60)
    clearWatchStats()
    expect(summary().total).toBe(0)
  })
})

describe('追剧更新提醒', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('收藏时记基线，remarks 变了才算更新', () => {
    rememberRemarks('s1', 'v1', '更新至第10集')
    expect(isUpdated('s1', 'v1', '更新至第10集')).toBe(false)
    expect(isUpdated('s1', 'v1', '更新至第12集')).toBe(true)
  })

  it('重复收藏不覆盖基线（否则永远不提醒）', () => {
    rememberRemarks('s1', 'v1', '更新至第10集')
    // 第二次收藏带的是新值，但基线必须保持第一次的
    rememberRemarks('s1', 'v1', '更新至第12集')
    expect(getSeenRemarks('s1', 'v1')).toBe('更新至第10集')
    // 因此拿"第12集"去比仍然判定为更新（这正是提醒该做的事）
    expect(isUpdated('s1', 'v1', '更新至第12集')).toBe(true)
  })

  it('基线为空、现在有值 → 算更新（2026-11-05 改：否则老收藏永不提醒）', () => {
    // 旧行为"两边都有值才比"，收藏时源站没给 remarks 的条目会永远沉默
    rememberRemarks('s1', 'v1', '')
    expect(isUpdated('s1', 'v1', '更新至第12集')).toBe(true)
    // 现在为空仍然不参与：源站抖动返回空 remarks 不是更新
    rememberRemarks('s2', 'v2', '全24集')
    expect(isUpdated('s2', 'v2', '')).toBe(false)
  })

  it('markSeen 之后不再提醒', () => {
    rememberRemarks('s1', 'v1', '更新至第10集')
    markSeen('s1', 'v1', '更新至第12集')
    expect(isUpdated('s1', 'v1', '更新至第12集')).toBe(false)
  })

  it('prune 只保留还在收藏里的记录', () => {
    rememberRemarks('s1', 'v1', 'A')
    rememberRemarks('s2', 'v2', 'B')
    pruneRemarks(['s1|v1'])
    expect(isUpdated('s2', 'v2', 'C')).toBe(false)
  })

  it('shouldCheck 首轮为真，markChecked 后为假', () => {
    expect(shouldCheck()).toBe(true)
    markChecked()
    expect(shouldCheck()).toBe(false)
  })
})
