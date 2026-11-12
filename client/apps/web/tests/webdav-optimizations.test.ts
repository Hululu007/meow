/**
 * WebDAV 优化项门禁（2026-11-12 第二轮）。
 *
 * 覆盖：读-改-写上传、失败退避重试、手动操作状态、启动拉取失败可见、
 * 片头标记事件、快照 dedupe 纳入 skipMarks、手动清理旧快照、探测容错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setRetryDelaysForTest,
  autoPullOnStart,
  autoSyncNow,
  getLastPullError,
  getSyncStatus,
  listSnapshots,
  onSyncStatus,
  pruneSnapshotsTo,
  pushHistory,
  snapshotEquivalent,
  withSyncStatus,
} from '../src/stores/sync'
import { friendlyDavError, webdavPing, type WebdavConfig } from '../src/stores/prefs'
import { setSkipMark } from '../src/stores/skipMarks'
import { listHistory } from '../src/stores/history'

const CFG: WebdavConfig = {
  enabled: true,
  url: 'http://nas:5005/ceshi',
  user: 'admin',
  pass: 'pw',
  dir: 'meow',
  syncHistory: true,
  syncPrefs: true,
  syncSearchHistory: true,
  syncLibrary: false,
}

const realFetch = globalThis.fetch

type Reply = { ok?: boolean; status?: number; body?: string; msg?: string }

/** 按请求里的 method 分支造假后端；PUT 的 body 会被记录 */
function mockDav(routes: Record<string, Reply | ((body: string) => Reply)>) {
  const puts: string[] = []
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body || '{}')) as {
      method?: string
      body?: string
    }
    const m = (req.method || 'GET').toUpperCase()
    let r: Reply = routes[m] ?? { ok: true, status: 201 }
    if (typeof r === 'function') r = r(String(req.body || ''))
    if (m === 'PUT') puts.push(String(req.body || ''))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: r.ok ?? true,
        status: r.status ?? 200,
        body: r.body ?? '',
        ...(r.msg ? { msg: r.msg } : {}),
      }),
    }
  })
  ;(globalThis as { fetch: unknown }).fetch = fn
  return { fn, puts }
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('meow.webdav', JSON.stringify(CFG))
  __setRetryDelaysForTest([0, 1, 1])
})

afterEach(() => {
  ;(globalThis as { fetch: unknown }).fetch = realFetch
  __setRetryDelaysForTest([0, 3000, 10000])
})

// ---------------------------------------------------------------- 读-改-写

describe('pushHistory：先合并远端再上传', () => {
  it('PUT 的是并集，且远端独有条目被写回本地', async () => {
    localStorage.setItem(
      'meow.history.list',
      JSON.stringify([
        { site: 'A', siteName: 'A', vod_id: 'local', vod_name: '本机', vod_pic: '', at: 2000 },
      ]),
    )
    const remote = {
      version: 2,
      items: [
        { site: 'A', siteName: 'A', vod_id: 'remote', vod_name: '远端', vod_pic: '', at: 3000 },
      ],
    }
    const { puts } = mockDav({
      MKCOL: { status: 201 },
      GET: { body: JSON.stringify(remote) },
      PUT: { status: 201 },
    })

    await pushHistory('http://backend')

    expect(puts).toHaveLength(1)
    const sent = JSON.parse(puts[0])
    expect(sent.items.map((x: { vod_id: string }) => x.vod_id).sort()).toEqual([
      'local',
      'remote',
    ])
    expect(listHistory().map((x) => x.vod_id).sort()).toEqual(['local', 'remote'])
  })

  it('远端 404（首次上传）不阻断，按本地内容 PUT', async () => {
    localStorage.setItem(
      'meow.history.list',
      JSON.stringify([{ site: 'A', siteName: 'A', vod_id: 'x', vod_name: '', vod_pic: '', at: 1 }]),
    )
    const { puts } = mockDav({
      MKCOL: { status: 201 },
      GET: { ok: false, status: 404 },
      PUT: { status: 201 },
    })
    await pushHistory('http://backend')
    expect(JSON.parse(puts[0]).items).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- 重试

describe('autoSyncNow：失败退避重试', () => {
  it('连续失败 3 次后报错，消息标注已重试 2 次', async () => {
    const { fn } = mockDav({
      MKCOL: { ok: false, status: 0, msg: 'ConnectException: refused' },
    })
    let err = ''
    try {
      await autoSyncNow('http://backend')
    } catch (e: any) {
      err = e?.message || String(e)
    }
    expect(err).toContain('连不上 WebDAV 服务器')
    expect(getSyncStatus().state).toBe('error')
    expect(getSyncStatus().message).toContain('已重试 2 次')
    // 每轮至少一次 MKCOL：共 3 轮
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('第二轮成功就转 ok，不再重试', async () => {
    let n = 0
    const { fn } = mockDav({
      MKCOL: () => (++n === 1 ? { ok: false, status: 0, msg: 'timeout' } : { status: 201 }),
      GET: { ok: false, status: 404 },
      PUT: { status: 201 },
      PROPFIND: { ok: false, status: 404 },
    })
    await autoSyncNow('http://backend')
    expect(getSyncStatus().state).toBe('ok')
    expect(getSyncStatus().message).toContain('重试 1 次后成功')
  })
})

// ---------------------------------------------------------------- 手动操作状态

describe('withSyncStatus', () => {
  it('成功 emit ok，失败 emit error 并抛出', async () => {
    const seen: string[] = []
    const off = onSyncStatus((s) => seen.push(s.state))
    seen.length = 0 // onSyncStatus 订阅时会立刻回放当前状态
    await withSyncStatus(async () => 1, () => '已上传 1 条')
    expect(seen).toEqual(['syncing', 'ok'])
    await expect(
      withSyncStatus(async () => {
        throw new Error('boom')
      }, () => 'x'),
    ).rejects.toThrow('boom')
    expect(getSyncStatus().state).toBe('error')
    expect(getSyncStatus().message).toBe('boom')
    off()
  })
})

// ---------------------------------------------------------------- 启动拉取失败

describe('autoPullOnStart：失败可见，成功清空', () => {
  it('连不上时记录 lastPullError，下一次成功拉取后清空', async () => {
    mockDav({ GET: { ok: false, status: 0, msg: 'ConnectException: refused' } })
    await autoPullOnStart('http://backend')
    expect(getLastPullError()?.message).toContain('连不上 WebDAV 服务器')

    // 成功（404 = 远端还没有文件）应清空
    mockDav({ GET: { ok: false, status: 404 } })
    await autoPullOnStart('http://backend')
    expect(getLastPullError()).toBeNull()
  })
})

// ---------------------------------------------------------------- skipMarks

describe('片头标记', () => {
  it('setSkipMark 广播变更事件（用于触发上传）', () => {
    let hit = 0
    const fn = () => hit++
    window.addEventListener('meow:skipmarks-changed', fn)
    setSkipMark('A', '1', { intro: 42 })
    window.removeEventListener('meow:skipmarks-changed', fn)
    expect(hit).toBe(1)
  })

  it('快照 dedupe 把 skipMarks 纳入比较', () => {
    const base = {
      version: 1 as const,
      exportedAt: 1,
      prefs: {} as never,
      history: [],
      searchHistory: [],
      aux: { skipMarks: [{ key: 'A|1', marks: { intro: 10, outro: 20, at: 1 } }] },
    }
    expect(snapshotEquivalent(base, { ...base })).toBe(true)
    expect(
      snapshotEquivalent(base, {
        ...base,
        aux: { skipMarks: [{ key: 'A|1', marks: { intro: 11, outro: 20, at: 2 } }] },
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------- 清理快照

describe('pruneSnapshotsTo', () => {
  it('保留最近 3 份，其余删除', async () => {
    const body =
      '<D:multistatus>' +
      ['20261112-010000', '20261112-020000', '20261112-030000', '20261112-040000', '20261112-050000']
        .map(
          (t, i) =>
            `<D:response><D:href>/m/backups/prefs-${t}.json</D:href><D:propstat><D:prop>` +
            `<D:getlastmodified>Thu, 12 Nov 2026 0${i + 1}:00:00 GMT</D:getlastmodified>` +
            `</D:prop></D:propstat></D:response>`,
        )
        .join('') +
      '</D:multistatus>'
    const deletes: string[] = []
    const fn = vi.fn(async (_u: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body || '{}'))
      if (req.method === 'PROPFIND') {
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 207, body }) }
      }
      if (req.method === 'DELETE') {
        deletes.push(req.url)
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 204, body: '' }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, status: 201, body: '' }) }
    })
    ;(globalThis as { fetch: unknown }).fetch = fn

    const r = await pruneSnapshotsTo('http://backend', 3)
    expect(r).toEqual({ deleted: 2, kept: 3 })
    // 删除的是最旧的两份
    expect(deletes.join(' ')).toContain('20261112-010000')
    expect(deletes.join(' ')).toContain('20261112-020000')
  })
})

// ---------------------------------------------------------------- 探测容错

describe('webdavPing 文件计数', () => {
  it('小写 d:href 也能数出来（SabreDAV/Nextcloud 风格）', async () => {
    const body =
      '<d:multistatus><d:href>/m/meow/</d:href>' +
      '<d:href>/m/meow/history.json</d:href>' +
      '<d:href>/m/meow/backups/</d:href></d:multistatus>'
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 207, body }),
    }))
    const r = await webdavPing('http://backend', CFG)
    expect(r.ok).toBe(true)
    expect(r.msg).toBe('连接成功（2 个文件）')
  })

  it('网络异常翻译成人话，原始信息保留', () => {
    expect(friendlyDavError('UnknownHostException: nas')).toContain('连不上 WebDAV 服务器')
    expect(friendlyDavError('UnknownHostException: nas')).toContain('UnknownHostException')
    expect(friendlyDavError('')).toBe('连接失败')
  })
})
