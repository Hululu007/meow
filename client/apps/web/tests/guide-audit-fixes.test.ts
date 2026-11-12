import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 2026-11-12 指南核验挖出的 4 个产品/发版侧缺口的回归门禁。
 *
 * 背景：文档核验发现「文档写了但产品没做到」的地方，改文档治不了根。
 * 这四条都已修，这里锁住修法，防止回退。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

describe('① 官方清单：插件条目必须可见', () => {
  it('sync-packages 对插件条目强制 hidden=false（应用安装包保持 true）', () => {
    const ps = read('deploy', 'scripts', 'sync-packages.ps1')
    // 插件循环里必须有这行；反向确认它不是靠"沿用旧值"（旧值全是 true）
    expect(ps).toContain('$entry.hidden = $false')
    const pluginBlockAt = ps.indexOf('$entry.hidden = $false')
    const pluginLoopAt = ps.indexOf('foreach ($pid2 in $pluginIds)')
    expect(pluginLoopAt).toBeGreaterThan(-1)
    expect(pluginBlockAt).toBeGreaterThan(pluginLoopAt)
    // 应用安装包条目仍然是 hidden=true（New-Entry 默认）
    expect(ps).toMatch(/hidden\s*=\s*\$true/)
  })

  it('全量发版构建全部插件（不是只有 apiserver）', () => {
    const rel = read('.github', 'workflows', 'release.yml')
    const line = rel.split(String.fromCharCode(10)).find((l) => l.includes('release-v[0-9]*)'))
    expect(line, '找不到 release-v* 的 scope 行').toBeTruthy()
    // 留空 = 全部（见 _plugins.yml 的 inputs 说明）
    expect(line).toContain("plugins_only ''")
    expect(line).not.toContain('plugins_only apiserver')
  })

  it('前端只列本机能装的插件（tv-node 是 android 包，别混进 PC 列表）', () => {
    const sv = read('client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
    const at = sv.indexOf('const availablePlugins')
    const block = sv.slice(at, at + 900)
    expect(block).toContain("e.platform.includes('windows-x64')")
  })
})

describe('② PC 后端默认只绑本机', () => {
  it('apiserver manifest 注入 MEOW_BIND=127.0.0.1', () => {
    const m = read('server', 'plugin-manifests', 'apiserver.manifest.json')
    expect(m).toContain('"MEOW_BIND": "127.0.0.1"')
    const j = JSON.parse(m)
    expect(j.env?.MEOW_BIND).toBe('127.0.0.1')
  })
})

describe('④ 播放页文案与实现一致', () => {
  it('不再写「Web 端暂不支持」parse', () => {
    const pv = read('client', 'apps', 'web', 'src', 'views', 'PlayView.vue')
    expect(pv, '陈旧文案又回来了').not.toContain('Web 端暂不支持')
    // 实际解析实现仍在（免得连实现一起删掉）
    expect(pv).toContain('fetchParse(')
  })
})

describe('⑤ 窄屏入口补齐', () => {
  it('播放页「更多」菜单里有上/下一集（底栏按钮 <768 隐藏）', () => {
    const vp = read('client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue')
    const menuAt = vp.indexOf('<div class="md:hidden">')
    expect(menuAt).toBeGreaterThan(-1)
    const menu = vp.slice(menuAt, menuAt + 2600)
    expect(menu).toContain('@click="goPrev"')
    expect(menu).toContain('@click="goNext"')
    expect(menu).toContain('上一集')
    expect(menu).toContain('下一集')
  })

  it('直播线路按钮在手机上可见（否则 <640 无法切线路）', () => {
    const lv = read('client', 'apps', 'web', 'src', 'views', 'LiveView.vue')
    const at = lv.indexOf('@click.stop="cycleLine(1)"')
    expect(at).toBeGreaterThan(-1)
    const cls = lv.slice(Math.max(0, at - 500), at)
    const m = cls.match(/class="([^"]+)"/)
    expect(m, '找不到线路按钮的 class').toBeTruthy()
    expect(m![1]).not.toContain('hidden')
    expect(m![1]).toMatch(/\bflex\b/)
  })
})
