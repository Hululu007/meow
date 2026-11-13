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

  it('默认顺序：主仓镜像优先、FnDepot 兜底', () => {
    const urls = fpkIndexUrls()
    expect(urls.length).toBe(2)
    expect(urls[0]).toBe(MAIN_INDEX_URL)
    expect(urls[1]).toContain('FnDepot')
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

  it('第一份索引已有更高版本就不再拉第二份（主仓优先）', async () => {
    const calls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      calls.push(u)
      return new Response(JSON.stringify({ apps: index('1.1.8').apps }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const list = await fetchIndexes(['https://main.test/fpk.json', 'https://depot.test/fnpack.json'], '1.1.5')
      expect(list.length).toBe(1)
      expect(calls.length).toBe(1)
      expect(calls[0]).toContain('main.test')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('主仓没有更高版本时继续查 FnDepot 兜底', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      const ver = u.includes('main') ? '1.1.6' : '1.1.7'
      return new Response(JSON.stringify({ apps: index(ver).apps }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const list = await fetchIndexes(['https://main.test/fpk.json', 'https://depot.test/fnpack.json'], '1.1.6')
      expect(list.length).toBe(2)
    } finally {
      globalThis.fetch = orig
    }
  })

  it('同版本时按包地址权威性选：Release 资产 > raw > jsDelivr', () => {
    const rel = 'https://github.com/upchr/meow/releases/download/fpk-v1.1.7/meow_1.1.7_x86.fpk'
    const mk = (indexUrl: string, pkgUrl: string): FpkIndex => ({
      url: indexUrl,
      apps: {
        meow: {
          releases: {
            '1.1.7': {
              changelog: 'x',
              packages: { x86: { download_url: pkgUrl, sha256: 'b'.repeat(64), size: 1 } },
            },
          },
        },
      },
    })
    const jsd = mk('https://cdn.jsdelivr.net/gh/o/r@main/fnpack.json', './meow_1.1.7_x86.fpk')
    const raw = mk('https://raw.githubusercontent.com/o/r/main/fnpack.json', './meow_1.1.7_x86.fpk')
    const release = mk('https://raw.githubusercontent.com/o/r/main/fnpack.json', rel)

    const a = pickLatestFromIndexes([jsd, raw], info, '1.1.5')
    expect(a && 'latest' in a ? a.latest.url : '').toContain('raw.githubusercontent.com')

    const b = pickLatestFromIndexes([raw, release], info, '1.1.5')
    expect(b && 'latest' in b ? b.latest.url : '').toBe(rel)
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
