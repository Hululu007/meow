import { describe, it, expect } from 'vitest'
import {
  pickManifestRelease,
  manifestAssetUrlFrom,
  resolveUrl,
  isReleaseEndpoint,
  isTagReleaseEndpoint,
  downloadCandidates,
  isGitHubDownloadUrl,
} from '@/api/appUpdate'

/**
 * 清单定位链路（2026-10-29 加固后）。
 *
 * 这段逻辑决定"客户端去哪个 release 拿清单"，一旦判错就是**整个更新链路瘫痪**
 * （不只是某个包拿不到）。三个必须锁住的行为：
 *   1. 不能信 `/releases/latest` —— 补发旧版 hotfix 会让它退回旧版
 *   2. 没有 packages.json 的 release 要跳过（否则报"该 release 里没有清单"）
 *   3. draft / prerelease 不参与
 */

function rel(tag: string, opts: { draft?: boolean; pre?: boolean; hasManifest?: boolean } = {}) {
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.pre ?? false,
    assets: opts.hasManifest === false ? [{ id: 1, name: 'other.zip' }] : [{ id: 2, name: 'packages.json' }],
  }
}

describe('挑选做更新源的 release', () => {
  it('按版本号取最大，不按列表顺序', () => {
    const list = JSON.stringify([rel('release-v0.9.9'), rel('release-v0.9.10'), rel('release-v0.9.2')])
    expect(pickManifestRelease(list)).toBe('release-v0.9.10')
  })

  it('补发旧版 hotfix（排在列表最前）不会让它成为更新源', () => {
    // GitHub 的 /releases/latest 按发布时间挑 —— 这正是要避开它的原因
    const list = JSON.stringify([
      rel('release-v0.9.20'),
      rel('release-v0.9.35'),
      rel('release-v0.9.34'),
    ])
    expect(pickManifestRelease(list)).toBe('release-v0.9.35')
  })

  it('跳过没有 packages.json 的 release（否则链路会断在"没有清单"）', () => {
    const list = JSON.stringify([
      rel('release-v0.9.40', { hasManifest: false }),
      rel('release-v0.9.39'),
    ])
    expect(pickManifestRelease(list)).toBe('release-v0.9.39')
  })

  it('跳过 draft 与 prerelease', () => {
    const list = JSON.stringify([
      rel('release-v0.9.50', { draft: true }),
      rel('release-v0.9.49', { pre: true }),
      rel('release-v0.9.48'),
    ])
    expect(pickManifestRelease(list)).toBe('release-v0.9.48')
  })

  it('一个都不合格时返回空串（不抛，交给调用方给可读错误）', () => {
    expect(pickManifestRelease(JSON.stringify([rel('release-v0.9.1', { draft: true })]))).toBe('')
    expect(pickManifestRelease('not json')).toBe('')
    expect(pickManifestRelease('{}')).toBe('')
  })
})

describe('从 release JSON 里取清单地址', () => {
  it('优先 API 资产端点（私有仓标准链接带 token 也 404）', () => {
    const relJson = JSON.stringify({
      url: 'https://api.github.com/repos/upchr/meow/releases/123',
      assets: [{ id: 456, name: 'packages.json' }],
    })
    expect(manifestAssetUrlFrom(relJson)).toBe(
      'https://api.github.com/repos/upchr/meow/releases/assets/456',
    )
  })

  it('没有清单资产时返回空串', () => {
    const relJson = JSON.stringify({ url: 'https://api.github.com/repos/o/r/releases/1', assets: [] })
    expect(manifestAssetUrlFrom(relJson)).toBe('')
  })
})

describe('端点识别', () => {
  it('latest 与 tags/<tag> 分开判定（共用一个会让私有仓下载退回 404）', () => {
    const latest = 'https://api.github.com/repos/upchr/meow/releases/latest'
    const tag = 'https://api.github.com/repos/upchr/meow/releases/tags/release-v0.9.38'
    expect(isReleaseEndpoint(latest)).toBe(true)
    expect(isReleaseEndpoint(tag)).toBe(false)
    expect(isTagReleaseEndpoint(tag)).toBe(true)
    expect(isTagReleaseEndpoint(latest)).toBe(false)
    // 结尾斜杠两种都要认
    expect(isReleaseEndpoint(latest + '/')).toBe(true)
  })

  it('自建地址两种都不认（会被当成普通清单文件）', () => {
    expect(isReleaseEndpoint('http://127.0.0.1:8123/packages.json')).toBe(false)
    expect(isTagReleaseEndpoint('http://127.0.0.1:8123/packages.json')).toBe(false)
  })
})

describe('下载地址与代理', () => {
  it('只对 releases/download 加代理（API 端点加代理会丢鉴权）', () => {
    const dl = 'https://github.com/upchr/meow/releases/download/release-v0.9.38/meow-setup.exe'
    expect(isGitHubDownloadUrl(dl)).toBe(true)
    const cands = downloadCandidates(dl)
    expect(cands[0]).toBe(dl) // 先直连
    expect(cands.length).toBeGreaterThan(1)
    expect(cands.slice(1).every((u) => u.endsWith(dl))).toBe(true)

    const api = 'https://api.github.com/repos/upchr/meow/releases/assets/456'
    expect(isGitHubDownloadUrl(api)).toBe(false)
    expect(downloadCandidates(api)).toEqual([api])
  })

  it('自建服务器的地址原样返回（不经代理）', () => {
    const local = 'http://127.0.0.1:8123/meow-tv-0.9.99.apk'
    expect(downloadCandidates(local)).toEqual([local])
  })
})

describe('清单里的相对地址解析', () => {
  it('相对文件名按清单所在目录解析（否则会打到页面 origin，TV 上是 meow.local）', () => {
    expect(resolveUrl('https://x.test/rel/packages.json', 'meow-tv.apk')).toBe(
      'https://x.test/rel/meow-tv.apk',
    )
    expect(resolveUrl('http://127.0.0.1:8123/packages.json', 'a.apk')).toBe(
      'http://127.0.0.1:8123/a.apk',
    )
  })

  it('已经是绝对地址就原样返回', () => {
    const abs = 'https://github.com/o/r/releases/download/t/a.exe'
    expect(resolveUrl('https://x.test/packages.json', abs)).toBe(abs)
  })

  it('空值不产生假地址', () => {
    expect(resolveUrl('https://x.test/packages.json', '')).toBe('')
    expect(resolveUrl('', 'a.apk')).toBe('')
  })
})
