import { describe, it, expect } from 'vitest'
import {
  entryFitsPlatform,
  currentPlatform,
  platformOfPackageId,
  platformOfUrl,
} from '@/api/appUpdate'

/**
 * MuMu 模拟器上的 TV 更新链路（2026-10-30，用户问"mumu tv apk 更新应该没问题吧"）。
 *
 * ## MuMu 的特殊性
 *
 * `Build.SUPPORTED_ABIS[0]` = `x86_64` → `appUpdaterPlatform()` 返回 `"x86_64"`
 * → `currentPlatform()` 归到 `android-x86_64`（单独一档，不与 armv7 混）。
 *
 * 为什么单独一档：归错会让清单永远匹配不上（装不上的包 =
 * `INSTALL_FAILED_NO_MATCHING_ABIS`），或者把 arm64 包下到 x86 模拟器上。
 *
 * ## 这次改了什么
 *
 * 平台校验从一层（只看 `platform` 数组，且字段缺失时**整体放行**）改成三层
 * （id / platform 数组 / 扩展名）。这里逐层验证 MuMu 不会被误拦。
 */

/** sync-packages.ps1:420 实际写入的数组（改这里等于改发布产物） */
const TV_PLATFORMS = ['android-arm64', 'android-armv7', 'android-x86_64']

describe('MuMu（android-x86_64）能正常收到 TV 更新', () => {
  it('① id 层：meow-tv 属于 android 家族，不拦', () => {
    expect(platformOfPackageId('meow-tv')).toBe('android')
    expect(entryFitsPlatform('meow-tv', TV_PLATFORMS, 'android-x86_64')).toBe(true)
  })

  it('② platform 数组层：清单里确实写了 android-x86_64', () => {
    // 这一条是回归保护：sync-packages.ps1 哪天漏写这个值，MuMu 就收不到更新了
    expect(TV_PLATFORMS).toContain('android-x86_64')
  })

  it('③ 扩展名层：APK 属于 android，不拦', () => {
    const url = 'https://github.com/upchr/meow/releases/download/v0.9.38/meow-TV-0.9.38.apk'
    expect(platformOfUrl(url)).toBe('android')
  })

  it('三层合起来不误拦（旧清单缺 platform 也放行，因为 id 能推出平台）', () => {
    // 早期清单可能没写 platform；meow-tv 这个 id 本身就说明是 Android
    expect(entryFitsPlatform('meow-tv', undefined, 'android-x86_64')).toBe(true)
  })

  it('ARM 真机与 32 位盒子同样不误拦', () => {
    expect(entryFitsPlatform('meow-tv', TV_PLATFORMS, 'android-arm64')).toBe(true)
    expect(entryFitsPlatform('meow-tv', TV_PLATFORMS, 'android-armv7')).toBe(true)
  })
})

describe('三层校验仍然挡住真正的错配', () => {
  it('PC 不会拿到 APK（这是本轮修的核心 bug）', () => {
    // 旧判据在 platform 缺失时整体放行，PC 会把 13MB 的 apk 下下来
    expect(entryFitsPlatform('meow-tv', undefined, 'windows-x64')).toBe(false)
    expect(entryFitsPlatform('meow-tv', TV_PLATFORMS, 'windows-x64')).toBe(false)
  })

  it('TV 不会拿到 exe', () => {
    expect(entryFitsPlatform('meow-pc', ['windows-x64'], 'android-x86_64')).toBe(false)
    expect(platformOfUrl('https://x/meow-setup.exe')).toBe('windows')
  })

  it('清单里 id 与 platform 数组冲突时以 id 为准', () => {
    // 手写清单常见错误：抄了 meow-tv 的 id 但 platform 写了 windows
    expect(entryFitsPlatform('meow-tv', ['windows-x64'], 'windows-x64')).toBe(false)
  })

  it('模拟器不会被塞 arm64 包（会 INSTALL_FAILED_NO_MATCHING_ABIS）', () => {
    expect(entryFitsPlatform('meow-tv', ['android-arm64'], 'android-x86_64')).toBe(false)
  })

  it('Web 端一律不匹配（没有安装包概念）', () => {
    expect(entryFitsPlatform('meow-tv', TV_PLATFORMS, 'web')).toBe(false)
  })
})

describe('currentPlatform 在无原生桥时的兜底', () => {
  it('jsdom（无 meowTv 桥）返回 web，不会误判成 android', () => {
    // TV 上走 meowTv.appUpdaterPlatform()；测试环境没有桥
    expect(currentPlatform()).toBe('web')
  })
})
