/**
 * WebDAV 失败语义门禁。
 *
 * 背景（2026-11-12 MuMu 实测）：把地址填成关闭的端口时，
 * 「测试连接」显示**连接成功（HTTP 0）**——后端代理连不上时返回
 * `{ok:false,status:0,msg:"ConnectException…"}`，前端只判 `status<300`，
 * 0 就通过了。用户会以为地址没问题，直到上传才失败。
 *
 * 这里锁住三件事：
 * 1. status=0 必须判失败，并带出后端给的原因；
 * 2. 创建目录失败要有原因（不能再是裸的 HTTP 0）；
 * 3. 成功文案用 webdavPing 算好的文件数，不是裸 HTTP 码。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webdavPing } from '../src/stores/prefs'
import { pushHistory } from '../src/stores/sync'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  // 直接改 globalThis：这版 vitest 下 vi.stubGlobal 没拦住模块里的裸 fetch
  // （实测请求打到了真实后端），所以用赋值 + afterEach 还原。
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
  ;(globalThis as { fetch: unknown }).fetch = fn
  return fn
}

describe('webdavPing（连接测试）', () => {
  beforeEach(() => {
    localStorage.setItem('meow.webdav', JSON.stringify(CFG))
  })
  afterEach(() => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  })

  it('代理连不上（status=0）必须判失败，并带出原因', async () => {
    mockProxy({
      ok: false,
      status: 0,
      body: '',
      msg: 'ConnectException: Failed to connect to /192.168.1.34:5006',
    })
    const r = await webdavPing('http://192.168.1.20:30010', CFG)
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
    expect(r.msg).toContain('连不上 WebDAV 服务器')
    expect(r.msg).toContain('ConnectException')
  })

  it('成功时给出目录里已有几个文件（而不是裸 HTTP 码）', async () => {
    mockProxy({
      ok: true,
      status: 207,
      body:
        '<D:multistatus><D:href>/meow/</D:href>' +
        '<D:href>/meow/history.json</D:href>' +
        '<D:href>/meow/search-history.json</D:href>' +
        '<D:href>/meow/backups/</D:href></D:multistatus>',
    })
    const r = await webdavPing('http://192.168.1.20:30010', CFG)
    expect(r.ok).toBe(true)
    expect(r.msg).toBe('连接成功（3 个文件）')
  })

  it('认证/目录不存在仍按原语义提示', async () => {
    mockProxy({ ok: false, status: 401, body: '' })
    expect((await webdavPing('b', CFG)).msg).toContain('认证失败')

    mockProxy({ ok: false, status: 404, body: '' })
    expect((await webdavPing('b', CFG)).msg).toContain('目录不存在')
  })
})

describe('pushHistory（上传）失败原因', () => {
  beforeEach(() => {
    localStorage.setItem('meow.webdav', JSON.stringify(CFG))
    localStorage.setItem('meow.history.list', JSON.stringify([]))
  })
  afterEach(() => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  })

  it('创建目录连不上时报原因，不再只写 HTTP 0', async () => {
    mockProxy({
      ok: false,
      status: 0,
      body: '',
      msg: 'ConnectException: Failed to connect to /192.168.1.34:5006',
    })
    await expect(pushHistory('http://192.168.1.20:30010')).rejects.toThrow(
      /创建目录失败：连不上 WebDAV 服务器/,
    )
  })
})

describe('设置页文案（源级门禁）', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..')
  const view = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'), 'utf8')

  it('测试连接直接展示 webdavPing 的文案（含文件数）', () => {
    expect(view).toContain('davMsg.value = { ok: r.ok, text: r.msg }')
    // 回退标志：曾经的裸 HTTP 码文案
    expect(view).not.toContain('连接成功（HTTP ')
  })
})
