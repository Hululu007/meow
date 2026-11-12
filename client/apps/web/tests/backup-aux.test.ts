/**
 * WebDAV 快照覆盖 + 脱敏门禁。
 *
 * 2026-11-12 审计发现两类缺口：
 * 1. `updateToken`（私有仓 PAT）没脱敏，明文进 NAS 上的快照；
 * 2. 手工片头标记 / 线路偏好 / 追剧基准 / 观看统计只存本机，换机全丢。
 *
 * 还原语义一律「只合并不删除」：拿旧快照还原，不能抹掉本机后来产生的数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyBackup, makeBackup, __resetPrefsCache } from '../src/stores/prefs'
import { listSnapshots } from '../src/stores/sync'

const CFG = {
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
function mockProxy(payload: unknown) {
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
  ;(globalThis as { fetch: unknown }).fetch = fn
  return fn
}

beforeEach(() => {
  localStorage.clear()
  __resetPrefsCache()
  localStorage.setItem('meow.webdav', JSON.stringify(CFG))
})

afterEach(() => {
  ;(globalThis as { fetch: unknown }).fetch = realFetch
})

describe('快照脱敏', () => {
  it('llmApiKey 与 updateToken 都不进快照，其余字段保留', () => {
    localStorage.setItem(
      'meow.prefs',
      JSON.stringify({ llmApiKey: 'sk-secret', updateToken: 'ghp_pat', updateSource: 'https://x' }),
    )
    __resetPrefsCache()
    const b = makeBackup([], [], [])
    expect('llmApiKey' in b.prefs).toBe(false)
    expect('updateToken' in b.prefs).toBe(false)
    expect(b.prefs.updateSource).toBe('https://x')
  })

  it('还原时也不采纳旧备份里的密钥（含老版本导出的）', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ themeMode: 'dark', updateToken: 'local-pat' }))
    __resetPrefsCache()
    applyBackup({
      prefs: { themeMode: 'light', updateToken: 'leaked-pat', llmApiKey: 'leaked-key' } as never,
    })
    __resetPrefsCache()
    const p = JSON.parse(localStorage.getItem('meow.prefs') || '{}')
    expect(p.themeMode).toBe('light')
    expect(p.updateToken).toBe('local-pat')
  })
})

describe('辅助数据进快照', () => {
  it('四类数据都能导出', () => {
    localStorage.setItem('meow.skipmarks', JSON.stringify({ 'A|1': { intro: 60, outro: 90, at: 5 } }))
    localStorage.setItem('meow.linepref', JSON.stringify({ 'A|1': { name: '线路二', at: 7 } }))
    localStorage.setItem(
      'meow.fav.remarks',
      JSON.stringify({ seen: { 'A|1': '更新至5集' }, at: 0, hits: {} }),
    )
    localStorage.setItem('meow.watch.stats', JSON.stringify({ days: { '2026-11-01': 300 }, total: 300, at: 0 }))
    const aux = makeBackup([], [], []).aux
    expect(aux?.skipMarks).toEqual([{ key: 'A|1', marks: { intro: 60, outro: 90, at: 5 } }])
    expect(aux?.linePrefs).toEqual({ 'A|1': { name: '线路二', at: 7 } })
    expect(aux?.favRemarks).toEqual({ 'A|1': '更新至5集' })
    expect(aux?.watchDays).toEqual({ '2026-11-01': 300 })
  })

  it('还原只合并不删除：本机更新/更全的数据不被旧快照覆盖', () => {
    localStorage.setItem(
      'meow.skipmarks',
      JSON.stringify({ 'A|1': { intro: 100, outro: 200, at: 2000 } }),
    )
    localStorage.setItem('meow.linepref', JSON.stringify({ 'A|1': { name: '线路三', at: 2000 } }))
    localStorage.setItem(
      'meow.fav.remarks',
      JSON.stringify({ seen: { 'A|1': '更新至9集' }, at: 0, hits: {} }),
    )
    localStorage.setItem(
      'meow.watch.stats',
      JSON.stringify({ days: { '2026-11-01': 100, '2026-11-02': 50 }, total: 150, at: 0 }),
    )

    applyBackup(
      {
        prefs: {} as never,
        aux: {
          skipMarks: [
            { key: 'A|1', marks: { intro: 10, outro: 20, at: 1000 } },
            { key: 'B|1', marks: { intro: 30, outro: 40, at: 1000 } },
          ],
          linePrefs: { 'A|1': { name: '线路一', at: 1000 }, 'B|1': { name: '线路二', at: 1000 } },
          favRemarks: { 'A|1': '更新至1集', 'B|1': '全12集' },
          watchDays: { '2026-11-01': 200, '2026-11-03': 300 },
        },
      },
      { prefsOnly: true },
    )

    const marks = JSON.parse(localStorage.getItem('meow.skipmarks') || '{}')
    expect(marks['A|1']).toEqual({ intro: 100, outro: 200, at: 2000 })
    expect(marks['B|1']).toEqual({ intro: 30, outro: 40, at: 1000 })

    const lines = JSON.parse(localStorage.getItem('meow.linepref') || '{}')
    expect(lines['A|1'].name).toBe('线路三')
    expect(lines['B|1'].name).toBe('线路二')

    const fav = JSON.parse(localStorage.getItem('meow.fav.remarks') || '{}')
    expect(fav.seen['A|1']).toBe('更新至9集')
    expect(fav.seen['B|1']).toBe('全12集')

    const stats = JSON.parse(localStorage.getItem('meow.watch.stats') || '{}')
    expect(stats.days).toEqual({ '2026-11-01': 200, '2026-11-02': 50, '2026-11-03': 300 })
    expect(stats.total).toBe(550)
  })

  it('老备份没有 aux 字段也不报错', () => {
    expect(applyBackup({ prefs: {} as never })).toBe(true)
  })
})

describe('快照排序', () => {
  it('优先按服务器 getlastmodified，而不是文件名里的客户端时钟', async () => {
    mockProxy({
      ok: true,
      status: 207,
      body:
        '<D:multistatus>' +
        '<D:response><D:href>/meow/backups/</D:href><D:propstat><D:prop>' +
        '<D:getlastmodified>Thu, 12 Nov 2026 06:10:00 GMT</D:getlastmodified>' +
        '</D:prop></D:propstat></D:response>' +
        // 文件名更"新"（13:51），但服务器时间是 05:51
        '<D:response><D:href>/meow/backups/prefs-20261112-135134.json</D:href><D:propstat><D:prop>' +
        '<D:getlastmodified>Thu, 12 Nov 2026 05:51:34 GMT</D:getlastmodified>' +
        '</D:prop></D:propstat></D:response>' +
        // 文件名更"旧"（04:45），但服务器时间更新
        '<D:response><D:href>/meow/backups/prefs-20261112-044540.json</D:href><D:propstat><D:prop>' +
        '<D:getlastmodified>Thu, 12 Nov 2026 06:00:00 GMT</D:getlastmodified>' +
        '</D:prop></D:propstat></D:response>' +
        '</D:multistatus>',
    })
    const list = await listSnapshots('http://192.168.1.20:30010')
    expect(list.map((s) => s.name)).toEqual([
      'prefs-20261112-044540.json',
      'prefs-20261112-135134.json',
    ])
  })

  it('服务器不给 Last-Modified 时退回文件名时间', async () => {
    mockProxy({
      ok: true,
      status: 207,
      body:
        '<d:multistatus><d:response><d:href>/m/backups/prefs-20260101-000000.json</d:href></d:response>' +
        '<d:response><d:href>/m/backups/prefs-20260202-000000.json</d:href></d:response></d:multistatus>',
    })
    const list = await listSnapshots('http://192.168.1.20:30010')
    expect(list.map((s) => s.name)[0]).toBe('prefs-20260202-000000.json')
  })
})
