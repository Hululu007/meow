import { describe, expect, it, beforeEach } from 'vitest'
import { mergeHistory, mergeSearchWords } from '../src/stores/sync'
import { __resetPrefsCache } from '../src/stores/prefs'
import {
  applyRemoteHistory,
  clearProgress,
  getProgress,
  listHistory,
  pushHistory,
  saveProgress,
} from '../src/stores/history'
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

  // ---------------- 进度合并（ep_at 独立于 at） ----------------

  it('进度取 ep_at 较新的一侧，即使另一侧 at 更新', () => {
    // 本地：看到 1200s（进度较新）
    const local: HistoryItem = {
      ...mk('A', '1', 1000),
      pos: 1200,
      dur: 2400,
      ep: '第2集',
      ep_url: 'u2',
      ep_at: 9000,
    }
    // 远端：只在手机上点开过封面（at 更新），进度是旧的
    const remote: HistoryItem = {
      ...mk('A', '1', 9900, '远端名字'),
      pos: 60,
      dur: 2400,
      ep: '第2集',
      ep_url: 'u2',
      ep_at: 5000,
    }
    const [out] = mergeHistory([local], [remote])
    // 元信息用远端（at 新）
    expect(out.vod_name).toBe('远端名字')
    // 进度用本地（ep_at 新）
    expect(out.pos).toBe(1200)
    expect(out.ep_at).toBe(9000)
  })

  it('只有一侧有进度时保留它', () => {
    const withProg: HistoryItem = { ...mk('A', '1', 1000), pos: 300, ep_at: 1000 }
    const [out] = mergeHistory([withProg], [mk('A', '1', 9000)])
    expect(out.pos).toBe(300)
  })

  it('两侧都没有进度时不产生进度字段', () => {
    const [out] = mergeHistory([mk('A', '1', 1000)], [mk('A', '1', 9000)])
    expect(out.pos).toBeUndefined()
    expect(out.ep_at).toBeUndefined()
  })
})

// ---------------------------------------------------------------- 本地进度读写

describe('saveProgress / getProgress', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
    pushHistory({ site: 'A', siteName: 'A', vod_id: '1', vod_name: '片名', vod_pic: '' })
  })

  it('写入后能读回同一集的进度', () => {
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 600, dur: 2400, ep: '第1集', epUrl: 'u1' },
      { notify: false },
    )
    const p = getProgress({ site: 'A', vod_id: '1' }, 'u1')
    expect(p?.pos).toBe(600)
    expect(p?.dur).toBe(2400)
  })

  it('集地址不同时读不到别人的进度', () => {
    saveProgress({ site: 'A', vod_id: '1' }, { pos: 600, dur: 2400, epUrl: 'u1' }, { notify: false })
    expect(getProgress({ site: 'A', vod_id: '1' }, 'u2')).toBeNull()
  })

  it('换集时允许进度归零（新集从 0 开始）', () => {
    saveProgress({ site: 'A', vod_id: '1' }, { pos: 1200, dur: 2400, epUrl: 'u1' }, { notify: false })
    saveProgress({ site: 'A', vod_id: '1' }, { pos: 3, dur: 2400, epUrl: 'u2' }, { notify: false })
    expect(getProgress({ site: 'A', vod_id: '1' }, 'u2')?.pos).toBe(3)
  })

  it('同一集内拒绝大幅回退（防止旧集迟到写入）', () => {
    saveProgress({ site: 'A', vod_id: '1' }, { pos: 1200, dur: 2400, epUrl: 'u1' }, { notify: false })
    saveProgress({ site: 'A', vod_id: '1' }, { pos: 5, dur: 2400, epUrl: 'u1' }, { notify: false })
    expect(getProgress({ site: 'A', vod_id: '1' }, 'u1')?.pos).toBe(1200)
  })

  it('没有历史记录时不凭空造一条', () => {
    saveProgress({ site: 'Z', vod_id: '9' }, { pos: 10, dur: 100 }, { notify: false })
    expect(listHistory().some((x) => x.vod_id === '9')).toBe(false)
  })

  it('clearProgress 清掉进度但保留历史条目', () => {
    saveProgress({ site: 'A', vod_id: '1' }, { pos: 600, dur: 2400, epUrl: 'u1' }, { notify: false })
    clearProgress({ site: 'A', vod_id: '1' }, { notify: false })
    expect(getProgress({ site: 'A', vod_id: '1' }, 'u1')).toBeNull()
    expect(listHistory().some((x) => x.vod_id === '1')).toBe(true)
  })
})

describe('pushHistory 不丢已有进度', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
    pushHistory({ site: 'A', siteName: 'A', vod_id: '1', vod_name: '片名', vod_pic: '' })
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 900, dur: 2400, ep: '第3集', epUrl: 'u3' },
      { notify: false },
    )
  })

  it('再次点封面（只带元信息）不会清掉进度', () => {
    pushHistory({ site: 'A', siteName: 'A', vod_id: '1', vod_name: '片名', vod_pic: 'p.jpg' })
    const p = getProgress({ site: 'A', vod_id: '1' }, 'u3')
    expect(p?.pos).toBe(900)
    expect(listHistory()[0].vod_pic).toBe('p.jpg')
  })
})

// ---------------------------------------------------------------- 搜索关键词

describe('mergeSearchWords', () => {
  it('并集去重，保留先出现的顺序', () => {
    expect(mergeSearchWords(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------- 后端状态通道

describe('applyRemoteHistory（后端状态通道合并）', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
  })

  const remoteItem = (over: Partial<HistoryItem> = {}): HistoryItem => ({
    site: 'A',
    siteName: 'A',
    vod_id: '1',
    vod_name: '',
    vod_pic: '',
    at: 0,
    pos: 600,
    dur: 2400,
    ep: '第3集',
    ep_url: 'u3',
    ep_at: 5000,
    ...over,
  })

  it('合并远端进度但不改动本地片名/封面', () => {
    pushHistory({
      site: 'A',
      siteName: 'A',
      vod_id: '1',
      vod_name: '本地片名',
      vod_pic: 'p.jpg',
      at: 9000,
    })
    // 后端只回进度 8 个键，没有片名/封面/at —— 不能把本地元信息降级
    applyRemoteHistory([remoteItem()])
    const it = listHistory()[0]
    expect(it.vod_name).toBe('本地片名')
    expect(it.vod_pic).toBe('p.jpg')
    expect(it.pos).toBe(600)
    expect(it.ep_at).toBe(5000)
  })

  it('本地没有的片子用 vod_id 兜底显示名，时间用 ep_at', () => {
    applyRemoteHistory([remoteItem({ vod_id: 'abc', ep_at: 7000 })])
    const it = listHistory().find((x) => x.vod_id === 'abc')!
    expect(it.vod_name).toBe('abc')
    expect(it.at).toBe(7000)
  })

  it('不派发 meow:history-changed（否则拉取→上传→再拉取会死循环）', () => {
    let fired = 0
    const on = () => fired++
    window.addEventListener('meow:history-changed', on)
    try {
      applyRemoteHistory([remoteItem()])
    } finally {
      window.removeEventListener('meow:history-changed', on)
    }
    expect(fired).toBe(0)
  })

  it('空数组/坏数据不写盘也不报错', () => {
    expect(() => applyRemoteHistory([])).not.toThrow()
    expect(() =>
      applyRemoteHistory([{} as HistoryItem, { site: 'A' } as HistoryItem]),
    ).not.toThrow()
    expect(listHistory()).toEqual([])
  })
})

// ---------------------------------------------------------------- 跨线路进度

describe('换线路后同一集的进度必须还在', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
    pushHistory({ site: 'A', siteName: 'A', vod_id: '1', vod_name: '片名', vod_pic: '' })
  })

  it('集地址变了但集名一致，仍读得到进度（换线路的典型形状）', () => {
    // 线路一的第3集
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 900, dur: 2400, ep: '第3集', epUrl: 'https://line1/e3.m3u8' },
      { notify: false },
    )
    // 换到线路二，同一集的名字不变、地址必然不同
    const p = getProgress(
      { site: 'A', vod_id: '1' },
      'https://line2/e3.m3u8',
      '第3集',
    )
    expect(p?.pos).toBe(900)
  })

  it('集名不同时仍然读不到（不能把第3集的进度套到第4集）', () => {
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 900, dur: 2400, ep: '第3集', epUrl: 'https://line1/e3.m3u8' },
      { notify: false },
    )
    const p = getProgress(
      { site: 'A', vod_id: '1' },
      'https://line2/e4.m3u8',
      '第4集',
    )
    expect(p).toBeNull()
  })

  it('换线路后的新进度不会被"只能前进"守卫丢掉', () => {
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 1800, dur: 2400, ep: '第3集', epUrl: 'https://line1/e3.m3u8' },
      { notify: false },
    )
    // 换线路后从头看，位置比旧记录小得多——旧代码会当成"旧集迟到写入"丢弃
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 30, dur: 2400, ep: '第3集', epUrl: 'https://line2/e3.m3u8' },
      { notify: false },
    )
    expect(
      getProgress({ site: 'A', vod_id: '1' }, 'https://line2/e3.m3u8', '第3集')?.pos,
    ).toBe(30)
  })

  it('不传集名时退回严格 url 比较（老调用方行为不变）', () => {
    saveProgress(
      { site: 'A', vod_id: '1' },
      { pos: 900, dur: 2400, ep: '第3集', epUrl: 'https://line1/e3.m3u8' },
      { notify: false },
    )
    expect(getProgress({ site: 'A', vod_id: '1' }, 'https://line2/e3.m3u8')).toBeNull()
  })
})

describe('历史顺序：读出来必须是"新在前"（2026-11-05 用户要求逆序）', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
  })

  it('存储顺序被打乱时，listHistory 仍按 at 倒序返回', () => {
    // 真实成因：历史页补封面会逐条 pushHistory 回写，而 pushHistory 把命中的
    // 那条移到最前 —— 一次进页面就把"最新在前"重排成"最旧在前"
    // （实测 OECT：10月29日 排在 11月2日 前面）。
    localStorage.setItem(
      'meow.history.list',
      JSON.stringify([mk('A', 'old', 1000), mk('A', 'mid', 2000), mk('A', 'new', 3000)]),
    )
    expect(listHistory().map((x) => x.vod_id)).toEqual(['new', 'mid', 'old'])
  })

  it('pushHistory 回写后整体顺序依然按 at 倒序', () => {
    pushHistory(mk('A', '1', 1000), { notify: false })
    pushHistory(mk('A', '2', 2000), { notify: false })
    pushHistory(mk('A', '3', 3000), { notify: false })
    // 模拟"补封面"：把最旧那条回写一次（pushHistory 会把它提到数组最前）
    pushHistory(mk('A', '1', 1000), { notify: false })
    expect(listHistory().map((x) => x.vod_id)).toEqual(['3', '2', '1'])
  })

  it('远端进度晚到时会广播 meow:history-synced（页面据此刷新空列表）', () => {
    let fired = 0
    const on = () => (fired += 1)
    window.addEventListener('meow:history-synced', on)
    applyRemoteHistory([{ ...mk('A', '1', 5000), pos: 60, ep_at: 5000 }])
    window.removeEventListener('meow:history-synced', on)
    expect(fired).toBe(1)
    expect(listHistory()).toHaveLength(1)
  })
})
