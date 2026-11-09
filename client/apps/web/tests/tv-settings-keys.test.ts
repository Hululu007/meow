import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页的返回键 / 菜单键语义（2026-10-30 用户需求）。
 *
 * 原话：「在右侧内容区按返回（其他位置同两次退出app）、菜单键时，
 * 聚焦到左侧菜单栏首位」。
 *
 * 为什么不能靠"页面自己监听 keydown"：壳的返回键走 `onBackPressed`
 * → `__meowTvConsumeBack`，菜单键走 `dispatchKeyEvent` → `__meowTvMenu()`，
 * **两条路都不派发 keydown 给页面**。所以只能靠约定好的函数钩子。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const APP = join(ROOT, 'client', 'apps', 'web', 'src', 'App.vue')
const TV_MENU = join(ROOT, 'client', 'apps', 'web', 'src', 'stores', 'tvMenu.ts')
const NAV = join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('设置页遥控键语义', () => {
  it('左导航有可识别的锚点', () => {
    expect(read(SETTINGS), '缺 data-tv-settings-nav 锚点').toContain('data-tv-settings-nav')
  })

  it('返回键钩子存在且只在内容区吃掉', () => {
    const s = read(SETTINGS)
    expect(s, '缺 handleTvBackHere').toContain('function handleTvBackHere')
    // 判据必须是"焦点在内容区"——在左导航/顶栏时要放行原来的两段退出语义
    const i = s.indexOf('function handleTvBackHere')
    expect(s.slice(i, i + 220), '没判 focusIsInContent').toContain('focusIsInContent')
  })

  it('菜单键钩子存在，且同样判内容区', () => {
    const s = read(SETTINGS)
    expect(s, '缺 handleTvMenuHere').toContain('function handleTvMenuHere')
    const i = s.indexOf('function handleTvMenuHere')
    expect(s.slice(i, i + 220), '没判 focusIsInContent').toContain('focusIsInContent')
  })

  it('两个钩子在 onMounted 挂、onBeforeUnmount 清', () => {
    /*
     * 不清的后果：离开设置页后，别的页面按返回也会被"送回设置页左导航"，
     * 而那个元素已经不存在 —— 表现为返回键彻底失灵。
     */
    const s = read(SETTINGS)
    expect(s).toContain('__meowTvPageBack')
    expect(s).toContain('__meowTvMenuHook')
    // 从"最后一次出现 onBeforeUnmount（函数定义处）"往后找，避开 import 行
    const un = s.lastIndexOf('onBeforeUnmount(')
    expect(un, '找不到 onBeforeUnmount 定义').toBeGreaterThan(-1)
    expect(s.slice(un, un + 700), '卸载时没清钩子').toContain('__meowTvPageBack = undefined')
  })

  it('App.vue 在路由判断之前问页面钩子', () => {
    const a = read(APP)
    // 用"函数体里的实际调用"定位：注释里也提到这个变量名
    const hook = a.indexOf('const pageBack = (window as unknown as { __meowTvPageBack')
    // 用 lastIndexOf：isHomeRoute 在文件里出现多次（定义 + 各处调用）
    const home = a.lastIndexOf('if (!isHomeRoute()) return false')
    expect(hook, '缺页面钩子调用').toBeGreaterThan(-1)
    expect(home, '找不到路由判断').toBeGreaterThan(-1)
    expect(hook, '钩子在路由判断之后，非首页永远走不到').toBeLessThan(home)
  })

  it('tvMenu 的桥在 provider 之前问钩子', () => {
    const m = read(TV_MENU)
    const hook = m.indexOf('__meowTvMenuHook')
    expect(hook, 'tvMenu 没接钩子').toBeGreaterThan(-1)
    const i = m.indexOf('export function openTvMenuFor')
    expect(m.slice(i, i + 500)).toContain('__meowTvMenuHook')
  })

  it('tv-nav 暴露了 __meowTvFocus（按元素设焦点，不手改 class）', () => {
    // 手加 .meow-tv-focus 会留下两份 class 或让 tv-nav 的 current 索引错位
    expect(read(NAV), '缺 __meowTvFocus').toContain('window.__meowTvFocus')
  })
})
