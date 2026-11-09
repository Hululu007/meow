import { describe, expect, it } from 'vitest'
import { cleanDmTitle, epBadgeOf } from '@/utils/dmTitle'

/**
 * 弹幕候选标题解析（2026-10-31 用户报的问题 3）。
 *
 * 真实样本取自 danmu_api 的返回：`name` 是
 * `我不是大师(2026)【国产剧】第1集 from iqiyi` 这种长串，
 * 原来整条截断后列表里 94 条长得一模一样，看不出集数。
 */
describe('epBadgeOf 抽集数', () => {
  it('中文「第N集」', () => {
    expect(epBadgeOf({ name: '我不是大师(2026)【国产剧】第1集 from iqiyi' })).toBe('EP01')
    expect(epBadgeOf({ name: '我不是大师 第12集' })).toBe('EP12')
  })

  it('「第N话 / 第N期」也能认', () => {
    expect(epBadgeOf({ name: '某番 第3话' })).toBe('EP03')
    expect(epBadgeOf({ name: '某综艺 第7期' })).toBe('EP07')
  })

  it('EP05 / E5 / S01E05', () => {
    expect(epBadgeOf({ name: '繁花 EP05' })).toBe('EP05')
    expect(epBadgeOf({ name: '繁花 E5' })).toBe('EP05')
    expect(epBadgeOf({ name: 'Show S01E05' })).toBe('EP05')
  })

  it('显式 episode 字段优先于标题', () => {
    expect(epBadgeOf({ name: '第9集', episode: 3 })).toBe('EP03')
  })

  it('抽不到就返回空串（模板据此不渲染徽标）', () => {
    expect(epBadgeOf({ name: '我不是大师' })).toBe('')
    expect(epBadgeOf({})).toBe('')
  })

  it('两位以上集数不补零错位', () => {
    expect(epBadgeOf({ name: '第100集' })).toBe('EP100')
  })
})

describe('cleanDmTitle 洗标题', () => {
  it('去掉 from 后缀、年份、类型标签', () => {
    expect(cleanDmTitle('我不是大师(2026)【国产剧】第1集 from iqiyi'))
      .toBe('我不是大师第1集')
  })

  it('中文季数也要去掉（原来只写了 \\d+，第二季会被留下）', () => {
    expect(cleanDmTitle('庆余年 第二季 第03集')).toBe('庆余年 第03集')
    expect(cleanDmTitle('庆余年 第2季 第03集')).toBe('庆余年 第03集')
  })

  it('多个后缀一起出现也清得干净', () => {
    expect(cleanDmTitle('漫长的季节 第2季 第8集 from youku')).toBe('漫长的季节 第8集')
  })

  it('洗不出东西时保留原名，绝不返回空串', () => {
    expect(cleanDmTitle('繁花 EP05')).toBe('繁花 EP05')
    expect(cleanDmTitle('')).toBe('(无标题)')
    expect(cleanDmTitle(undefined)).toBe('(无标题)')
  })

  it('清掉删完残留的首尾分隔符', () => {
    expect(cleanDmTitle(' - 我不是大师 (2026) - ')).toBe('我不是大师')
  })
})
