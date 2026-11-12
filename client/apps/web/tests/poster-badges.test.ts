/**
 * 海报角标：评分（右上）与集数（左下）的分配规则。
 *
 * 用户口径（2026-11-12）：「海报右上角显示评分、左下角显示集数」，
 * 而且两者都有时要同时显示 —— 豆瓣剧集原来只给集数，评分被后端丢掉。
 */
import { describe, expect, it } from 'vitest'
import { isScoreRemarks, posterBadges } from '../src/utils/remarks'

describe('海报角标分配', () => {
  it('既有评分又有集数时两个都显示', () => {
    expect(posterBadges({ vod_remarks: '30集全', vod_score: '8.1' })).toEqual({
      score: '8.1',
      remark: '30集全',
    })
  })

  it('老后端只有 remarks：纯评分仍走右上，集数走左下', () => {
    expect(posterBadges({ vod_remarks: '8.8' })).toEqual({ score: '8.8', remark: '' })
    expect(posterBadges({ vod_remarks: '更新至15集' })).toEqual({ score: '', remark: '更新至15集' })
  })

  it('整数不当评分（CMS 源的「12」是第 12 集）', () => {
    expect(posterBadges({ vod_remarks: '12' })).toEqual({ score: '', remark: '12' })
    expect(isScoreRemarks('12')).toBe(false)
  })

  it('显式 vod_score 归一成一位小数；0 / 脏值不显示', () => {
    expect(posterBadges({ vod_score: '8' }).score).toBe('8.0')
    expect(posterBadges({ vod_score: '8.85' }).score).toBe('8.9')
    expect(posterBadges({ vod_score: '0' }).score).toBe('')
    expect(posterBadges({ vod_score: 'abc' }).score).toBe('')
  })

  it('remarks 本身就是评分时不重复出现在左下', () => {
    // 老后端电影：remarks = "8.8"，不该同时渲染成集数
    expect(posterBadges({ vod_remarks: '8.8', vod_score: '8.8' })).toEqual({
      score: '8.8',
      remark: '',
    })
  })
})
