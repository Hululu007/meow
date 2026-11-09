import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 插件装好/启动后必须重新取后端地址（2026-11-02）。
 *
 * <p>实测：升级 apiserver 插件后 PC 首页一直 `Failed to fetch`，
 * 手动刷新页面才恢复。根因是 `initBackend()` 只在启动时跑一次，
 * 而且会"提前放弃"——插件没装/被禁用/启动失败时立刻返回，
 * `desktopBase` 保持空串。之后插件起来了，页面不知道。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const API = readFileSync(join(REPO, 'client/apps/web/src/api/index.ts'), 'utf8')
const SETTINGS = readFileSync(
  join(REPO, 'client/apps/web/src/views/SettingsView.vue'),
  'utf8',
)

function region(src: string, marker: string, len: number): string {
  const i = src.indexOf(marker)
  expect(i, `找不到锚点 ${marker}`).toBeGreaterThan(-1)
  return src.slice(i, i + len)
}

describe('refreshDesktopBase', () => {
  it('导出且只取一次 boot_info（不轮询，区别于 initBackend）', () => {
    expect(API).toContain('export async function refreshDesktopBase')
    const body = region(API, 'export async function refreshDesktopBase', 900)
    expect(body).toContain("tauriInvoke<BootInfo>('boot_info')")
    expect(body).toContain('desktopBase =')
    // 不该出现 while/轮询：等待是 initBackend 的职责
    expect(body).not.toContain('while (')
  })

  it('非桌面端直接返回，不报错', () => {
    const body = region(API, 'export async function refreshDesktopBase', 400)
    expect(body).toContain('if (!isTauri()) return desktopBase')
  })
})

describe('三处插件状态变化后都要刷新地址', () => {
  it('安装成功后：refreshDesktopBase 在 store.boot 之前', () => {
    const i = SETTINGS.indexOf('await installPlugin(id, appVersion.value)')
    expect(i).toBeGreaterThan(-1)
    const seg = SETTINGS.slice(i, i + 500)
    expect(seg).toContain('refreshDesktopBase')
    expect(seg.indexOf('refreshDesktopBase')).toBeLessThan(seg.indexOf('store.boot'))
  })

  it('启动插件后也要刷新（启动时可能压根没起来）', () => {
    const i = SETTINGS.indexOf('await callPluginStart(id)')
    expect(i).toBeGreaterThan(-1)
    expect(SETTINGS.slice(i, i + 400)).toContain('refreshDesktopBase')
  })

  it('停止插件后也要刷新（端口可能释放/顺延）', () => {
    const i = SETTINGS.indexOf('await callPluginStop(id)')
    expect(i).toBeGreaterThan(-1)
    expect(SETTINGS.slice(i, i + 400)).toContain('refreshDesktopBase')
  })
})
