import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 电视焦点框的两个"看起来像 bug"的症状（2026-11-11 用户截图报障）：
 *
 * ① 「圆环被切割显示不全」——国家网格在自己的 `overflow-y-auto` 容器里，
 *    tv-nav 的环是**外扩**的（2px accent + 12px 辉光），贴边那一行必被裁。
 *    解法和弹层一样：容器标 `data-tv-inset-focus`，环改成内描边。
 *
 * ② 「第一个一直有边框，已经聚焦到别处了」——那不是 tv-nav 的环，是元素的
 *    **DOM 焦点**触发的浏览器自带 :focus-visible 轮廓（灰白色、不跟随主题）。
 *    tv-nav 只搬 class 不 focus()，但点击/页面 focus()/无障碍焦点仍可能给
 *    某个按钮真实焦点，UA 环就一直留着。电视上要把按钮类的 UA 环关掉。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const NAV = readFileSync(
  join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)
const TOKENS = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'styles', 'tokens.css'), 'utf8')
const SETTINGS = readFileSync(
  join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
  'utf8',
)

describe('电视焦点框：内描边 + 关掉 UA 轮廓', () => {
  it('密集网格用内描边环（避免被滚动容器裁切）', () => {
    expect(NAV, 'tv-nav 缺内描边规则').toContain('[data-tv-inset-focus] .meow-tv-focus')
    expect(SETTINGS, '国家网格没标 data-tv-inset-focus').toContain('data-tv-inset-focus')
  })

  it('电视上按钮/链接不画浏览器自带的焦点轮廓', () => {
    expect(TOKENS, '缺电视端 UA 轮廓复位').toMatch(
      /html\[data-tv='1'\] button:focus[\s\S]{0,200}outline: none !important/,
    )
    // 输入框必须留着：打字要有焦点反馈
    expect(TOKENS).not.toMatch(/html\[data-tv='1'\] input:focus[^{]*\{\s*outline: none/)
  })
})
