import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 焦点框 class 被框架抹掉后要能找回来（2026-11-04 用户报）。
 *
 * 现象：设置页「DNS 测试」按下后再按左键，焦点跑到最底部的「关于」。
 *
 * 根因：Vue 的 `:class` 更新会**重写整个 className**，tv-nav 加的
 * `meow-tv-focus` 被一起覆盖（按钮进入 dnsBusy 时加了 opacity-40）。
 * 下一键没有起点 → find() 退回「最后一个可聚焦元素」兜底 → 关于。
 *
 * 修法：记住 lastFocused，元素还在文档里就补回 class 继续用它当起点。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const NAV = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)

describe('焦点标记被 class 重写抹掉后自愈', () => {
  it('有 lastFocused 并在 highlight 时记录', () => {
    expect(NAV).toMatch(/var lastFocused = null/)
    expect(NAV).toContain('lastFocused = el')
  })

  it('currentFocus 会把被抹掉的 class 补回来', () => {
    expect(NAV).toMatch(/function currentFocus\(\)/)
    expect(NAV).toContain("lastFocused.classList.add('meow-tv-focus')")
    // 元素必须还在文档里才补（路由切换后旧元素已移除）
    expect(NAV).toContain('document.contains(lastFocused)')
  })

  it('按键路径都用 currentFocus 取起点（find / move / enter）', () => {
    const at = NAV.indexOf('function find(dir, includePinned, colMode)')
    expect(at).toBeGreaterThan(-1)
    expect(NAV.slice(at, at + 2200)).toContain('var marked = currentFocus()')
    expect(NAV).toMatch(/colOf\(currentFocus\(\)\)/)
    // \r?\n 而不是 \n：Windows 上 autocrlf 会把 checkout 变成 CRLF（踩过）
    expect(NAV).toMatch(/var el = currentFocus\(\)\r?\n/)
  })

  it('观察者不再把被抹掉 class 的活跃元素当成"没有焦点"', () => {
    expect(NAV).toMatch(/var okMarked = currentFocus\(\)/)
    expect(NAV).toMatch(/var keep = currentFocus\(\)/)
  })

  it('观察者立刻补回焦点标记（不等 1.2s 宽限期）', () => {
    /*
     * 补标记不移动焦点，所以不该被宽限期拦住；否则"按完 OK 焦点框消失"
     * 要等到下一次按键才恢复。
     */
    const at = NAV.indexOf('先补焦点标记')
    expect(at).toBeGreaterThan(-1)
    const body = NAV.slice(at, at + 700)
    expect(body).toContain("lastFocused.classList.add('meow-tv-focus')")
    // 必须排除"主动清焦点"的场景：滚出视口/不可见就不补
    expect(body).toContain('inViewport(lastFocused)')
    expect(body).toContain('visible(lastFocused)')
  })
})
