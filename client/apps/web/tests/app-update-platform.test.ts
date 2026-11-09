import { describe, it, expect } from 'vitest'
import {
  entryFitsPlatform,
  familyOf,
  platformOfPackageId,
  platformOfUrl,
} from '@/api/appUpdate'

/**
 * 平台校验（三层：id → platform 数组 → 扩展名）。
 *
 * 起因：`checkAppUpdate` 原来的判据是
 *
 * ```js
 * if (pkg.platform && pkg.platform.length && !pkg.platform.includes(platform)) continue
 * ```
 *
 * 当 `platform` 缺失时前两个条件都是 false，整个 `&&` 为 false —— **直接放行**。
 * 而 `LEGACY_APP_IDS` 里同时有 `app-pc` 和 `app-tv`，PC 端的候选列表本来就
 * 会包含 TV 条目。于是清单一旦少写 `platform`，PC 就会把 13MB 的 APK 下下来，
 * 然后安装器报「不是有效的 Win32 应用」——用户会以为应用坏了。
 */

describe('id 隐含的平台', () => {
  it('按后缀识别品牌 id', () => {
    expect(platformOfPackageId('meow-pc')).toBe('windows')
    expect(platformOfPackageId('meow-tv')).toBe('android')
    expect(platformOfPackageId('app-pc')).toBe('windows')
    expect(platformOfPackageId('app-tv')).toBe('android')
  })

  it('旧的单条 app 推不出平台（当年 PC/TV 共用一条）', () => {
    expect(platformOfPackageId('app')).toBe(null)
    expect(platformOfPackageId('')).toBe(null)
    expect(platformOfPackageId('apiserver')).toBe(null)
  })

  it('大小写与空白不影响（清单可能手写）', () => {
    expect(platformOfPackageId('  MEOW-PC  ')).toBe('windows')
    expect(platformOfPackageId('Meow-TV')).toBe('android')
  })
})

describe('url 扩展名隐含的平台', () => {
  it('认 exe / msi / apk', () => {
    expect(platformOfUrl('https://x/a/meow-setup-0.9.38.exe')).toBe('windows')
    expect(platformOfUrl('https://x/a/meow.msi')).toBe('windows')
    expect(platformOfUrl('https://x/a/meow-tv.apk')).toBe('android')
  })

  it('带 query / hash 也要认（下载端点常挂 token）', () => {
    expect(platformOfUrl('https://x/a/b.apk?token=abc&t=1')).toBe('android')
    expect(platformOfUrl('https://x/a/b.exe#frag')).toBe('windows')
  })

  it('推不出时返回 null，不猜（自建源可用自定义文件名）', () => {
    expect(platformOfUrl('http://127.0.0.1:8123/download/latest')).toBe(null)
    expect(platformOfUrl('')).toBe(null)
  })

  it('.apk 的伪装不能被当成 android（防止 a.apk.exe 之类）', () => {
    // 末尾才是真实扩展名：Windows 会按 .exe 执行
    expect(platformOfUrl('https://x/a/malware.apk.exe')).toBe('windows')
  })
})

describe('entryFitsPlatform：三层判据', () => {
  it('Web 端一律不匹配（没有安装包概念）', () => {
    expect(entryFitsPlatform('meow-pc', ['windows-x64'], 'web')).toBe(false)
    expect(entryFitsPlatform('meow-tv', ['android-arm64'], 'web')).toBe(false)
  })

  it('id 与设备不符时拒绝，即使 platform 数组包含本机（冲突以 id 为准）', () => {
    // 这是最危险的一种：清单写错成 meow-tv 但 platform 抄了 windows-x64
    expect(entryFitsPlatform('meow-tv', ['windows-x64'], 'windows-x64')).toBe(false)
    expect(entryFitsPlatform('meow-pc', ['android-arm64'], 'android-arm64')).toBe(false)
  })

  it('★ platform 缺失时按 id 放行（原来的 bug 就是这里整体放行）', () => {
    // 修复后：PC 端拿到「没有 platform 的 meow-tv」必须拒绝
    expect(entryFitsPlatform('meow-tv', undefined, 'windows-x64')).toBe(false)
    expect(entryFitsPlatform('meow-tv', [], 'windows-x64')).toBe(false)
    // 同一条目在 TV 上要放行
    expect(entryFitsPlatform('meow-tv', undefined, 'android-arm64')).toBe(true)
    expect(entryFitsPlatform('meow-pc', undefined, 'windows-x64')).toBe(true)
  })

  it('★ platform 缺失且 id 推不出平台（旧的 app 单条）时拒绝', () => {
    /*
     * 刻意选"宁可不下"：下错包的代价（流量 + 安装器报错 + 用户以为应用坏了）
     * 远大于"这次没提示更新"。
     */
    expect(entryFitsPlatform('app', undefined, 'windows-x64')).toBe(false)
    expect(entryFitsPlatform('app', [], 'android-arm64')).toBe(false)
  })

  it('旧的 app 单条只要有 platform 数组就能正常工作（兼容不能丢）', () => {
    expect(entryFitsPlatform('app', ['windows-x64'], 'windows-x64')).toBe(true)
    expect(entryFitsPlatform('app', ['android-arm64'], 'android-arm64')).toBe(true)
    expect(entryFitsPlatform('app', ['windows-x64'], 'android-arm64')).toBe(false)
  })

  it('模拟器 x86_64 不能拿 arm64 的包（会 INSTALL_FAILED_NO_MATCHING_ABIS）', () => {
    const tvPlatforms = ['android-arm64', 'android-armv7', 'android-x86_64']
    expect(entryFitsPlatform('meow-tv', tvPlatforms, 'android-x86_64')).toBe(true)
    expect(entryFitsPlatform('meow-tv', ['android-arm64'], 'android-x86_64')).toBe(false)
    expect(entryFitsPlatform('meow-tv', ['android-x86_64'], 'android-arm64')).toBe(false)
  })
})

describe('familyOf', () => {
  it('三个 Android ABI 都归 android（判"能不能装"只看家族）', () => {
    expect(familyOf('android-arm64')).toBe('android')
    expect(familyOf('android-armv7')).toBe('android')
    expect(familyOf('android-x86_64')).toBe('android')
    expect(familyOf('windows-x64')).toBe('windows')
    expect(familyOf('web')).toBe('web')
  })
})
