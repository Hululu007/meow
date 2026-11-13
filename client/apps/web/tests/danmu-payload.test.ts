/**
 * 弹幕载荷（danmu_api）独立成资产的门禁。
 *
 * <p>背景：载荷原来是打在 TV 壳 APK 的 assets 里的（10.9MB），danmu 一更新就得发整个壳；
 * 现在它与运行时模块分开：清单里 `danmu-payload`（platform=android）、设置页单独一块、
 * NodeService 优先用下载目录、assets 只做兼容兜底。
 *
 * <p>这里用源码断言锁住几个"改回去就会静默失效"的点：
 *  - 清单条目 id / 平台，丢了 TV 就永远装不上载荷；
 *  - 设置页的灰态（模块没装不许点）；
 *  - NodeService 的解析顺序（下载目录优先、assets 兜底）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 与 cursor-idle.test.ts 同款：从 tests/ 往上四级才是仓库根
const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('弹幕载荷独立资产', () => {
  it('清单里有 danmu-payload 条目（android 平台）', () => {
    const src = read('deploy/scripts/sync-packages.ps1')
    expect(src).toContain("danmu-payload")
    expect(src).toMatch(/New-Entry \$dmAsset \$pver @\('android'\)/)
  })

  it('载荷与 PC 插件同一个 zip（不重复 10MB）', () => {
    const src = read('deploy/scripts/sync-packages.ps1')
    // 载荷条目必须由 danmu-api 的资产派生，而不是另找文件
    expect(src).toMatch(/Find-Asset 'danmu-api-\*\.zip'/)
  })

  it('设置页有独立一块，且模块未安装时不可点', () => {
    const src = read('client/apps/web/src/views/SettingsView.vue')
    expect(src).toContain('data-danmu-payload')
    expect(src).toMatch(/:disabled="!modState\.installed \|\| payBusy"/)
    expect(src).toContain('需先安装运行时模块')
  })

  it('更新中心有只读行并跳到运行时分区', () => {
    const src = read('client/apps/web/src/components/common/UpdateCenter.vue')
    expect(src).toContain('data-update-row="payload"')
    expect(src).toContain("scrollTo('[data-danmu-payload]')")
  })

  it('NodeService 先用下载目录、再回 assets', () => {
    const src = read(
      'client/apps/tv/app/src/main/java/com/meow/tv/runtime/NodeService.java',
    )
    const downloaded = src.indexOf('RuntimePayloadHost.currentDir')
    const assets = src.indexOf('unpackZip("node-payload-danmu.zip"')
    expect(downloaded).toBeGreaterThan(-1)
    expect(assets).toBeGreaterThan(downloaded)
  })

  it('store 有载荷检查（未安装时直接返回，不发网络请求）', () => {
    const src = read('client/apps/web/src/stores/updateCenter.ts')
    expect(src).toContain('export async function checkPayload')
    expect(src).toMatch(/if \(!payloadInstalled\.value\)/)
  })

  it('payloadDownload 的返回值不是 JSON（"已开始下载"）也要能继续', () => {
    const src = read('client/apps/web/src/views/SettingsView.vue')
    // AppUpdater.start 成功/失败都返回人话；页面必须容错，否则整个下载流程中断
    // （2026-11-13 .77 实测：日志 ready 了但 payloadApply 从没被调用）
    expect(src).toContain('已开始下载')
    expect(src).toMatch(/try \{\s*const o = JSON\.parse\(rawStart\)/)
  })
})
