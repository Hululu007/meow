import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 「稍后」与内置默认更新源（2026-10-29）。
 *
 * 三条语义都是**用户能直接感知**的，写死成测试防止后续重构把行为改回去：
 *   1. 点过「稍后」的版本，静默检查不再打扰；但更高版本仍要提示
 *   2. 手动检查不受「稍后」影响（用户主动问的，不该被自己的旧选择挡住）
 *   3. 没有任何配置时也要有一个可用的更新源，否则全新安装的 TV 上
 *      「检查更新」是静默空转 —— 界面显示"已是最新版本"但一次请求都没发
 */

// localStorage 是 jsdom 提供的；每个用例前清空，避免互相污染
beforeEach(() => {
  localStorage.clear()
  vi.resetModules()
})

describe('跳过版本', () => {
  it('记住的版本被判定为跳过，其它版本不受影响', async () => {
    const { isVersionSkipped, skipVersion } = await import('@/api/appUpdate')
    expect(isVersionSkipped('0.9.99')).toBe(false)
    skipVersion('0.9.99')
    expect(isVersionSkipped('0.9.99')).toBe(true)
    // 更高版本必须放行，否则用户永远收不到更新
    expect(isVersionSkipped('0.9.100')).toBe(false)
    expect(isVersionSkipped('0.10.0')).toBe(false)
  })

  it('空版本号不算跳过（否则清单缺 version 时会静默屏蔽所有更新）', async () => {
    const { isVersionSkipped, skipVersion } = await import('@/api/appUpdate')
    skipVersion('')
    expect(isVersionSkipped('')).toBe(false)
    expect(isVersionSkipped('0.9.99')).toBe(false)
  })

  it('清掉记录后重新提示', async () => {
    const { isVersionSkipped, skipVersion, clearSkippedVersion } = await import('@/api/appUpdate')
    skipVersion('0.9.99')
    expect(isVersionSkipped('0.9.99')).toBe(true)
    clearSkippedVersion()
    expect(isVersionSkipped('0.9.99')).toBe(false)
  })
})

describe('内置默认更新源', () => {
  it('有默认值，且是 GitHub release 端点而不是裸文件名', async () => {
    const { DEFAULT_UPDATE_SOURCE } = await import('@/api/appUpdate')
    expect(DEFAULT_UPDATE_SOURCE).toMatch(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\//)
  })

  it('没配更新源时 getUpdateSource 返回内置值（不是空串）', async () => {
    const { getUpdateSource, DEFAULT_UPDATE_SOURCE } = await import('@/api/appUpdate')
    // 插件源在纯 Web / TV 上恒空（那是 Tauri 命令），所以这里必然落到内置源
    const src = await getUpdateSource()
    expect(src).toBe(DEFAULT_UPDATE_SOURCE)
  })

  it('手填的源优先于内置源', async () => {
    localStorage.setItem('meow.updateSource', 'http://127.0.0.1:8123/packages.json')
    const { getUpdateSource } = await import('@/api/appUpdate')
    expect(await getUpdateSource()).toBe('http://127.0.0.1:8123/packages.json')
  })
})

describe('版本比较（0.9.10 不能被判成比 0.9.9 小）', () => {
  it('逐位数值比较', async () => {
    const { isNewer } = await import('@/api/appUpdate')
    expect(isNewer('0.9.10', '0.9.9')).toBe(true)
    expect(isNewer('0.9.9', '0.9.10')).toBe(false)
    expect(isNewer('0.9.9', '0.9.9')).toBe(false)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
  })
})
