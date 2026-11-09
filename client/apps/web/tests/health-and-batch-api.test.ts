import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 新增的源健康 / 整季缓存端点：路径与请求体必须和后端 handler 逐字对齐。
 *
 * 这几条是端点的"契约测试"：路径写错时后端不会 404 报错——`/api/health/*`
 * 与 `/api/cache/*` 都有前缀兜底，会被当成文件路径或未知子端点，
 * 报出"文件没缓存""unknown health endpoint"这种把人带偏的信息。
 * 所以在这里钉死 URL 与方法，而不是依赖联调时才发现。
 *
 * 后端依据：ApiServer.java 的 probeSites / handleHealthDegrade /
 * handleCacheBatch / handleCacheStatus / handleCacheTasks / handleCacheResume。
 */
const calls: Array<{ url: string; method: string; body: unknown }> = []

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

beforeEach(() => {
  calls.length = 0
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: (init?.method as string) || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return okJson({ ok: true })
    }),
  )
})

describe('源健康端点', () => {
  it('探活不带 sites 时发空对象（后端据此探全表）', async () => {
    const { probeSites } = await import('../src/api/health')
    await probeSites()
    expect(calls[0].url).toBe('/api/health/probe')
    expect(calls[0].method).toBe('POST')
    // 关键：必须是 {}，不能是 { sites: [] }——后者在后端也是探全表，
    // 但空数组与"不传"语义相反，写错时排查会绕远路
    expect(calls[0].body).toEqual({})
  })

  it('探活指定站点时原样透传', async () => {
    const { probeSites } = await import('../src/api/health')
    await probeSites(['A', 'B'])
    expect(calls[0].body).toEqual({ sites: ['A', 'B'] })
  })

  it('停用/恢复用 sites 数组 + disabled 布尔', async () => {
    const { setSitesDisabled } = await import('../src/api/health')
    await setSitesDisabled(['A'], true)
    expect(calls[0].url).toBe('/api/health/degrade')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ sites: ['A'], disabled: true })
  })

  it('明细走 GET /api/health/state', async () => {
    const { fetchHealthState } = await import('../src/api/health')
    await fetchHealthState()
    expect(calls[0].url).toBe('/api/health/state')
    expect(calls[0].method).toBe('GET')
  })
})

describe('整季缓存端点', () => {
  it('批量下载发 site/vodId/items，且不带 site/vodId 进每一集', async () => {
    const { startBatchCache } = await import('../src/api/library')
    await startBatchCache({
      site: 'S',
      vodId: '42',
      items: [{ ep: '第1集', name: '片名', url: 'http://cdn/1.m3u8' }],
    })
    expect(calls[0].url).toBe('/api/cache/batch')
    expect(calls[0].method).toBe('POST')
    // 每集只带 ep/name/url：site/vodId 是批次级的，逐集重复会被后端忽略，
    // 但多带一份就等于两个真源（以后端为准时容易改一处漏一处）
    expect(calls[0].body).toEqual({
      site: 'S',
      vodId: '42',
      items: [{ ep: '第1集', name: '片名', url: 'http://cdn/1.m3u8' }],
    })
  })

  it('批次进度用 query 传 batch', async () => {
    const { fetchBatchStatus } = await import('../src/api/library')
    await fetchBatchStatus('b1x')
    expect(calls[0].url).toBe('/api/cache/status?batch=b1x')
  })

  it('不带 batch 时拿批次概览', async () => {
    const { fetchBatchList } = await import('../src/api/library')
    await fetchBatchList()
    expect(calls[0].url).toBe('/api/cache/status')
  })

  it('未完成任务走 /api/cache/tasks', async () => {
    const { fetchCacheTasks } = await import('../src/api/library')
    await fetchCacheTasks()
    expect(calls[0].url).toBe('/api/cache/tasks')
  })

  it('续传发 ids 数组（后端同时接受 id 与 ids）', async () => {
    const { resumeCacheTasks } = await import('../src/api/library')
    await resumeCacheTasks(['a', 'b'])
    expect(calls[0].url).toBe('/api/cache/resume')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({ ids: ['a', 'b'] })
  })
})
