import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页「直播源」区块的可运维能力。
 *
 * 起因（2026-11-06 用户连问）：
 *   · 「过期后，我们能在设置页删除或更新吗」—— 当时只有删除，改名/换地址都要
 *     "先删再加"两步
 *   · 「这俩源如果更新了，怎么确定啊」—— 界面上完全看不到源的新鲜度，而
 *     内置的 Guovin 实际已经停更 25 天（Last-Modified 10-12），名字还叫
 *     "每日更新"
 *   · 「内置的能删除不用吗」—— 能删，但删错后没有恢复入口，只能手输 CDN 地址
 *
 * 这条门禁锁住四件事：编辑、测试（台数+新鲜度）、恢复内置源、后端透传 Last-Modified。
 * 只做字符串存在性检查，语义靠实机冒烟。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const API = join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'index.ts')
const SERVER = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')

describe('设置页直播源：编辑 / 测试 / 恢复内置', () => {
  const S = readFileSync(SETTINGS, 'utf8')
  const A = readFileSync(API, 'utf8')
  const J = readFileSync(SERVER, 'utf8')

  it('可以改名和换地址（换地址 = 先加新的再删旧的）', () => {
    expect(S, '缺少编辑入口').toContain('function startEditLive')
    expect(S, '缺少保存逻辑').toContain('function saveEditLive')
    // 先 POST 新地址、成功后才 DELETE 旧地址 —— 中间失败不能先丢旧源
    expect(S, '换地址没走"先加后删"').toMatch(
      /const changed = url !== oldUrl[\s\S]{0,600}if \(changed\) await removeLiveSource\(oldUrl\)/,
    )
    // 换地址要校验（改名不校验）
    expect(S, '换地址没做校验').toMatch(/addLiveSource\(\{[\s\S]{0,160}verify: changed/)
  })

  it('可以测试一条源：台数 + 更新于几天前（超 7 天提示停更）', () => {
    expect(S, '缺少测试入口').toContain('function testLive')
    expect(S, '测试没读 updated').toMatch(/r\.updated[\s\S]{0,260}days/)
    expect(S, '没有停更提示').toContain('已停更')
    // 不在打开页面时自动测（208KB 要 6 秒）
    expect(S, '测试按钮应手动触发').toMatch(/@click="testLive\(l\.url\)"/)
  })

  it('内置源删除后可一键恢复（不用手输 CDN 地址）', () => {
    expect(S, '缺少恢复函数').toContain('function doResetBuiltin')
    expect(S, '恢复按钮没按"有内置被删"显示').toContain('canResetBuiltin')
    expect(S, '恢复按钮没接处理函数').toMatch(/@click="doResetBuiltin"/)
    expect(A, '缺少 resetBuiltinLives API').toContain('resetBuiltinLives')
    // 后端分支：清掉 builtinLiveOff
    expect(J, '后端没有 resetBuiltin 分支').toContain('resetBuiltin')
    expect(J, '没有清 builtinLiveOff').toMatch(/saved\.remove\("builtinLiveOff"\)/)
  })

  it('后端透传 Last-Modified 给前端算新鲜度', () => {
    expect(J, '没读 Last-Modified').toMatch(/getHeaderField\("Last-Modified"\)/)
    expect(J, '响应里没带 updated').toMatch(/out\.put\("updated"/)
    expect(A, '前端类型缺 updated').toMatch(/updated\?: string/)
  })
})
