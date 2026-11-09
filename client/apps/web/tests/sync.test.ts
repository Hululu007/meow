import { describe, expect, it, beforeEach } from 'vitest'
import { mergeHistory, mergeSearchWords } from '../src/stores/sync'
import { __resetPrefsCache } from '../src/stores/prefs'
import type { HistoryItem } from '../src/stores/history'

const mk = (site: string, id: string, at: number, name = ''): HistoryItem => ({
  site,
  siteName: site,
  vod_id: id,
  vod_name: name || `${site}-${id}`,
  vod_pic: '',
  at,
})

describe('mergeHistory（历史并集）', () => {
  beforeEach(() => {
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
  })

  it('同一条记录保留时间较新的', () => {
    const out = mergeHistory([mk('A', '1', 5000, '本地较旧')], [mk('A', '1', 9000, '远端较新')])
    expect(out).toHaveLength(1)
    expect(out[0].vod_name).toBe('远端较新')
  })

  it('两侧独有的记录都保留（各端都能写）', () => {
    const out = mergeHistory([mk('A', '1', 1000)], [mk('A', '2', 2000)])
    expect(out.map((x) => x.vod_id).sort()).toEqual(['1', '2'])
  })

  it('结果按时间倒序', () => {
    const out = mergeHistory([mk('A', '1', 1000), mk('A', '2', 3000)], [mk('A', '3', 2000)])
    expect(out.map((x) => x.at)).toEqual([3000, 2000, 1000])
  })

  it('不同站点相同 id 不会被误合并', () => {
    expect(mergeHistory([mk('A', '1', 1000)], [mk('B', '1', 2000)])).toHaveLength(2)
  })

  it('丢弃格式不完整的记录', () => {
    const out = mergeHistory([mk('A', '1', 1000)], [{} as HistoryItem, { site: 'A' } as HistoryItem])
    expect(out).toHaveLength(1)
  })

  it('超过上限时按时间截断', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 2 }))
    __resetPrefsCache()
    const out = mergeHistory([mk('A', '1', 1000), mk('A', '2', 2000)], [mk('A', '3', 3000)])
    expect(out).toHaveLength(2)
    expect(out.map((x) => x.vod_id)).toEqual(['3', '2'])
  })
})

// ---------------------------------------------------------------- 搜索关键词

describe('mergeSearchWords', () => {
  it('并集去重，保留先出现的顺序', () => {
    expect(mergeSearchWords(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('过滤空串和纯空格', () => {
    expect(mergeSearchWords(['a', '', '  '], ['b'])).toEqual(['a', 'b'])
  })

  it('最多保留 20 个', () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`)
    expect(mergeSearchWords(many, []).length).toBe(20)
  })
})
