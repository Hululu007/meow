import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLoopbackUrl } from '../src/utils/loopback'

/**
 * 桌面端启动竞态（2026-11-09 用户报「开应用要点两次重试才进首页」）。
 *
 * ## 真因
 *
 * 用户在设置页存了 `http://127.0.0.1:9979`（scope=desktop）。`initBackend()`
 * 把任何手填地址都当"远端"立即返回，页面在插件 autostart 还没 bind 端口时
 * 就 ping 了一次 → `Failed to fetch` → 首页闪「后端未连接」。
 * 实测 apiserver 冷启动只要 ~0.7 秒，不是启动慢。
 *
 * ## 锁住四件事
 *
 * 1. 回环地址识别（`127.0.0.1` / `localhost` / `[::1]`，含无协议写法）；
 * 2. `initBackend` 只对**非回环**手填地址提前返回；
 * 3. `resolveBase` 在回环手填地址与插件协商地址不一致时用后者（端口顺延）；
 * 4. `store.boot` 桌面端先重试再报错，UI 宽限期内只显示「正在启动后端…」。
 */
const ROOT = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('isLoopbackUrl', () => {
  it('识别常见本机写法', () => {
    expect(isLoopbackUrl('http://127.0.0.1:9979')).toBe(true)
    expect(isLoopbackUrl('http://localhost:30011')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:9979')).toBe(true)
    expect(isLoopbackUrl('127.0.0.1:9979')).toBe(true)
    expect(isLoopbackUrl('localhost:9979/api')).toBe(true)
  })

  it('远端地址与相似域名不能误判', () => {
    expect(isLoopbackUrl('http://192.168.1.5:9979')).toBe(false)
    expect(isLoopbackUrl('https://oect.example.com')).toBe(false)
    expect(isLoopbackUrl('http://127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackUrl('')).toBe(false)
  })
})

describe('桌面端启动竞态的门禁', () => {
  const api = read('src/api/index.ts')
  const store = read('src/stores/app.ts')
  const app = read('src/App.vue')

  it('initBackend 只对非回环手填地址提前返回', () => {
    expect(api).toContain('if (manual && !isLoopbackUrl(manual)) return info')
    expect(api).toContain('if (nowManual && !isLoopbackUrl(nowManual)) return info')
    // 旧写法：任何手填地址都立刻返回 —— 回退就会再次出现「两次重试」
    expect(api).not.toContain('if (manual) return info')
  })

  it('resolveBase 对回环手填地址优先用插件协商结果（端口顺延）', () => {
    expect(api).toContain('isLoopbackUrl(manual) && desktopBase && manual !== desktopBase')
  })

  it('store.boot 桌面端先重试，且回环地址给友好错误', () => {
    expect(store).toContain('pingWithStartupRetry')
    expect(store).toContain('isDesktop() ? 4 : 1')
    expect(store).toContain('暂时没有响应')
    // 不能再把裸 Failed to fetch 当用户文案
    expect(store).not.toContain("this.error = isDesktop()\n            ? where")
  })

  it('App.vue 有启动宽限期与轻提示', () => {
    expect(app).toContain('bootGraceOver')
    expect(app).toContain('showStartupTip')
    expect(app).toContain('正在启动后端…')
    expect(app).toContain('bootGraceTimer')
  })
})

/**
 * 行为级验证：用假的 Tauri invoke 模拟插件从 starting → ready，
 * 断言回环手填地址会继续轮询、远端地址才立即返回。
 */
describe('initBackend 启动等待', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.api', 'http://127.0.0.1:9979')
    localStorage.setItem('meow.api.scope', 'desktop')
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    vi.resetModules()
  })

  function mockInvoke(states: unknown[]): ReturnType<typeof vi.fn> {
    let i = 0
    const fn = vi.fn(async () => states[Math.min(i++, states.length - 1)])
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: fn }
    return fn
  }

  const starting = {
    backend_base: null,
    ok: false,
    fatal_reason: null,
    app_version: 'test',
    plugins: [
      {
        id: 'apiserver',
        name: '影视后端',
        required: true,
        enabled: true,
        installed: true,
        phase: 'starting',
        port: 9979,
        base: 'http://127.0.0.1:9979',
        version: '1.0.7',
      },
    ],
  }
  const ready = {
    ...starting,
    backend_base: 'http://127.0.0.1:9979',
    ok: true,
    plugins: [{ ...starting.plugins[0], phase: 'ready' }],
  }

  it('手填回环地址：继续轮询直到 backend_base 出现', async () => {
    const fn = mockInvoke([starting, starting, ready])
    vi.resetModules()
    const { initBackend } = await import('../src/api/index')
    const info = await initBackend()
    expect(info?.backend_base).toBe('http://127.0.0.1:9979')
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(3)
  }, 10_000)

  it('手填远端地址：立即返回，不等本地插件', async () => {
    localStorage.setItem('meow.api', 'http://oect.example.com:30011')
    const fn = mockInvoke([starting])
    vi.resetModules()
    const { initBackend } = await import('../src/api/index')
    const t0 = Date.now()
    const info = await initBackend()
    expect(info?.backend_base).toBeNull()
    expect(fn.mock.calls.length).toBe(1)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
