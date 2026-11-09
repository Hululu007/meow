import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * release 端点解析**只能有一处**（前端），原生只取字节。
 *
 * ## 起因（2026-10-30，用户截图）
 *
 * PC 设置页报：`release release-v0.9.37 里没有 packages.json 资产`
 * —— 而资产明明在（实测 API 返回 4 个资产含 packages.json）。
 *
 * 真因是**双层解析**：
 *   Rust `manifest_text()` 做了「release 端点 → 拉列表 → 挑 tag →
 *   找 packages.json → 取内容」的完整解析，返回的是**清单内容**；
 *   前端 `fetchManifestText()` 拿到后又把它当 release JSON 去里面找
 *   `assets` —— 清单里当然没有 assets 字段，于是报"没有清单资产"。
 *   错误信息完全误导（看着像发版时忘了上传）。
 *
 * 同一问题在 TV 端 Java（AppUpdater.java）2026-10-29 修过一次，
 * 当时只改了 Java 没改 Rust —— 同一条规则在两个原生实现里各写一遍，
 * 漏一个就复发。这个测试锁住两端都不能做解析。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')

describe('release 端点解析只在页面层', () => {
  function bodyOf(file: string, fnName: string, span = 1400): string {
    const src = readFileSync(file, 'utf8')
    const i = src.indexOf(fnName)
    expect(i, `${file} 里找不到 ${fnName}`).toBeGreaterThan(-1)
    return src.slice(i, i + span)
  }

  it('Rust manifest_text 不做 release 解析（只单次 GET）', () => {
    const body = bodyOf(
      join(ROOT, 'client', 'apps', 'desktop', 'src-tauri', 'src', 'appupdate.rs'),
      'pub fn manifest_text',
    )
    // 关键：不能出现"把端点换成资产地址"的辅助函数调用
    expect(body, 'Rust 又在做 release 端点解析了 —— 双层解析会让前端报"没有清单资产"').not.toContain(
      'github_manifest_asset(',
    )
    // 必须真的发请求
    expect(body, 'manifest_text 没发请求').toContain('http_get')
  })

  it('Java fetchManifest 同样只做单次 GET', () => {
    const body = bodyOf(
      join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'AppUpdater.java'),
      'String fetchManifest',
    )
    expect(body, 'Java 又在做 release 端点解析了').not.toContain('resolveReleaseAsset')
    expect(body, 'Java 没发请求').toContain('httpGetText')
  })

  it('页面层是唯一解析处', () => {
    const src = readFileSync(
      join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'appUpdate.ts'),
      'utf8',
    )
    // 三个解析函数都在页面层
    expect(src).toContain('export function isReleaseEndpoint')
    expect(src).toContain('export function pickManifestRelease')
    expect(src).toContain('export function manifestAssetUrlFrom')
    // 且 fetchManifestText 里确实调用了它们
    const i = src.indexOf('async function fetchManifestText')
    const body = src.slice(i, i + 2000)
    expect(body, 'fetchManifestText 没调 pickManifestRelease').toContain('pickManifestRelease')
    expect(body, 'fetchManifestText 没调 manifestAssetUrlFrom').toContain(
      'manifestAssetUrlFrom',
    )
  })
})
