/**
 * 应用内弹框门禁。
 *
 * 两件事：
 *  1. **不许再出现原生 confirm/alert** —— TV 上它会画成带
 *     「网址为 "http://meow.local" 的网页显示:」的系统弹框，遥控器也没法
 *     在取消/确定之间移动焦点（2026-11-12 用户截图）。
 *  2. 状态机的语义必须和原生一致：点确定才为真、并发调用不能把上一个
 *     await 卡死。
 *
 * 另外钉住"播放/直播页强制暗色"（setForceDark）——浅色主题下那两页的
 * 浅面板压在视频上是一块白斑。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { alertDialog, confirmDialog, dialogState, settleDialog } from '../src/composables/useConfirm'
import { applyTheme, isForceDark, setForceDark } from '../src/stores/theme'

const root = resolve(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** 去掉注释再找调用，避免把说明文字里的 `confirm()` 误判成调用 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('应用内确认弹框', () => {
  beforeEach(() => {
    // 每个用例从关闭态开始，避免上个用例的 promise 泄漏进来
    settleDialog(false)
  })

  it('点「确定」→ true，点「取消」→ false', async () => {
    const p = confirmDialog('要删除吗？', { danger: true })
    expect(dialogState.open).toBe(true)
    expect(dialogState.message).toBe('要删除吗？')
    expect(dialogState.danger).toBe(true)
    settleDialog(true)
    await expect(p).resolves.toBe(true)
    expect(dialogState.open).toBe(false)

    const p2 = confirmDialog('再来一次')
    settleDialog(false)
    await expect(p2).resolves.toBe(false)
  })

  it('并发调用：上一个按取消收尾，不会永远挂着', async () => {
    const first = confirmDialog('第一问')
    const second = confirmDialog('第二问')
    await expect(first).resolves.toBe(false)
    settleDialog(true)
    await expect(second).resolves.toBe(true)
  })

  it('alert 只有确定按钮（Esc 也按 false 收尾，但调用方不看返回值）', async () => {
    const p = alertDialog('安装失败')
    expect(dialogState.kind).toBe('alert')
    expect(dialogState.cancelText).toBe('')
    settleDialog(true)
    await expect(p).resolves.toBe(true)
  })

  it('全仓不再调用原生 confirm / alert', () => {
    const offenders: string[] = []
    for (const f of walk(root)) {
      if (f.endsWith('useConfirm.ts')) continue
      const code = stripComments(readFileSync(f, 'utf8'))
      if (/(^|[^.\w])confirm\s*\(/.test(code) || /(^|[^.\w])alert\s*\(/.test(code)) {
        offenders.push(f.replace(root, 'src'))
      }
    }
    expect(offenders, '原生弹框会绕过主题与遥控焦点').toEqual([])
  })

  it('App.vue 挂载了 ConfirmDialog', () => {
    const app = readFileSync(resolve(root, 'App.vue'), 'utf8')
    expect(app).toContain("import ConfirmDialog from '@/components/common/ConfirmDialog.vue'")
    expect(app).toContain('<ConfirmDialog />')
  })
})

describe('全屏播放 / 直播页强制暗色', () => {
  it('setForceDark(true) 后：即使主题是浅色，data-mode 也必须是 dark', () => {
    applyTheme('meow', 'light')
    expect(document.documentElement.dataset.mode).toBe('light')

    setForceDark(true)
    expect(isForceDark()).toBe(true)
    expect(document.documentElement.dataset.mode).toBe('dark')

    // 退出后立刻恢复用户的选择（这里直接再 apply 一次验证短路已解除）
    setForceDark(false)
    applyTheme('meow', 'light')
    expect(document.documentElement.dataset.mode).toBe('light')
  })

  it('App.vue 按路由（play / live）切换强制暗色', () => {
    const app = readFileSync(resolve(root, 'App.vue'), 'utf8')
    expect(app).toMatch(/watch\(\s*\[isPlay, isLive\][\s\S]{0,200}setForceDark\(p \|\| l\)/)
  })
})
