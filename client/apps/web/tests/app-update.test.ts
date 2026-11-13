import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_PACKAGE_ID,
  APP_PC_ID,
  APP_TV_ID,
  LEGACY_APP_IDS,
  isNewer,
  packageIdFor,
  fileNameFor,
  resolveUrl,
  currentVersion,
  sha256HexJs,
  formatNoteLines,
  downloadCandidates,
  isGitHubDownloadUrl,
  isReleaseEndpoint,
  isTagReleaseEndpoint,
  manifestAssetUrlFrom,
  pickManifestRelease,
  type AppUpdate,
} from '@/api/appUpdate'

/**
 * 纯 JS 的 sha256 —— 保留它作为**两端原生实现的对照标准**。
 *
 * 主路径已经不在浏览器里校验了（PC 走 Rust `sha2`，TV 走 Java `MessageDigest`），
 * 但"sha256 该怎么算"需要一个已知答案：写错一个常量不会报错，
 * 只会"校验永远不通过"或更糟——两边一起错导致校验永远通过。
 * 这里用 FIPS 180-4 的官方向量锁住它。
 */
describe('应用更新：sha256（纯 JS 实现，作为原生实现的对照标准）', () => {
  const enc = (s: string) => new TextEncoder().encode(s)

  it('空输入的摘要正确', () => {
    expect(sha256HexJs(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('abc 的摘要正确（FIPS 180-4 标准向量）', () => {
    expect(sha256HexJs(enc('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('跨块边界的长输入正确（55/56/64 字节是填充的临界点）', () => {
    expect(sha256HexJs(enc('a'.repeat(55)))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    )
    expect(sha256HexJs(enc('a'.repeat(56)))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    )
    expect(sha256HexJs(enc('a'.repeat(64)))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    )
  })

  it('输出恒为 64 位十六进制', () => {
    for (const n of [0, 1, 63, 65, 1000]) {
      expect(sha256HexJs(new Uint8Array(n).fill(n & 0xff))).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('应用更新：版本比较', () => {
  it('按数字逐段比较，不做字符串比较', () => {
    expect(isNewer('0.9.10', '0.9.9')).toBe(true)
    expect(isNewer('0.9.9', '0.9.10')).toBe(false)
    // 字符串比较会认为 '10' < '9'，这里必须是 false
    expect('0.9.10' > '0.9.9').toBe(false)
  })

  it('主版本/次版本升级也算更新', () => {
    expect(isNewer('0.10.0', '0.9.28')).toBe(true)
    expect(isNewer('1.0.0', '0.9.28')).toBe(true)
  })

  it('相同版本不算更新', () => {
    expect(isNewer('0.9.28', '0.9.28')).toBe(false)
  })

  it('位数不同时短的一侧按 0 补齐', () => {
    expect(isNewer('0.9.28.1', '0.9.28')).toBe(true)
    expect(isNewer('0.9', '0.9.0')).toBe(false)
  })

  it('空值/垃圾值不抛异常且判为不更新', () => {
    expect(isNewer('', '0.9.28')).toBe(false)
    expect(isNewer('0.9.28', '')).toBe(true)
    expect(isNewer('abc', '0.9.28')).toBe(false)
  })
})

describe('应用更新：条目 id 与平台', () => {
  it('PC 用 meow-pc，Android 用 meow-tv', () => {
    expect(packageIdFor('windows-x64')).toBe(APP_PC_ID)
    expect(packageIdFor('android-arm64')).toBe(APP_TV_ID)
    expect(packageIdFor('android-armv7')).toBe(APP_TV_ID)
    // 模拟器单独一档，但仍然读 TV 那条（同一个 apk）
    expect(packageIdFor('android-x86_64')).toBe(APP_TV_ID)
  })

  it('保留 id 的字面值是服务端产包与客户端读取之间的唯一约定', () => {
    /*
     * 钉死字面值：这三个 id 是「server/build-release.ps1 写进清单」与
     * 「客户端读清单挑条目」之间唯一的约定，两边不一致时表现为
     * 「检测不到更新」——而这个失败是静默的（清单能取到、只是没有匹配条目）。
     *
     * ★ 用品牌名 meow-* 而不是 app-*：清单是给人看的（用户可能手写、
     *   也可能在浏览器里直接打开排查），meow-pc / meow-tv 一眼知道是什么。
     *   其它条目也是品牌化的（apiserver / danmu-api / drpy），跟着统一。
     */
    expect(APP_PACKAGE_ID).toBe('app')
    expect(APP_PC_ID).toBe('meow-pc')
    expect(APP_TV_ID).toBe('meow-tv')
    // 旧 id 必须仍在兼容列表里，否则老清单读不到
    expect(LEGACY_APP_IDS).toContain('app')
    expect(LEGACY_APP_IDS).toContain('app-pc')
    expect(LEGACY_APP_IDS).toContain('app-tv')
  })
})

/**
 * 清单挂 Release 时的地址判定。
 *
 * 这两条判据分开是有原因的：都是「列资产的 release 端点」，但用途不同。
 *   · latest / tags 当**更新源**时 → 去里面找 packages.json 拉内容
 *   · tags 当**下载地址转换**的查询入口时 → 只要它的原始 JSON（资产列表）
 *
 * ★ 曾经把两者合成一个正则 `(latest|tags/[^/]+)`，结果
 *   `toDownloadableUrl` 走 fetchManifestText 时被当成"要找 packages.json"，
 *   那里没有该资产 → 静默失败 → 退回标准链接 → 私有仓 404。
 *   症状是"4 个地址全试完都失败"，很难看出根因。
 */
describe('应用更新：Release 端点判定', () => {
  it('latest 端点算清单端点', () => {
    expect(isReleaseEndpoint('https://api.github.com/repos/upchr/meow/releases/latest')).toBe(true)
    expect(isReleaseEndpoint('https://api.github.com/repos/upchr/meow/releases/latest/')).toBe(true)
  })

  it('tags 端点与 latest 分开判定（否则下载地址转换会踩坑）', () => {
    const tagsUrl = 'https://api.github.com/repos/upchr/meow/releases/tags/release-v0.9.34'
    expect(isTagReleaseEndpoint(tagsUrl)).toBe(true)
    // tags 不能同时被当成 latest
    expect(isReleaseEndpoint(tagsUrl)).toBe(false)
  })

  it('资产端点不算 release 端点（它是内容本身）', () => {
    const asset = 'https://api.github.com/repos/upchr/meow/releases/assets/123'
    expect(isReleaseEndpoint(asset)).toBe(false)
    expect(isTagReleaseEndpoint(asset)).toBe(false)
  })

  it('普通清单地址与标准下载链接都不算', () => {
    expect(isReleaseEndpoint('https://raw.githubusercontent.com/upchr/meow/main/packages.json')).toBe(false)
    expect(isReleaseEndpoint('http://127.0.0.1:8099/packages.json')).toBe(false)
    expect(
      isReleaseEndpoint('https://github.com/upchr/meow/releases/download/v1/a.exe'),
    ).toBe(false)
  })

  it('从 release JSON 里能找出 packages.json 资产', () => {
    const rel = JSON.stringify({
      url: 'https://api.github.com/repos/upchr/meow/releases/427443068',
      assets: [
        { id: 111, name: 'meow-setup-0.9.34.exe' },
        { id: 222, name: 'packages.json' },
      ],
    })
    expect(manifestAssetUrlFrom(rel)).toBe(
      'https://api.github.com/repos/upchr/meow/releases/assets/222',
    )
  })

  it('没有清单资产时返回空串（调用方据此给出可读错误）', () => {
    const rel = JSON.stringify({
      url: 'https://api.github.com/repos/upchr/meow/releases/1',
      assets: [{ id: 111, name: 'meow-setup-0.9.34.exe' }],
    })
    expect(manifestAssetUrlFrom(rel)).toBe('')
    expect(manifestAssetUrlFrom('not json')).toBe('')
  })
})
describe('应用更新：GitHub 代理候选', () => {
  it('识别 releases/download 链接（只有这种才需要代理）', () => {
    expect(isGitHubDownloadUrl('https://github.com/u/r/releases/download/v1/a.exe')).toBe(true)
    // API 资产端点不走代理：公共代理不转发 Authorization，中转会失败
    expect(isGitHubDownloadUrl('https://api.github.com/repos/u/r/releases/assets/1')).toBe(false)
    // 能取到就直连能用，不必绕
    expect(isGitHubDownloadUrl('http://127.0.0.1:8099/app.exe')).toBe(false)
  })

  it('直连排第一，代理依次跟在后面', () => {
    const u = 'https://github.com/u/r/releases/download/v1/a.exe'
    const c = downloadCandidates(u)
    expect(c[0]).toBe(u) // 能用就不绕路
    expect(c.length).toBeGreaterThan(1)
    // 每个代理都是"前缀 + 原地址"，客户端拿到的仍是原 URL 的路径
    for (const x of c.slice(1)) {
      expect(x.endsWith(u)).toBe(true)
      expect(x.startsWith('https://')).toBe(true)
    }
  })

  it('非 GitHub 地址不加代理（改了反而打不开）', () => {
    const u = 'http://127.0.0.1:8099/packages.json'
    expect(downloadCandidates(u)).toEqual([u])
  })
})

describe('应用更新：清单 url 解析', () => {
  it('相对文件名按清单目录解析（不是页面 origin）', () => {
    // TV 页面在 http://meow.local，直接请求相对名会 404
    expect(resolveUrl('http://127.0.0.1:8099/packages.json', 'app_tv-0.9.30.apk')).toBe(
      'http://127.0.0.1:8099/app_tv-0.9.30.apk',
    )
  })

  it('子目录部署时解析到子目录（不是域名根）', () => {
    expect(resolveUrl('http://host:9000/plugins/packages.json', 'x.apk')).toBe(
      'http://host:9000/plugins/x.apk',
    )
  })

  it('绝对地址原样保留（GitHub Release 就是这种）', () => {
    const abs = 'https://github.com/u/r/releases/download/v1/a.apk'
    expect(resolveUrl('http://x/packages.json', abs)).toBe(abs)
  })

  it('空 base / 空文件名返回空串（调用方据此跳过，不会请求到页面自身）', () => {
    expect(resolveUrl('', 'a.apk')).toBe('')
    expect(resolveUrl('http://x/packages.json', '')).toBe('')
  })
})

describe('应用更新：下载文件名', () => {
  it('从 url 取最后一段，去掉 query', () => {
    const up: AppUpdate = {
      version: '0.9.30',
      url: 'http://127.0.0.1:8099/app_tv-0.9.30.apk?token=abc',
      sha256: 'x',
      size: 1,
    }
    expect(fileNameFor(up)).toBe('app_tv-0.9.30.apk')
  })

  it('url 没有文件名时给平台默认名', () => {
    expect(
      fileNameFor({ version: '1', url: 'http://x/', sha256: 'y', size: 0, packageId: APP_TV_ID }),
    ).toBe('meow-tv.apk')
    expect(
      fileNameFor({ version: '1', url: 'http://x/', sha256: 'y', size: 0, packageId: APP_PC_ID }),
    ).toBe('meow-setup.exe')
  })
})

describe('应用更新：当前版本号', () => {
  it('来自构建注入；测试环境无注入时为空串，不抛异常', () => {
    const v = currentVersion()
    expect(typeof v).toBe('string')
    expect(v === '' || /^\d+\.\d+\.\d+$/.test(v)).toBe(true)
  })
})

/**
 * 清单挑条目的逻辑。
 *
 * 这段逻辑写在 `checkAppUpdate` 里（要读 localStorage 与实际平台，
 * 不适合在单测里直调），所以这里用一份等价实现锁住**判断规则**本身——
 * 规则错了的表现是"服务端发了包，客户端永远看不到"或"下错平台的包"，
 * 两种都不会报错，只能靠判据测出来。
 */
describe('应用更新：从清单挑哪个条目', () => {
  type Pkg = {
    version?: string
    url?: string
    sha256?: string
    platform?: string[]
  }

  /** 与 checkAppUpdate 里的挑选规则保持等价 */
  function pick(
    packages: Record<string, Pkg>,
    platform: string,
    cur: string,
  ): { id: string; version: string; url: string } | null {
    const id = packageIdFor(platform as never)
    const candidates: Array<[string, Pkg]> = []
    if (packages[id]) candidates.push([id, packages[id]])
    if (packages[APP_PACKAGE_ID]) candidates.push([APP_PACKAGE_ID, packages[APP_PACKAGE_ID]])
    for (const [pid, pkg] of candidates) {
      if (pkg.platform && pkg.platform.length && !pkg.platform.includes(platform)) continue
      if (!pkg.version || !isNewer(pkg.version, cur)) continue
      if (!pkg.url) continue
      return { id: pid, version: pkg.version, url: pkg.url }
    }
    return null
  }

  it('PC 客户端不会拿到 apk 条目', () => {
    const pkgs: Record<string, Pkg> = {
      'meow-pc': { version: '0.9.30', url: 'setup.exe', platform: ['windows-x64'] },
      'meow-tv': { version: '0.9.30', url: 'tv.apk', platform: ['android-arm64'] },
    }
    expect(pick(pkgs, 'windows-x64', '0.9.29')?.url).toBe('setup.exe')
    expect(pick(pkgs, 'android-arm64', '0.9.29')?.url).toBe('tv.apk')
  })

  it('旧格式单条 app 仍能读（只在该平台列了它时）', () => {
    const legacy: Record<string, Pkg> = {
      app: { version: '0.9.30', url: 'tv.apk', platform: ['android-arm64'] },
    }
    expect(pick(legacy, 'android-arm64', '0.9.29')).toEqual({
      id: 'app',
      version: '0.9.30',
      url: 'tv.apk',
    })
    // Windows 上不该把 apk 下下来
    expect(pick(legacy, 'windows-x64', '0.9.29')).toBeNull()
  })

  it('清单显示平台不匹配时明确跳过，而不是下错包', () => {
    const pkgs: Record<string, Pkg> = {
      'meow-tv': { version: '0.9.30', url: 'tv.apk', platform: ['android-arm64', 'android-armv7'] },
    }
    // 模拟器（x86_64）不在清单里 → 没有可用更新，比装不上的包好
    expect(pick(pkgs, 'android-x86_64', '0.9.29')).toBeNull()
    expect(pick(pkgs, 'android-arm64', '0.9.29')?.url).toBe('tv.apk')
  })

  it('版本不高于当前 → 不提示', () => {
    const pkgs: Record<string, Pkg> = {
      'meow-pc': { version: '0.9.29', url: 'setup.exe', platform: ['windows-x64'] },
    }
    expect(pick(pkgs, 'windows-x64', '0.9.29')).toBeNull()
    expect(pick(pkgs, 'windows-x64', '0.9.30')).toBeNull()
  })

  it('清单里没有对应条目 → 返回 null（不抛异常）', () => {
    expect(pick({}, 'windows-x64', '0.9.29')).toBeNull()
    expect(pick({ apiserver: { version: '9.9.9', url: 'a.zip' } }, 'windows-x64', '0.9.29')).toBeNull()
  })

  it('缺 url 的条目不能用（否则下载地址是页面自身）', () => {
    const pkgs: Record<string, Pkg> = {
      'meow-pc': { version: '0.9.30', platform: ['windows-x64'] },
    }
    expect(pick(pkgs, 'windows-x64', '0.9.29')).toBeNull()
  })
})

/**
 * 从 release 列表挑源（加固 2026-10-29）。
 *
 * 不用 `/releases/latest` 的四个坑：
 *   ① 按发布时间挑 → 补发旧版 hotfix 会让客户端降级
 *   ② draft 不参与 → 忘了 Publish 就永远看不到
 *   ③ 不检查有没有清单 → 落到没 packages.json 的 release 会让
 *      **整个更新链路**瘫痪（不只是插件没了）
 *   ④ 私有仓 + 抖动时偶发 5xx
 */
describe('应用更新：从 release 列表挑源', () => {
  const mk = (o: Record<string, unknown>) => JSON.stringify(o)

  it('跳过 draft / prerelease / 无清单的，取版本最大', () => {
    const list = mk([
      { tag_name: 'release-v0.9.37', draft: true, assets: [{ name: 'packages.json', id: 1 }] },
      { tag_name: 'release-v0.9.36', draft: false, assets: [{ name: 'meow-setup-0.9.36.exe' }] },
      { tag_name: 'release-v0.9.35', draft: false, assets: [{ name: 'packages.json', id: 3 }] },
      { tag_name: 'release-v0.9.34', draft: false, assets: [{ name: 'packages.json', id: 4 }] },
    ])
    expect(pickManifestRelease(list)).toBe('release-v0.9.35')
  })

  it('补发旧版 hotfix 不会让客户端降级（latest 的坑）', () => {
    const list = mk([
      // 0.9.29 发布更晚但版本更小
      { tag_name: 'release-v0.9.29', published_at: '2026-10-30T00:00:00Z', assets: [{ name: 'packages.json' }] },
      { tag_name: 'release-v0.9.35', published_at: '2026-10-29T00:00:00Z', assets: [{ name: 'packages.json' }] },
    ])
    expect(pickManifestRelease(list)).toBe('release-v0.9.35')
  })

  it('prerelease 也跳过', () => {
    const list = mk([
      { tag_name: 'release-v1.0.0', prerelease: true, assets: [{ name: 'packages.json' }] },
      { tag_name: 'release-v0.9.35', prerelease: false, assets: [{ name: 'packages.json' }] },
    ])
    expect(pickManifestRelease(list)).toBe('release-v0.9.35')
  })

  it('挑不出来时返回空串（调用方给可读错误，不会当成"已是最新"）', () => {
    expect(pickManifestRelease(mk([]))).toBe('')
    expect(
      pickManifestRelease(
        mk([{ tag_name: 'release-v1.0.0', draft: true, assets: [{ name: 'packages.json' }] }]),
      ),
    ).toBe('')
    expect(pickManifestRelease('not json')).toBe('')
  })

  it('版本号按数字比较，不是字符串', () => {
    const list = mk([
      { tag_name: 'release-v0.9.9', assets: [{ name: 'packages.json' }] },
      { tag_name: 'release-v0.9.10', assets: [{ name: 'packages.json' }] },
    ])
    // 字符串比较会选 0.9.9
    expect(pickManifestRelease(list)).toBe('release-v0.9.10')
  })
})

describe('更新条目带发布日期', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'api', 'appUpdate.ts'), 'utf8')

  it('清单的 lasttime 映射到 AppUpdate.lasttime', () => {
    // 没有日期时用户无法判断"这是新包还是隔了很久才看到的旧包"
    expect(SRC).toMatch(/lasttime\?: string/)
    expect(SRC).toContain('lasttime: pkg.lasttime')
  })

  it('弹框和设置页都显示发布日期', () => {
    const dlg = readFileSync(
      join(__dirname, '..', 'src', 'components', 'common', 'UpdateDialog.vue'), 'utf8')
    const set = readFileSync(join(__dirname, '..', 'src', 'views', 'SettingsView.vue'), 'utf8')
    expect(dlg).toContain('found?.lasttime')
    expect(set).toContain('updFound.lasttime')
  })
})

describe('更新说明按序号显示', () => {
  const NL = String.fromCharCode(10)

  it('CHANGELOG 已编号的保持原样', () => {
    const out = formatNoteLines(['1. 甲', '2. 乙'].join(NL))
    expect(out).toEqual(['1. 甲', '2. 乙'])
  })

  it('没有编号的自动补序号（git log 兜底来源）', () => {
    const out = formatNoteLines(['修复播放失败', '优化弹幕'].join(NL))
    expect(out).toEqual(['1. 修复播放失败', '2. 优化弹幕'])
  })

  it('中文顿号/右括号也算已编号，不重复加', () => {
    expect(formatNoteLines(['1、甲', '2) 乙'].join(NL))).toEqual(['1、甲', '2) 乙'])
  })

  it('空串与空行', () => {
    expect(formatNoteLines('')).toEqual([])
    expect(formatNoteLines(['', '  ', ''].join(NL))).toEqual([])
  })
})

/*
 * 一步到位（2026-11-13 用户报"下载完出现安装按钮 → 点了又读进度条 → 死循环"）。
 *
 * 这几条是**行为契约**，不是实现细节：下载完成后必须自动调起安装器，
 * 界面上不允许再出现第二次「安装」按钮。同一条链路两处 UI（启动弹框 /
 * 设置页）都要守。
 */
describe('应用更新：一步到位（不再二次确认安装）', () => {
  const webSrc = join(process.cwd(), 'src')
  const read = (p: string) => readFileSync(join(webSrc, p), 'utf8')

  it('启动弹框：主按钮只有「更新 / 处理中」，没有「安装」分支', () => {
    const dialog = read('components/common/UpdateDialog.vue')
    expect(dialog).not.toMatch(/ready\s*\?\s*'安装'/)
    expect(dialog).toContain("'更新'")
    // 死循环的根因就是 onPrimary 不看状态永走下载 —— 现在它只允许一条路径
    const i = dialog.indexOf('function onPrimary')
    const body = dialog.slice(i, i + 400)
    expect(body).toContain('runDownloadAndInstall()')
    expect(body).not.toContain('runInstall')
  })

  it('store：下载校验通过后直接调起安装器（调起失败要报错而不是静默）', () => {
    const store = read('stores/appUpdate.ts')
    const i = store.indexOf('export async function runDownloadAndInstall')
    const body = store.slice(i, i + 3000)
    expect(body).toMatch(/phase\.value = 'installing'[\s\S]{0,400}installDownloaded\(\)/)
    expect(body).toContain("phase.value = 'done'")
  })

  it('设置页：按钮恒为「更新」，取消只在下载阶段出现', () => {
    const settings = read('views/SettingsView.vue')
    expect(settings).not.toContain("updReady ? '安装'")
    expect(settings).toContain("updPhase === 'downloading'")
    const i = settings.indexOf('async function downloadAndInstall')
    const body = settings.slice(i, i + 400)
    expect(body).toContain('runUpdInstall()')
    expect(body).not.toContain('runUpdDoInstall')
  })

  it('TV：更新日志区是 tv-nav 的滚动停靠点（data-tv-scroll + tabindex）', () => {
    const dialog = read('components/common/UpdateDialog.vue')
    // 两个属性缺一个：要么焦点进不来，要么上下键不滚（tv-nav 的约定）
    expect(dialog).toMatch(/data-tv-scroll/)
    expect(dialog).toMatch(/ref="notesEl"[\s\S]{0,120}tabindex="0"/)
    // 内容被截断时要有「↑↓ 滚动」提示，否则用户不知道还有条目
    expect(dialog).toContain('滚动查看全部')
  })
})

/*
 * TV 壳里设置页的文本输入框：不接管就**点不进去**（WebView 不聚焦、不弹输入法），
 * 用户看到的是"填了更新源还是取不到新版本"（2026-11-13 MuMu 实测）。
 */
describe('应用更新：TV 上自定义更新源可输入', () => {
  const webSrc = join(process.cwd(), 'src')
  it('更新源/备用源就地编辑（data-tv-input-owner + tvInlineInput，不弹对话框）', () => {
    const settings = readFileSync(join(webSrc, 'views/SettingsView.vue'), 'utf8')
    expect(settings).toContain('data-tv-input-owner')
    expect(settings).toContain('@click="editUpdateSource"')
    expect(settings).toContain('@click="editBackupSource"')
    expect(settings).toContain('tvInlineInput(ev')
    const bridge = readFileSync(join(webSrc, 'api/nativeBridge.ts'), 'utf8')
    expect(bridge).toContain('export function tvInlineInput')
  })
})
