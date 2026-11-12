import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PC「本机插件 → 导入本地包」必须是原生文件选择器，不能退回 window.prompt。
 *
 * ## 起因（用户截图反馈，2026-11-12）
 *
 * > "pc应用导入本地包插件，功能是可用的吗？为什么还是原生ui对话框"
 *
 * 截图里弹的是 WebView 自带的 `prompt()`：`tauri.localhost 显示 — 输入插件包
 * （zip）的完整路径：`。也就是说用户在被告知要**手打绝对路径**——这不是设计，
 * 是兜底路径被当成主路径了。
 *
 * ## 根因（三件都缺，缺一件就退回 prompt）
 *
 * 1. `Cargo.toml` 没有 `tauri-plugin-dialog` 依赖 —— 二进制里没有这个插件；
 * 2. `lib.rs` 的 builder 没有 `.plugin(tauri_plugin_dialog::init())` —— 装了也
 *    没注册到 Tauri 的调用表；
 * 3. 没有 `capabilities/` —— Tauri v2 的 ACL 里没给 `dialog:default` 权限，
 *    命令被拒。
 *
 * 前端 `tauriPickFile()` 里 `try { invoke('plugin:dialog|open') } catch { prompt() }`
 * 把三种失败全吞成同一个兜底，所以界面表现一模一样，掩盖了真实原因。
 *
 * ## 为什么写源码/文件断言
 *
 * 跑真实对话框需要 Windows GUI 主线程 + 弹模态框让人点，CI 里做不到。这三条
 * 都是**静态可判**的接线约束，改坏了立刻红即可。与 `pc-command-nonblocking.test.ts`
 * 同一个套路。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const TAURI = join(ROOT, 'client', 'apps', 'desktop', 'src-tauri')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('PC 插件导入用原生文件选择器', () => {
  it('Cargo.toml 声明了 tauri-plugin-dialog', () => {
    const c = read(join(TAURI, 'Cargo.toml'))
    expect(c).toMatch(/tauri-plugin-dialog\s*=\s*"\^?2/)
  })

  it('lib.rs 注册了 dialog 插件（且在有 invoke_handler 的 builder 链上）', () => {
    const l = read(join(TAURI, 'src', 'lib.rs'))
    expect(l).toContain('tauri_plugin_dialog::init()')
    // 必须在 Builder 链里注册，写在注释或别的函数里都不算
    expect(l).toMatch(/tauri::Builder::default\(\)[\s\S]{0,400}?\.plugin\(tauri_plugin_dialog::init\(\)\)/)
    // 注册位置要在 setup 之前（Tauri 要求 plugin 在 setup 前挂载）
    const pluginAt = l.indexOf('.plugin(tauri_plugin_dialog::init())')
    const setupAt = l.indexOf('.setup(|app| {')
    expect(pluginAt).toBeGreaterThan(0)
    expect(setupAt).toBeGreaterThan(pluginAt)
  })

  it('capabilities 给了 dialog:default 且覆盖主窗口', () => {
    const dir = join(TAURI, 'capabilities')
    expect(existsSync(dir)).toBe(true)
    const cap = read(join(dir, 'default.json'))
    const j = JSON.parse(cap) as { windows?: string[]; permissions?: string[] }
    expect(j.windows).toContain('main')
    expect(j.permissions).toContain('dialog:default')
    // core:default 不能丢：新增 capabilities 会把 ACL 从"无配置"变成"按配置"
    expect(j.permissions).toContain('core:default')
  })

  it('前端调用 plugin:dialog|open 并限定 zip，带标题', () => {
    const s = read(SETTINGS)
    expect(s).toContain("invoke('plugin:dialog|open'")
    expect(s).toContain("extensions: ['zip']")
    expect(s).toContain("title: '选择插件包")
  })

  it('保留 prompt 兜底（浏览器调试 / 老版本），但只在 dialog 调不通时', () => {
    const s = read(SETTINGS)
    const i = s.indexOf("invoke('plugin:dialog|open'")
    const j = s.indexOf('prompt(', i)
    expect(j).toBeGreaterThan(i)
    // 兜底提示要说清是"填写完整路径"，不能是含糊的"输入路径"
    expect(s).toContain('完整路径')
  })

  it('导入链路的后端实现仍在（前端能选到文件后必须真的能装）', () => {
    const l = read(join(TAURI, 'src', 'lib.rs'))
    const inst = read(join(TAURI, 'src', 'installer.rs'))
    expect(l).toContain('fn plugin_import')
    expect(l).toContain('plugin_import,')
    expect(inst).toContain('pub fn import_zip')
    // 装完要自动起插件，否则用户以为没生效
    expect(l).toMatch(/plugin_import[\s\S]{0,1200}?mgr\.start/)
  })
})
