import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * iOS 侧载 IPA 的更新检查（altstore-source.json）。
 *
 * 三条锁：
 *   1. 读真实商店源结构（apps[].versions[]），按 bundle id 命中、取最高版本；
 *   2. 只提示不下载 —— 返回的是 AppUpdate 描述，不带任何原生安装动作；
 *   3. 两条链接齐全（版本化 IPA 直链 + 固定名直链 + 侧载源地址），供弹框复制。
 */
const SOURCE = {
  version: 2,
  apps: [
    {
      bundleIdentifier: 'com.other.app',
      versions: [{ version: '9.9.9', downloadURL: 'https://x/other.ipa' }],
    },
    {
      bundleIdentifier: 'com.meow.player.ios',
      versions: [
        {
          version: '1.2.24',
          date: '2026-11-26',
          localizedDescription: '1. 修复 A\n2. 修复 B',
          downloadURL:
            'https://github.com/upchr/meow/releases/download/release-v1.2.24/Meow-unsigned-1.2.24.ipa',
          size: 88826414,
          sha256: 'ABC123',
          minOSVersion: '15.0',
        },
        {
          version: '1.2.23',
          date: '2026-11-24',
          downloadURL:
            'https://github.com/upchr/meow/releases/download/release-v1.2.23/Meow-unsigned-1.2.23.ipa',
        },
      ],
    },
  ],
}

describe('iOS 侧载更新检查', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    try {
      localStorage.clear()
    } catch {
      /* 忽略 */
    }
    // 默认注入 iOS 壳：meowIos.version = 1.2.22
    Object.defineProperty(window, 'meowIos', {
      configurable: true,
      value: { platform: 'ios', version: '1.2.22' },
    })
  })

  function mockFetch(text: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => text }),
    )
  }

  it('命中本 App 的 bundle id，取最高版本并映射成完整 AppUpdate', async () => {
    mockFetch(JSON.stringify(SOURCE))
    const { checkIosAppUpdate } = await import('../src/api/appUpdate')
    const up = await checkIosAppUpdate()
    expect(up).not.toBeNull()
    expect(up!.kind).toBe('ios')
    expect(up!.version).toBe('1.2.24')
    expect(up!.url).toContain('Meow-unsigned-1.2.24.ipa')
    expect(up!.sha256).toBe('abc123')
    expect(up!.size).toBe(88826414)
    expect(up!.lasttime).toBe('2026-11-26')
    expect(up!.notes).toContain('修复 A')
    expect(up!.fileName).toBe('Meow-unsigned-1.2.24.ipa')
  })

  it('两条链接齐全：版本化 IPA 直链 + 固定名直链 + 侧载源地址', async () => {
    mockFetch(JSON.stringify(SOURCE))
    const { checkIosAppUpdate, IOS_UPDATE_SOURCE } = await import('../src/api/appUpdate')
    const up = await checkIosAppUpdate()
    expect(up!.url).toMatch(/Meow-unsigned-1\.2\.24\.ipa$/)
    expect(up!.fixedUrl).toMatch(/\/releases\/latest\/download\/Meow-unsigned\.ipa$/)
    expect(up!.sourceUrl).toBe(IOS_UPDATE_SOURCE)
  })

  it('本地已是最新版 → 返回 null（不误报）', async () => {
    Object.defineProperty(window, 'meowIos', {
      configurable: true,
      value: { platform: 'ios', version: '1.2.24' },
    })
    mockFetch(JSON.stringify(SOURCE))
    const { checkIosAppUpdate } = await import('../src/api/appUpdate')
    expect(await checkIosAppUpdate()).toBeNull()
  })

  it('本地版本更高 → 返回 null', async () => {
    Object.defineProperty(window, 'meowIos', {
      configurable: true,
      value: { platform: 'ios', version: '1.3.0' },
    })
    mockFetch(JSON.stringify(SOURCE))
    const { checkIosAppUpdate } = await import('../src/api/appUpdate')
    expect(await checkIosAppUpdate()).toBeNull()
  })

  it('源里没有本 App → 返回 null（绝不拿别的 App 版本误报）', async () => {
    mockFetch(JSON.stringify({ version: 2, apps: [SOURCE.apps[0]] }))
    const { checkIosAppUpdate } = await import('../src/api/appUpdate')
    expect(await checkIosAppUpdate()).toBeNull()
  })

  it('currentVersion 在 iOS 读 meowIos.version，不读 Vite 注入的 web 版本', async () => {
    const { currentVersion, isIosUpdateShell } = await import('../src/api/appUpdate')
    expect(isIosUpdateShell()).toBe(true)
    expect(currentVersion()).toBe('1.2.22')
  })

  it('非 iOS 壳 → isIosUpdateShell 为 false', async () => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (window as unknown as Record<string, unknown>).meowIos
    const { isIosUpdateShell } = await import('../src/api/appUpdate')
    expect(isIosUpdateShell()).toBe(false)
  })
})
