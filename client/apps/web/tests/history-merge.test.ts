import { describe, expect, it, beforeEach } from 'vitest'
import { listHistory, pushHistory } from '@/stores/history'

/**
 * 历史记录合并规则 —— 「偶尔看不到海报」的直接成因。
 *
 * 实测（2026-10-30，本机 10 条历史）：`vod_pic` 全是空串。
 * 根因不是"源站没图"（同一部片 detail 里明明有封面），而是
 * `mergeInto` 用 `{...prev, ...next}`，后一次 push 带的空串把已有封面抹掉。
 * 播放页从历史页直达时 URL 不带封面，于是**每播一次就变空一次**。
 */
describe('pushHistory 合并', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('后续 push 带空 vod_pic 时，不覆盖已存好的封面', () => {
    pushHistory({ site: 's', vod_id: '1', vod_name: '片名', vod_pic: 'http://x/a.jpg', at: 1 })
    pushHistory({ site: 's', vod_id: '1', vod_name: '片名', vod_pic: '', at: 2 })
    const it = listHistory().find((x) => x.vod_id === '1')
    expect(it?.vod_pic).toBe('http://x/a.jpg')
  })

  it('非空新封面会覆盖旧封面（源站换图能跟上）', () => {
    pushHistory({ site: 's', vod_id: '2', vod_name: 'A', vod_pic: 'http://x/old.jpg', at: 1 })
    pushHistory({ site: 's', vod_id: '2', vod_name: 'A', vod_pic: 'http://x/new.jpg', at: 2 })
    expect(listHistory().find((x) => x.vod_id === '2')?.vod_pic).toBe('http://x/new.jpg')
  })

  it('空片名不覆盖已有片名（数字 id 当片名后补到真名不该被抹回）', () => {
    pushHistory({ site: 's', vod_id: '3', vod_name: '剑来第二季', at: 1 })
    pushHistory({ site: 's', vod_id: '3', vod_name: '', at: 2 })
    expect(listHistory().find((x) => x.vod_id === '3')?.vod_name).toBe('剑来第二季')
  })

  it('进度字段照旧：没传就沿用，传 0 也算有效值', () => {
    pushHistory({ site: 's', vod_id: '4', vod_name: 'B', at: 1 })
    pushHistory({ site: 's', vod_id: '4', vod_name: 'B', pos: 30, dur: 100, at: 2 })
    pushHistory({ site: 's', vod_id: '4', vod_name: 'B', pos: 0, at: 3 })
    const it = listHistory().find((x) => x.vod_id === '4')
    expect(it?.pos).toBe(0)
    expect(it?.dur).toBe(100)
  })

  it('同一部片只保留一条，且排到最前', () => {
    pushHistory({ site: 's', vod_id: '5', vod_name: 'C', at: 1 })
    pushHistory({ site: 's', vod_id: '6', vod_name: 'D', at: 2 })
    pushHistory({ site: 's', vod_id: '5', vod_name: 'C', at: 3 })
    const list = listHistory()
    expect(list.filter((x) => x.vod_id === '5')).toHaveLength(1)
    expect(list[0].vod_id).toBe('5')
  })
})
