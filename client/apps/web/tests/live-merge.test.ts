import { describe, expect, it } from 'vitest'
import {
  cleanChannelName,
  describeSources,
  mergeSources,
  normChannelName,
  sourceCountOf,
  zhGroupName,
  type ParsedSource,
} from '../src/api/liveMerge'

/**
 * 多源直播合并。
 *
 * 台名全部取自两个真实源（2026-11-06 拉取）：
 *   Guovin/iptv-api  → CCTV-1 / CCTV-1 HD / CCTV-6（中文分类）
 *   iptv-org/cn      → CCTV-1 (720p) / CCTV-6 [Geo-blocked] / Anhui TV（英文分类）
 */
describe('台名归一化：跨源同名识别', () => {
  it('同一台的三种写法归到同一个 key', () => {
    const keys = ['CCTV-1', 'CCTV-1 (720p)', 'CCTV-1 HD (1080p)'].map(normChannelName)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('cctv1')
  })

  it('★ CCTV-5 与 CCTV-5+ 是不同频道（不能并）', () => {
    expect(normChannelName('CCTV-5')).not.toBe(normChannelName('CCTV-5+'))
  })

  it('★ CCTV-4K 不能被并进 CCTV（4k 是频道名的一部分）', () => {
    expect(normChannelName('CCTV-4K HD (1080p)')).toBe('cctv4k')
    expect(normChannelName('CCTV-4K HD (1080p)')).not.toBe(normChannelName('CCTV HD'))
  })

  it('去掉来源标记 [Geo-blocked] / [Not 24/7]', () => {
    expect(normChannelName('CCTV-6 [Geo-blocked]')).toBe('cctv6')
    expect(normChannelName('CCTV-6')).toBe('cctv6')
    expect(normChannelName('CCTV+ 1 (600p) [Not 24/7]')).toBe('cctv+1')
  })

  it('中文清晰度词也去掉', () => {
    expect(normChannelName('湖南卫视高清')).toBe(normChannelName('湖南卫视'))
  })

  it('★ 中英文不同名不合并（宁并列，不误并）', () => {
    expect(normChannelName('Anhui TV')).not.toBe(normChannelName('安徽卫视'))
  })
})

describe('分组名中文化', () => {
  it('iptv-org 的英文分类映射成中文', () => {
    expect(zhGroupName('Undefined')).toBe('未分类')
    expect(zhGroupName('News')).toBe('新闻')
    expect(zhGroupName('General')).toBe('综合')
  })

  it('中文分类原样保留', () => {
    expect(zhGroupName('📺央视频道')).toBe('📺央视频道')
  })

  it('未命中的英文保留原文（不塞进"其他"）', () => {
    expect(zhGroupName('SomeWeirdCategory')).toBe('SomeWeirdCategory')
  })
})

describe('显示名清理', () => {
  it('去掉 [Geo-blocked] / [Not 24/7] 这类来源标记', () => {
    expect(cleanChannelName('CCTV-6 [Geo-blocked]')).toBe('CCTV-6')
    expect(cleanChannelName('Beijing Satellite TV [Not 24/7]')).toBe('Beijing Satellite TV')
    expect(cleanChannelName('CCTV+ 1 (600p) [Not 24/7]')).toBe('CCTV+ 1 (600p)')
  })

  it('保留画质后缀（有效信息）', () => {
    expect(cleanChannelName('CCTV-1 (720p)')).toBe('CCTV-1 (720p)')
  })
})

const guovin: ParsedSource = {
  name: 'Guovin',
  url: 'https://guovin.example/result.m3u',
  groups: [
    {
      group: '📺央视频道',
      channels: [
        { name: 'CCTV-1', urls: ['http://g/1a.m3u8', 'http://g/1b.m3u8'] },
        { name: 'CCTV-6', urls: ['http://g/6a.m3u8'] },
      ],
    },
    {
      group: '📡卫视频道',
      channels: [{ name: '湖南卫视', urls: ['http://g/hn.m3u8'] }],
    },
  ],
}

const iptvOrg: ParsedSource = {
  name: 'iptv-org',
  url: 'https://iptv.example/cn.m3u',
  groups: [
    {
      group: 'News',
      channels: [
        { name: 'CCTV-1 (720p)', urls: ['http://o/1.m3u8'] },
        // 同一个 URL 在两个源里都出现：只保留一条
        { name: 'CCTV-6 [Geo-blocked]', urls: ['http://g/6a.m3u8', 'http://o/6.m3u8'] },
      ],
    },
    {
      group: 'General',
      channels: [{ name: 'Anhui TV', urls: ['http://o/ah.m3u8'] }],
    },
  ],
}

describe('多源合并（方案 3：分类保留 + 线路池共享）', () => {
  it('同名台合并成一行，线路累加并标注来源', () => {
    const merged = mergeSources([guovin, iptvOrg])
    const cctv1 = merged.flatMap((g) => g.channels).find((c) => c.name === 'CCTV-1')
    expect(cctv1).toBeTruthy()
    expect(cctv1!.urls).toEqual(['http://g/1a.m3u8', 'http://g/1b.m3u8', 'http://o/1.m3u8'])
    expect(cctv1!.srcs).toEqual(['Guovin', 'Guovin', 'iptv-org'])
  })

  it('★ 同一个台在多个分类里各出现一次，但线路池完全相同', () => {
    // 用户反例：源1 的 A 有 CCTV1、源2 的 C 也有 CCTV1 —— 两个分类都要能看到它
    // （全局去重会让 C 少掉这个台，用户点进去找不到熟悉的台）
    const merged = mergeSources([guovin, iptvOrg])
    const groupsOfCctv1 = merged.filter((g) => g.channels.some((c) => c.name === 'CCTV-1'))
    expect(groupsOfCctv1.map((g) => g.group)).toEqual(['📺央视频道', '新闻'])
    const urls = groupsOfCctv1.map(
      (g) => g.channels.find((c) => c.name === 'CCTV-1')!.urls.join(','),
    )
    // 不论在哪个分类点它，都能切到全部 3 条线路
    expect(urls[0]).toBe(urls[1])
    expect(urls[0].split(',').length).toBe(3)
  })

  it('URL 去重（两源都列了同一地址）', () => {
    const merged = mergeSources([guovin, iptvOrg])
    const cctv6 = merged.flatMap((g) => g.channels).find((c) => c.name === 'CCTV-6')!
    expect(cctv6.urls).toEqual(['http://g/6a.m3u8', 'http://o/6.m3u8'])
    expect(cctv6.srcs).toEqual(['Guovin', 'iptv-org'])
  })

  it('★ 分类全部保留（不再有"台被搬走导致分类消失"）', () => {
    const merged = mergeSources([guovin, iptvOrg])
    expect(merged.map((g) => g.group)).toEqual(['📺央视频道', '📡卫视频道', '新闻', '综合'])
    // News 分类里的台没被搬走，且台名统一成了规范名（否则用户以为是两个不同的台）
    const news = merged.find((g) => g.group === '新闻')!
    expect(news.channels.map((c) => c.name)).toEqual(['CCTV-1', 'CCTV-6'])
  })

  it('preferUrl 只改线路顺序（池上重排，每个分类都生效）', () => {
    const merged = mergeSources([guovin, iptvOrg], iptvOrg.url)
    for (const g of merged) {
      const c = g.channels.find((x) => x.name === 'CCTV-1')
      if (!c) continue
      // iptv-org 排前面 → 它的线路成为 urls[0]（OK 默认播这条）
      expect(c.urls[0]).toBe('http://o/1.m3u8')
      expect(c.srcs[0]).toBe('iptv-org')
    }
    // 分类归属不变
    expect(merged.find((g) => g.channels.some((c) => c.name === 'CCTV-1'))!.group).toBe(
      '📺央视频道',
    )
  })

  it('没有 url 的频道直接丢弃（播不了）', () => {
    const merged = mergeSources([
      { name: 'x', url: 'u', groups: [{ group: 'g', channels: [{ name: '空台', urls: [] }] }] },
    ])
    expect(merged).toEqual([])
  })

  it('来源统计：sourceCountOf / describeSources', () => {
    const merged = mergeSources([guovin, iptvOrg])
    const cctv1 = merged.flatMap((g) => g.channels).find((c) => c.name === 'CCTV-1')!
    expect(sourceCountOf(cctv1)).toBe(2)
    expect(describeSources(cctv1)).toBe('Guovin 2 · iptv-org 1')
  })

  it('★ 两个源有同名分类时也只建一行台（跨源分类去重）', () => {
    const a: ParsedSource = {
      name: 's1', url: 'u1',
      groups: [{ group: '电影', channels: [{ name: 'CCTV6', urls: ['a1'] }] }],
    }
    const b: ParsedSource = {
      name: 's2', url: 'u2',
      groups: [{ group: '电影', channels: [{ name: 'CCTV6', urls: ['b1'] }] }],
    }
    const merged = mergeSources([a, b])
    expect(merged).toHaveLength(1)
    expect(merged[0].channels).toHaveLength(1)
    expect(merged[0].channels[0].urls).toEqual(['a1', 'b1'])
  })

  it('★ 用户反例：源1-A/CCTV1、源2-C/CCTV1 —— C 分类一个台都不能少', () => {
    // 用户原话：「1、2 为不同源，A B C 为分类…那此时左侧列表、右侧列表怎么显示？」
    const s1: ParsedSource = {
      name: '源1', url: 'u1',
      groups: [
        { group: 'A', channels: [{ name: 'CCTV1', urls: ['1a', '1b'] }] },
        { group: 'B', channels: [{ name: 'XXX', urls: ['1x'] }, { name: 'XXY', urls: ['1y'] }] },
      ],
    }
    const s2: ParsedSource = {
      name: '源2', url: 'u2',
      groups: [
        {
          group: 'C',
          channels: [
            { name: 'XXX', urls: ['2x'] },
            { name: 'YIUO', urls: ['2y'] },
            { name: 'CCTV1', urls: ['2c'] },
          ],
        },
      ],
    }
    const out = mergeSources([s1, s2])
    const A = out.find((g) => g.group === 'A')!
    const B = out.find((g) => g.group === 'B')!
    const C = out.find((g) => g.group === 'C')!
    // 左列三个分类都在，台数一个不少
    expect(A.channels.map((c) => c.name)).toEqual(['CCTV1'])
    expect(B.channels.map((c) => c.name)).toEqual(['XXX', 'XXY'])
    expect(C.channels.map((c) => c.name)).toEqual(['XXX', 'YIUO', 'CCTV1'])
    // 右列线路池共享：在哪个分类点，都是全部线路
    expect(A.channels[0].urls).toEqual(['1a', '1b', '2c'])
    expect(C.channels[0].urls).toEqual(['1x', '2x'])
    expect(C.channels[2].urls).toEqual(['1a', '1b', '2c'])
  })
})
