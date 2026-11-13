/**
 * 源导入输入框预填（2026-11-12）。
 *
 * 需求：源导入框默认显示一个可用示例地址，但**不自动导入**——用户仍要
 * 自己点「读取并预览」。另外 TV 连接设置弹层不能在用户没改过输入框时
 * 被这个默认值带着走（否则保存连接等于悄悄导入了示例源）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const view = readFileSync(join(SRC, 'views', 'SettingsView.vue'), 'utf8')

describe('源导入输入框', () => {
  it('默认值是 http://肥猫.net，且两处输入框都标记了"用户改过"', () => {
    expect(view).toContain("const cfgUrl = ref('http://肥猫.net')")
    // 本机执行 + 搜索与源，两个输入框共用 cfgUrl（都走 onCfgUrlInput：置脏 + 作废旧预览）
    expect(view.match(/@input="onCfgUrlInput"/g)?.length).toBe(2)
  })

  /**
   * 「确认导入」优先用 cfgPreview.url，所以地址一改旧面板必须作废。
   * 否则用户改了地址、看着旧面板点确认，导入的还是旧地址（实测路径）。
   */
  it('地址改了立刻作废旧预览，防止"看着 A 的面板导入 B"', () => {
    expect(view).toContain('if (p && cfgUrl.value.trim() !== p.url) cfgPreview.value = null')
  })

  it('连接设置弹层只在用户改过之后才沿用输入框内容', () => {
    expect(view).toContain('connDialog.config = s.config || (cfgUrlDirty.value ? cfgUrl.value : \'\')')
    expect(view).toContain('connDialog.config = cfgUrlDirty.value ? cfgUrl.value : \'\'')
  })

  it('不自动导入：启动路径里没有 importConfig 调用', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8')
    expect(main).not.toContain('importConfig')
    expect(main).not.toContain('肥猫.net')
  })
})
