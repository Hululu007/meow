import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「去安装 / 去更新」的跨区跳转必须走设置页自己的导航逻辑。
 *
 * 起因（2026-11-13 用户报「竖屏点去安装，滚动定位位置不对；横屏正常」）：
 * 更新中心原来直接 `el.scrollIntoView({behavior:'smooth', block:'center'})`。
 * 竖屏设备实测（MuMu .76 / Android WebView）：
 *   - 调用确实命中了 `section[runtime]`（h=191, top=-7108）
 *   - 但 scrollY 位移 **0px** —— 带 smooth 的 scrollIntoView 被整次丢弃
 *   - 同元素去掉 smooth，立刻跳到 -6388px
 * 横屏能"看起来正常"是因为 >=1024 时右侧容器才是滚动体，走的是另一条
 * 分支；竖屏走 window 滚动，于是表现为「点了页面纹丝不动」。
 *
 * 正确的落点逻辑只有一份，在 SettingsView（容器/窗口判定、顶栏让位、
 * smooth 兜底、滚完闪框）。所以这里锁两件事：
 *   1. UpdateCenter 不许自己滚，只 emit('goto', selector)
 *   2. SettingsView 负责接住并走 jumpToEl / scrollWindowTo
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const CENTER = join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'common', 'UpdateCenter.vue')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')

describe('更新中心的跨区跳转', () => {
  const center = readFileSync(CENTER, 'utf8')
  const settings = readFileSync(SETTINGS, 'utf8')

  it('UpdateCenter 不再直接 scrollIntoView', () => {
    expect(
      /\.scrollIntoView\s*\(/.test(center),
      'UpdateCenter 又自己滚了：Android WebView 会丢弃带 smooth 的 scrollIntoView，' +
        '竖屏下点「去安装」会毫无反应。改成 emit("goto", selector)。',
    ).toBe(false)
  })

  it('UpdateCenter 用 emit("goto") 上报目标', () => {
    expect(center).toMatch(/defineEmits<\{\s*\(e: 'goto', selector: string\): void \}>/)
    expect(center).toMatch(/emit\('goto', sel\)/)
  })

  it('设置页接住 @goto 并走统一跳转', () => {
    expect(settings).toMatch(/<UpdateCenter @goto="gotoSelector" \/>/)
    expect(settings).toMatch(/async function gotoSelector\(/)
    expect(settings).toMatch(/function jumpToEl\(/)
  })

  it('window 分支有 smooth 兜底，不再是裸 scrollTo(smooth)', () => {
    // scrollWindowTo 必须做 rAF 双帧检查并补跳
    expect(settings).toMatch(/function scrollWindowTo\(/)
    expect(settings).toMatch(
      /if \(Math\.abs\(window\.scrollY - before\) < 1 && Math\.abs\(target - before\) > 2\) \{\s*window\.scrollTo\(0, target\)/,
    )
    // 分区导航的 window 分支也不许裸调
    expect(
      /window\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: 'smooth' \}\)/.test(settings),
      'scrollToSec 的 window 分支又写回了裸 smooth 调用（WebView 可能吞掉）',
    ).toBe(false)
  })
})
