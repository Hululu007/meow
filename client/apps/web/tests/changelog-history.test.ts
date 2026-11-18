/**
 * 「关于 → 版本历史」的数据层门禁（2026-11-18）。
 *
 * 数据源 = updates 分支的 history.json（由 deploy/scripts/gen-history.ps1 从
 * CHANGELOG.md 生成）。这里锁三件事：
 *  ① 解析必须**整份校验**：坏 JSON / 没 versions 直接抛，不展示半截数据；
 *  ② 候选地址要带 GitHub 加速（直连 + 代理 + jsDelivr），否则国内/TV 拉不到；
 *  ③ 候选轮询 + 会话缓存：第一条挂了要会自动试下一条。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearHistoryCache,
  fetchChangelogHistory,
  historyCandidates,
  historyUrl,
  parseHistory,
} from '../src/api/changelog'

const GOOD = JSON.stringify({
  schema_version: 1,
  versions: [
    { version: '1.2.16', date: '2026-11-18', lines: ['1. 修复 A', '2. 修复 B'] },
    { version: '1.2.15', date: '2026-11-17', lines: ['1. 修复 C'] },
  ],
})

beforeEach(() => {
  clearHistoryCache()
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('history.json 解析', () => {
  it('正常结构：版本与行文本都保留', () => {
    const list = parseHistory(GOOD)
    expect(list.map((v) => v.version)).toEqual(['1.2.16', '1.2.15'])
    expect(list[0].lines).toHaveLength(2)
  })

  it('发版日期：合法才保留，格式不对当没给（不显示怪字符串）', () => {
    const list = parseHistory(
      JSON.stringify({
        versions: [
          { version: '1.2.16', date: '2026-11-18', lines: ['a'] },
          { version: '1.2.15', date: '2026/11/17', lines: ['b'] },
          { version: '1.2.14', lines: ['c'] },
        ],
      }),
    )
    expect(list[0].date).toBe('2026-11-18')
    expect(list[1].date).toBeUndefined()
    expect(list[2].date).toBeUndefined()
  })

  it('单条坏了只跳过那一条（版本号非法 / lines 不是数组）', () => {
    const list = parseHistory(
      JSON.stringify({
        versions: [
          { version: '1.2.16', lines: ['ok'] },
          { version: 'v1.2.15', lines: ['非法版本号'] },
          { version: '1.2.14', lines: 'not-an-array' },
          { version: '1.2.13', lines: ['', '  ', '有内容'] },
        ],
      }),
    )
    expect(list.map((v) => v.version)).toEqual(['1.2.16', '1.2.13'])
    // 空行被剔掉
    expect(list[1].lines).toEqual(['有内容'])
  })

  it('坏 JSON / 没有 versions / 全空 → 抛错（不展示半截数据）', () => {
    expect(() => parseHistory('<html>404</html>')).toThrow(/不是 JSON/)
    expect(() => parseHistory('{"schema_version":1}')).toThrow(/versions/)
    expect(() => parseHistory('{"versions":[]}')).toThrow(/空/)
  })
})

describe('候选地址与轮询', () => {
  it('候选里同时有 raw 与 jsDelivr（加速链路不能只剩直连）', () => {
    const cands = historyCandidates()
    expect(cands.length).toBeGreaterThan(1)
    expect(cands[0]).toBe(historyUrl())
    expect(cands.some((u) => u.includes('cdn.jsdelivr.net'))).toBe(true)
  })

  it('第一条失败自动试下一条，成功后写缓存', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => GOOD })
    vi.stubGlobal('fetch', fetchMock)

    const list = await fetchChangelogHistory()
    expect(list).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 缓存命中：不再打网络
    await fetchChangelogHistory()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // force 重拉
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => GOOD })
    await fetchChangelogHistory(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('全部候选失败 → 抛最后一次的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '' }),
    )
    await expect(fetchChangelogHistory()).rejects.toThrow(/HTTP 403/)
  })
})
