import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_GIT_ACCEL,
  enabledProxyPrefixes,
  gitAccelCandidates,
  jsdelivrUrlForRaw,
  markAccelResult,
  normalizeGitAccel,
  normalizeProxyPrefix,
  rawUrlForJsdelivr,
  resetGitAccelHealth,
  type GitAccelPrefs,
} from '../src/api/gitAccel'
import { downloadCandidates, manifestAssetUrlFrom } from '../src/api/appUpdate'
import { fetchIndex, fpkIndexBases } from '../src/api/fpkUpgrade'
import { savePrefs } from '../src/stores/prefs'

function clone(p: GitAccelPrefs = DEFAULT_GIT_ACCEL): GitAccelPrefs {
  return JSON.parse(JSON.stringify(p)) as GitAccelPrefs
}

beforeEach(() => resetGitAccelHealth())

describe('GitHub 加速：配置规范化', () => {
  it('默认顺序是 直连 → gh-proxy → ghfast → ghproxy.net → 停用的 gh.llkk', () => {
    const a = normalizeGitAccel(undefined)
    expect(a.enabled).toBe(true)
    expect(a.directFirst).toBe(true)
    expect(a.proxies.map((p) => p.id).slice(0, 4)).toEqual([
      'gh-proxy',
      'ghfast',
      'ghproxy-net',
      'gh-llkk',
    ])
    expect(a.proxies.find((p) => p.id === 'gh-llkk')?.enabled).toBe(false)
  })

  it('内置项补齐、非法前缀丢弃、自定义项保留', () => {
    const a = normalizeGitAccel({
      enabled: true,
      proxies: [
        { id: 'gh-proxy', name: 'x', prefix: 'http://bad.example/', enabled: true, builtin: true },
        { id: 'mine', name: '我的', prefix: 'https://example.com/', enabled: true, builtin: false },
      ],
    })
    expect(a.proxies.some((p) => p.id === 'mine')).toBe(true)
    // http:// 的内置项被丢弃后，用预设前缀补回
    expect(a.proxies.find((p) => p.id === 'gh-proxy')?.prefix).toBe('https://gh-proxy.com/')
  })

  it('前缀补尾斜杠；模板保留 {url}', () => {
    expect(normalizeProxyPrefix('https://ghfast.top')).toBe('https://ghfast.top/')
    expect(normalizeProxyPrefix('https://x.test/{url}')).toBe('https://x.test/{url}')
    expect(normalizeProxyPrefix('http://x.test/')).toBe('')
  })
})

describe('GitHub 加速：候选生成', () => {
  it('raw 索引：直连 + 启用的代理 + jsDelivr', () => {
    const raw = 'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json'
    const c = gitAccelCandidates(raw, DEFAULT_GIT_ACCEL, { for: 'fpk', index: true })
    expect(c[0].url).toBe(raw)
    expect(c.some((x) => x.proxyId === 'gh-proxy')).toBe(true)
    expect(c.some((x) => x.proxyId === 'ghfast')).toBe(true)
    expect(c.some((x) => x.proxyId === 'ghproxy-net')).toBe(true)
    expect(c.some((x) => x.proxyId === 'jsdelivr')).toBe(true)
    // baseUrl 必须是未加代理的逻辑地址（相对 download_url 靠它解析）
    for (const x of c) expect(x.baseUrl).toBe(raw)
  })

  it('安装包 >20MB 不生成 jsDelivr；<20MB 才生成', () => {
    const raw = 'https://raw.githubusercontent.com/upchr/FnDepot/c/meow_1.1.7_x86.fpk'
    const big = gitAccelCandidates(raw, DEFAULT_GIT_ACCEL, { for: 'fpk', size: 21_700_000 })
    expect(big.some((x) => x.proxyId === 'jsdelivr')).toBe(false)
    const small = gitAccelCandidates(raw, DEFAULT_GIT_ACCEL, { for: 'fpk', size: 19_000_000 })
    expect(small.some((x) => x.proxyId === 'jsdelivr')).toBe(true)
  })

  it('api.github.com 默认不挂代理；公开源显式 allowApi 才挂', () => {
    const api = 'https://api.github.com/repos/upchr/meow/releases/latest'
    const priv = gitAccelCandidates(api, DEFAULT_GIT_ACCEL, { for: 'appUpdate' })
    expect(priv.map((x) => x.url)).toEqual([api])
    const pub = gitAccelCandidates(api, DEFAULT_GIT_ACCEL, { for: 'appUpdate', allowApi: true })
    expect(pub.some((x) => x.proxyId === 'gh-proxy')).toBe(true)
  })

  it('github.com 只代理 release 资产，仓库页面不代理', () => {
    const dl = 'https://github.com/upchr/meow/releases/download/v1/a.exe'
    expect(gitAccelCandidates(dl, DEFAULT_GIT_ACCEL, { for: 'appUpdate' }).length).toBeGreaterThan(1)
    const page = 'https://github.com/upchr/meow'
    expect(gitAccelCandidates(page, DEFAULT_GIT_ACCEL, { for: 'appUpdate' })).toEqual([
      { url: page, baseUrl: page },
    ])
  })

  it('自定义模板 {url} 生效', () => {
    const a = clone()
    a.proxies.push({
      id: 'mine',
      name: 'mine',
      prefix: 'https://x.test/proxy?u={url}',
      enabled: true,
      builtin: false,
    })
    const raw = 'https://raw.githubusercontent.com/o/r/main/fnpack.json'
    const c = gitAccelCandidates(raw, a, { for: 'fpk', index: true })
    expect(c.some((x) => x.url === 'https://x.test/proxy?u=' + raw)).toBe(true)
  })

  it('未勾选的渠道 / 关闭总开关 → 只返回直连', () => {
    const a = clone()
    a.useFor.fpk = false
    const raw = 'https://raw.githubusercontent.com/o/r/main/fnpack.json'
    expect(gitAccelCandidates(raw, a, { for: 'fpk', index: true })).toHaveLength(1)
    const b = clone()
    b.enabled = false
    expect(gitAccelCandidates(raw, b, { for: 'fpk', index: true })).toHaveLength(1)
  })

  it('代理失败进冷却后不再生成', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/fnpack.json'
    const first = gitAccelCandidates(raw, DEFAULT_GIT_ACCEL, { for: 'fpk', index: true })
    const gh = first.find((x) => x.proxyId === 'gh-proxy')
    expect(gh).toBeTruthy()
    markAccelResult(gh!, false)
    const second = gitAccelCandidates(raw, DEFAULT_GIT_ACCEL, { for: 'fpk', index: true })
    expect(second.some((x) => x.proxyId === 'gh-proxy')).toBe(false)
  })

  it('jsDelivr 只转换 raw URL', () => {
    expect(jsdelivrUrlForRaw('https://raw.githubusercontent.com/o/r/main/a.json')).toBe(
      'https://cdn.jsdelivr.net/gh/o/r@main/a.json',
    )
    expect(jsdelivrUrlForRaw('https://github.com/o/r')).toBe('')
  })

  it('全部代理都在冷却时仍要给出代理候选（否则只剩直连 = 「加速没生效」）', () => {
    // 2026-11-13 .77 实测：一次失败把三条代理全打进 10 分钟冷却，
    // 之后每次检查候选只剩直连，必然 15s 超时 —— 用户的原话就是
    // 「他们都没有走 git 加速」。
    const asset = 'https://github.com/upchr/meow/releases/latest/download/packages.json'
    for (const id of ['gh-proxy', 'ghfast', 'ghproxy-net']) {
      markAccelResult({ url: 'x', baseUrl: asset, proxyId: id }, false)
    }
    const c = gitAccelCandidates(asset, DEFAULT_GIT_ACCEL, { for: 'appUpdate' })
    const proxied = c.filter((x) => x.proxyId && x.proxyId !== 'direct')
    expect(proxied.length, '冷却期把所有代理都剔掉了').toBeGreaterThan(0)
  })

  it('直连失败也进冷却，且只把直连挪到最后（不丢弃）', () => {
    const asset = 'https://github.com/upchr/meow/releases/latest/download/packages.json'
    const before = gitAccelCandidates(asset, DEFAULT_GIT_ACCEL, { for: 'appUpdate' })
    const direct = before.find((x) => x.proxyId === 'direct')
    expect(direct, '直连候选没有 id，失败就无法冷却').toBeTruthy()
    markAccelResult(direct!, false)
    const after = gitAccelCandidates(asset, DEFAULT_GIT_ACCEL, { for: 'appUpdate' })
    expect(after).toHaveLength(before.length)
    expect(after[after.length - 1].proxyId).toBe('direct')
  })
})

describe('GitHub 加速：jsDelivr 地址反向归一（否则整条链路短路）', () => {
  const jsdIndex = 'https://cdn.jsdelivr.net/gh/upchr/FnDepot@main/fnpack.json'
  const jsdPkg = 'https://cdn.jsdelivr.net/gh/upchr/FnDepot@main/meow/meow_1.2.5_x86.fpk'
  const rawIndex = 'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json'
  const rawPkg = 'https://raw.githubusercontent.com/upchr/FnDepot/main/meow/meow_1.2.5_x86.fpk'

  it('rawUrlForJsdelivr 是 jsdelivrUrlForRaw 的逆；非 jsDelivr 返回空', () => {
    expect(rawUrlForJsdelivr(jsdIndex)).toBe(rawIndex)
    expect(rawUrlForJsdelivr(jsdPkg)).toBe(rawPkg)
    expect(rawUrlForJsdelivr('https://raw.githubusercontent.com/o/r/main/a')).toBe('')
    expect(rawUrlForJsdelivr('https://github.com/o/r')).toBe('')
  })

  it('jsDelivr 索引：直连仍用 jsDelivr（快），但 baseUrl 归一到 raw，且代理候选生效', () => {
    const c = gitAccelCandidates(jsdIndex, DEFAULT_GIT_ACCEL, { for: 'fpk', index: true })
    expect(c[0].url).toBe(jsdIndex)
    expect(c.some((x) => x.proxyId === 'gh-proxy')).toBe(true)
    expect(c.some((x) => x.proxyId === 'ghfast')).toBe(true)
    for (const x of c) expect(x.baseUrl).toBe(rawIndex)
  })

  it('jsDelivr 大包（39.5MB）：不下发 jsDelivr 直连，直连换成 raw', () => {
    const c = gitAccelCandidates(jsdPkg, DEFAULT_GIT_ACCEL, { for: 'fpk', size: 39_549_063 })
    expect(c.some((x) => x.url === jsdPkg)).toBe(false)
    expect(c[0].url).toBe(rawPkg)
    expect(c.some((x) => x.proxyId === 'gh-proxy')).toBe(true)
    for (const x of c) expect(x.baseUrl).toBe(rawPkg)
  })

  it('jsDelivr 小包（19MB）保留 jsDelivr 直连', () => {
    const c = gitAccelCandidates(jsdPkg, DEFAULT_GIT_ACCEL, { for: 'fpk', size: 19_000_000 })
    expect(c[0].url).toBe(jsdPkg)
  })

  it('体积未知（清单/索引）时保留 jsDelivr 直连，baseUrl 仍归一到 raw', () => {
    const c = gitAccelCandidates(jsdPkg, DEFAULT_GIT_ACCEL, { for: 'appUpdate' })
    expect(c[0].url).toBe(jsdPkg)
    for (const x of c) expect(x.baseUrl).toBe(rawPkg)
  })

  it('加速关闭时，jsDelivr 大包也换成 raw 直连（否则必然 403）', () => {
    const a = clone()
    a.enabled = false
    const c = gitAccelCandidates(jsdPkg, a, { for: 'fpk', size: 39_549_063 })
    expect(c).toEqual([{ url: rawPkg, baseUrl: rawPkg }])
  })
})

describe('GitHub 加速：对外前缀', () => {
  it('只返回启用项，且不含 jsDelivr', () => {
    const p = enabledProxyPrefixes(DEFAULT_GIT_ACCEL, 'pluginSource')
    expect(p).toContain('https://gh-proxy.com/')
    expect(p).toContain('https://ghfast.top/')
    expect(p.some((x) => x.includes('jsdelivr'))).toBe(false)
  })

  it('关闭插件源渠道 → 空数组（PC 原生据此不挂代理）', () => {
    const a = clone()
    a.useFor.pluginSource = false
    expect(enabledProxyPrefixes(a, 'pluginSource')).toEqual([])
  })
})

describe('应用更新：公开/私有仓的资产选择', () => {
  const rel = JSON.stringify({
    url: 'https://api.github.com/repos/upchr/meow/releases/1',
    assets: [
      {
        id: 456,
        name: 'packages.json',
        browser_download_url:
          'https://github.com/upchr/meow/releases/download/v1/packages.json',
      },
    ],
  })

  it('无 token 优先标准下载链接（这样代理才生效）', () => {
    expect(manifestAssetUrlFrom(rel)).toBe(
      'https://github.com/upchr/meow/releases/download/v1/packages.json',
    )
  })

  it('有 token 用 API 资产端点（私有仓唯一可用路径）', () => {
    expect(manifestAssetUrlFrom(rel, 'ghp_x')).toBe(
      'https://api.github.com/repos/upchr/meow/releases/assets/456',
    )
  })

  it('downloadCandidates 对公开 raw 也生成代理候选', () => {
    const raw = 'https://raw.githubusercontent.com/upchr/meow/main/a.apk'
    const c = downloadCandidates(raw, DEFAULT_GIT_ACCEL)
    expect(c[0]).toBe(raw)
    expect(c.length).toBeGreaterThan(1)
  })
})

describe('fpk 索引：候选回退（集成）', () => {
  it('坏代理被跳过，最终用 raw 成功，且返回值按逻辑地址解析', async () => {
    const calls: string[] = []
    const raw = 'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json'
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input)
      calls.push(u)
      if (u === raw) {
        return new Response(JSON.stringify({ apps: { meow: { releases: {} } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error('dead proxy')
    }) as typeof fetch
    try {
      const accel = clone()
      accel.directFirst = false // 先试代理，证明坏代理会被跳过
      savePrefs({ gitAccel: accel })
      const idx = await fetchIndex('upchr/FnDepot')
      expect(idx.url).toBe(raw)
      expect(idx.apps.meow).toBeTruthy()
      expect(calls).toContain(raw)
      expect(calls.length).toBeGreaterThan(1)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('默认 jsDelivr 索引：返回的 base 是 raw 等价地址（相对包地址才不会落回 jsDelivr）', async () => {
    const jsd = 'https://cdn.jsdelivr.net/gh/upchr/FnDepot@main/fnpack.json'
    const raw = 'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json'
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input) === jsd) {
        return new Response(JSON.stringify({ apps: { meow: { releases: {} } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error('unexpected ' + String(input))
    }) as typeof fetch
    try {
      savePrefs({ gitAccel: clone() })
      const idx = await fetchIndex(jsd)
      expect(idx.url).toBe(raw)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('fpk 索引地址归一化', () => {
  it('owner/repo 与 GitHub 仓库地址都能归一化到 raw index', () => {
    expect(fpkIndexBases('upchr/FnDepot')).toEqual([
      'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json',
    ])
    expect(fpkIndexBases('https://github.com/upchr/FnDepot')).toEqual([
      'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json',
    ])
    expect(fpkIndexBases('https://github.com/upchr/FnDepot/tree/dev')).toEqual([
      'https://raw.githubusercontent.com/upchr/FnDepot/dev/fnpack.json',
    ])
  })

  it('完整 URL 原样保留；jsDelivr 额外补 raw 等价地址', () => {
    expect(fpkIndexBases('https://x.test/fnpack.json')).toEqual([
      'https://x.test/fnpack.json',
    ])
    const jsd = 'https://cdn.jsdelivr.net/gh/upchr/FnDepot@main/fnpack.json'
    expect(fpkIndexBases(jsd)).toEqual([
      jsd,
      'https://raw.githubusercontent.com/upchr/FnDepot/main/fnpack.json',
    ])
  })
})
