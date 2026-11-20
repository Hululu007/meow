import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「后端插件 ⇄ 手填地址」切换的回归门禁（2026-11-20 用户报）。
 *
 * 现场：关掉「影视后端」插件 → 扫描到局域网 192.168.1.20:30010 → 点结果填入
 * 地址框 → 点「重连后端」→ 报无连接；而且输入框当时是只读的，根本没有保存按钮。
 *
 * 四条根因（每条都锁一个断言，回退就会重新出现）：
 *   1. 插件托管时输入框 `:readonly` + 隐藏「保存」→ 扫描结果无法落盘；
 *   2. 「保存」和「重连」是两个按钮，重连不读输入框 → 用了旧 base；
 *   3. `refreshDesktopBase()` 在 backend_base 变 null 时不清 desktopBase
 *      → 停掉插件后仍 ping 已关闭的端口；
 *   4. 启动后端插件不清手填地址 → resolveBase 仍优先旧的外部地址。
 */
const ROOT = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

describe('桌面端：后端地址与插件的切换', () => {
  const settings = read('src/views/SettingsView.vue')
  const api = read('src/api/index.ts')

  it('插件托管时地址输入框仍可编辑（不能 readonly）', () => {
    const input = settings.slice(
      settings.indexOf('v-model="apiUrl"') - 200,
      settings.indexOf('v-model="apiUrl"') + 600,
    )
    expect(input, '地址输入框又变成只读了，扫描到的地址存不下来').not.toContain(
      ':readonly="apiManagedByPlugin"',
    )
  })

  it('保存与重连是同一个动作，且会先探活再刷新', () => {
    expect(settings).toContain('async function saveAndReconnect')
    expect(settings, '缺少保存前探活，死地址会连扫描结果一起刷掉').toContain(
      'probeBackendHealth',
    )
    // 只改地址才整页刷新；地址没变只重连
    expect(settings).toContain('const unchanged = url === (manualApi.value || \'\')')
  })

  it('插件托管且地址没改时不写入手填地址（否则会变成"手连本机"）', () => {
    expect(settings).toContain(
      'const keepPlugin = desktop && !manualApi.value && (!url || url === apiBase())',
    )
  })

  it('停止插件后刷新会清掉陈旧 base（backend_base 为 null）', () => {
    expect(api, 'refreshDesktopBase 没清空 desktopBase').toContain(
      "desktopBase = b ? String(b).replace(/\\/$/, '') : ''",
    )
  })

  it('启动/启用后端插件时清掉手填的外部地址', () => {
    expect(settings).toContain('function clearManualApiForPlugin')
    // startPlugin 与 toggleEnabled 两条入口都要清
    const start = settings.slice(settings.indexOf('async function startPlugin'))
    expect(start.slice(0, 900)).toContain('clearManualApiForPlugin()')
    const toggle = settings.slice(settings.indexOf('async function toggleEnabled'))
    expect(toggle.slice(0, 900)).toContain('clearManualApiForPlugin()')
  })

  it('「启动」会把"随应用启动"落盘，避免开关显示与实际不一致', () => {
    const start = settings.slice(settings.indexOf('async function startPlugin'))
    expect(start.slice(0, 600)).toContain('await setPluginEnabled(p.id, true)')
  })

  it('插件在跑时保存回环地址先提示（否则地址换了、实际仍连插件）', () => {
    expect(settings).toContain('pluginBase() && pluginBase() !== url')
    expect(api).toContain('export function pluginBase()')
  })

  it('顶栏未连接时能区分"插件被停"与"等待启动"', () => {
    expect(settings).toContain('const offlineHint = computed')
    expect(settings).toContain("if (p.phase === 'stopped') return '本机后端已停止'")
    expect(settings, '顶栏又写死"等待插件启动"').not.toContain(
      '<template v-else-if="desktop">等待插件启动</template>',
    )
  })
})

describe('PC 局域网扫描是弹框（对齐 TV 连接弹层）', () => {
  const settings = read('src/views/SettingsView.vue')

  it('有独立弹框状态与开关函数', () => {
    expect(settings).toContain('function openWebScanDialog')
    expect(settings).toContain('function closeWebScanDialog')
    expect(settings).toContain('v-if="webScan.open"')
  })

  it('弹框 Teleport 到 body（否则被顶栏 z-30 压住）', () => {
    const at = settings.indexOf('v-if="webScan.open"')
    const block = settings.slice(at - 800, at + 200)
    expect(block).toContain('<Teleport to="body">')
  })

  it('扫描结果在弹框里选中并保存，不再铺在设置页', () => {
    expect(settings).toContain('function saveWebScan')
    // 旧的页面内胶囊列表（v-if="webScan.found.length" 的 inline 块）已删除
    expect(settings).not.toContain('<div v-if="webScan.found.length" class="mt-2 flex flex-wrap gap-2">')
  })
})
