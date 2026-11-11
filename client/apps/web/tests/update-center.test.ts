import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAIN_INDEX_URL,
  fpkIndexUrls,
  fetchIndexes,
  pickLatestFromIndexes,
  type FpkIndex,
} from '../src/api/fpkUpgrade'
import {
  DEFAULTS,
  getPrefs,
  savePrefs,
} from '../src/stores/prefs'
import { getBackupUpdateSource, isShellReleaseTag, setBackupUpdateSource } from '../src/api/appUpdate'

function index(version: string, arch: 'x86' | 'arm' = 'x86'): FpkIndex {
  return {
    url: 'https://example.test/fnpack.json',
    apps: {
      meow: {
        releases: {
          [version]: {
            changelog: `${version} notes`,
            packages: {
              [arch]: {
                download_url: `./meow_${version}_${arch}.fpk`,
                sha256: 'a'.repeat(64),
                size: 123,
              },
            },
          },
        },
      },
    },
  }
}

const info = { app: 'meow', role: 'shell', version: '1.1.5', arch: 'x86_64' }

describe('fpk 双索引', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认同时包含 FnDepot 与主仓镜像', () => {
    const urls = fpkIndexUrls()
    expect(urls.length).toBe(2)
    expect(urls[0]).toContain('FnDepot')
    expect(urls[1]).toBe(MAIN_INDEX_URL)
  })

  it('用户手填索引时只用自己的源，不偷偷加主仓', () => {
    localStorage.setItem('meow.fpkIndex', 'https://internal.test/fpk.json')
    expect(fpkIndexUrls()).toEqual(['https://internal.test/fpk.json'])
  })

  it('跨索引挑最高版本，而不是第一个成功的', () => {
    const picked = pickLatestFromIndexes(
      [index('1.1.6'), index('1.1.7')],
      info,
      '1.1.5',
    )
    expect(picked && 'latest' in picked ? picked.latest.version : '').toBe('1.1.7')
  })

  it('一个索引源失败不阻塞另一个', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      if (u.includes('bad')) throw new Error('dead')
      return new Response(JSON.stringify({ apps: index('1.1.6').apps }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const list = await fetchIndexes(['https://bad.test/fnpack.json', 'https://good.test/fnpack.json'])
      expect(list.length).toBe(1)
      expect(list[0].apps.meow).toBeTruthy()
    } finally {
      globalThis.fetch = orig
    }
  })

  it('最高版本没有本架构包时，回退到较低但有包的版本', () => {
    const armOnly = index('1.1.7', 'arm')
    const x86 = index('1.1.6', 'x86')
    const picked = pickLatestFromIndexes([armOnly, x86], info, '1.1.5')
    expect(picked && 'latest' in picked ? picked.latest.version : '').toBe('1.1.6')
  })
})

describe('壳更新 tag 过滤', () => {
  it('模块/插件/镜像 Release 不参与壳更新', () => {
    expect(isShellReleaseTag('release-v1.1.6')).toBe(true)
    expect(isShellReleaseTag('tv-v1.1.6')).toBe(true)
    expect(isShellReleaseTag('pc-v1.1.6')).toBe(true)
    expect(isShellReleaseTag('v1.1.6')).toBe(true)
    expect(isShellReleaseTag('tv-plugins-v18.20.4.1')).toBe(false)
    expect(isShellReleaseTag('plugins-v1.1.6.1')).toBe(false)
    expect(isShellReleaseTag('docker-v1.1.6')).toBe(false)
    expect(isShellReleaseTag('fpk-v1.1.6')).toBe(false)
  })
})

describe('更新偏好', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('自动检查默认开启，可逐项关闭', () => {
    expect(DEFAULTS.autoCheckApp).toBe(true)
    expect(DEFAULTS.autoCheckModule).toBe(true)
    expect(DEFAULTS.autoCheckPlugins).toBe(true)
    expect(DEFAULTS.autoCheckFpk).toBe(true)
    savePrefs({ autoCheckPlugins: false })
    expect(getPrefs().autoCheckPlugins).toBe(false)
    expect(getPrefs().autoCheckApp).toBe(true)
  })

  it('显式备用源可持久化；空值表示不启用', () => {
    expect(getBackupUpdateSource()).toBe('')
    setBackupUpdateSource('https://backup.test/packages.json')
    expect(getBackupUpdateSource()).toBe('https://backup.test/packages.json')
    setBackupUpdateSource('')
    expect(getBackupUpdateSource()).toBe('')
  })
})
