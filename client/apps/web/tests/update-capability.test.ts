import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 更新能力探测（2026-11-16 用户点单 1~3 的 #2 逻辑部分）。
 *
 * 为什么用单测而不是真机：PC 壳是 single-instance 的，本机已有用户实例在跑，
 * 再启动会把它唤到前台（2026-11-16 实测，打扰用户）。这里把「平台探测」
 * 三条分支锁住；UI 行本身与 TV 共用同一组件（TV 已真机验过）。
 */
const platform = { value: 'web' }
const detect = vi.fn()
const checkFpk = vi.fn()

vi.mock('../src/api/appUpdate', async (orig) => {
  const real = await orig<typeof import('../src/api/appUpdate')>()
  return { ...real, currentPlatform: () => platform.value }
})

vi.mock('../src/api/fpkUpgrade', async (orig) => {
  const real = await orig<typeof import('../src/api/fpkUpgrade')>()
  return {
    ...real,
    detectFpkShell: (...a: unknown[]) => detect(...a),
    checkFpkUpdate: (...a: unknown[]) => checkFpk(...a),
  }
})

async function freshStore() {
  vi.resetModules()
  return import('../src/stores/appUpdate')
}

describe('更新能力探测：PC/TV vs fnOS vs 直连', () => {
  beforeEach(() => {
    detect.mockReset()
    checkFpk.mockReset()
    platform.value = 'web'
    try {
      localStorage.clear()
    } catch {
      /* 忽略 */
    }
  })

  it('PC / TV 壳 → shell（同步可判，不去探 fpk）', async () => {
    platform.value = 'windows-x64'
    const s = await freshStore()
    expect(await s.probeCapability()).toBe('shell')
    expect(s.canUpdate.value).toBe(true)
    expect(s.kind.value).toBe('shell')
    expect(detect).not.toHaveBeenCalled()
  })

  it('浏览器 + fnOS 应用中心可达 → fpk，可弹框/可安装', async () => {
    platform.value = 'web'
    detect.mockResolvedValue({
      info: { app: 'meow', role: 'shell', version: '1.2.11', arch: 'x86_64' },
      installed: { name: 'meow', version: '1.2.11', volumeID: 1, installType: 'volume' },
    })
    const s = await freshStore()
    expect(await s.probeCapability()).toBe('fpk')
    expect(s.kind.value).toBe('fpk')
    expect(s.canUpdate.value).toBe(true)
  })

  it('浏览器直连 :30010（/app-center 不可用）→ none，不弹不显示', async () => {
    platform.value = 'web'
    detect.mockResolvedValue(null)
    const s = await freshStore()
    expect(await s.probeCapability()).toBe('none')
    expect(s.canUpdate.value).toBe(false)
  })

  it('探测结果会话内缓存：重复调用只探一次', async () => {
    platform.value = 'web'
    detect.mockResolvedValue(null)
    const s = await freshStore()
    await s.probeCapability()
    await s.probeCapability()
    expect(detect).toHaveBeenCalledTimes(1)
  })

  it('手动检查会重探一次（启动瞬间应用中心未就绪不永久关掉入口）', async () => {
    platform.value = 'web'
    detect.mockResolvedValueOnce(null)
    const s = await freshStore()
    await s.probeCapability()
    expect(s.canUpdate.value).toBe(false)
    // 之后每次探测都成功（runCheck 内部还会再探一次）
    detect.mockResolvedValue({
      info: { app: 'meow', role: 'shell', version: '1.2.11', arch: 'x86_64' },
      installed: { name: 'meow', version: '1.2.11', volumeID: 1, installType: 'volume' },
    })
    checkFpk.mockResolvedValue({
      info: { app: 'meow', role: 'shell', version: '1.2.11', arch: 'x86_64' },
      installed: { name: 'meow', version: '1.2.11', volumeID: 1, installType: 'volume' },
      current: '1.2.11',
      latest: null,
    })
    const up = await s.runCheck()
    expect(up).toBeNull()
    expect(detect).toHaveBeenCalledTimes(2)
    expect(s.capability.value).toBe('fpk')
  })
})
