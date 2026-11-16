import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 播放页「点画面」门禁（2026-11-16，MuMu .77 实测后加）。
 *
 * 背景：TV 壳/模拟器的 WebView 报 `pointer: coarse`，`isTouch` 恒为 true，
 * 鼠标点击也走触屏单击分支。Chrome 在 pointerup 之后、click 之前会补发一次
 * 合成 mousemove，根节点的 `@mousemove="wake"` 先把控制栏打开 →
 * click 里读到"已显示" → 220ms 后收起。表现是「点一下，控制栏闪 222ms 就没了」
 * （实测 222/223ms，鼠标与触摸都复现）。
 *
 * 这里锁两条判据，防止以后被改回去：
 *   1. click 前的可见性必须用 pointerdown 快照（pointerdown 早于合成 mousemove）
 *   2. 鼠标分支必须严格 `=== 'mouse'`（遥控器合成 click 的 pointerType 是空串）
 */
const WEB = join(__dirname, '..')
const PLAYER = readFileSync(
  join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)

/** 去掉注释，避免注释里描述"原来有这个问题"把断言骗过去。 */
function codeOnly(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('点画面：控制栏不再"闪一下就消失"', () => {
  const code = codeOnly(PLAYER)

  it('pointerdown 必须记录"点击前"的控制栏可见性', () => {
    expect(code).toContain('pressVisible = showCtrl.value')
    expect(code).toContain('pressAt = Date.now()')
  })

  it('click 前的可见性必须回退到快照，不能直接读 showCtrl', () => {
    // 旧写法（被合成 mousemove 污染）不允许复活
    expect(code).not.toContain('const wasVisible = showCtrl.value')
    expect(code).toMatch(/Date\.now\(\)\s*-\s*pressAt\s*<\s*PRESS_SNAPSHOT_MS/)
  })

  it('鼠标分支必须严格等于 mouse，且排在触屏分支之前', () => {
    expect(code).toContain("pointerType === 'mouse'")
    // 反向判据会把"空串（遥控器合成 click）/undefined（脚本派发）"当鼠标
    expect(code).not.toContain("pointerType !== 'touch'")
    const mouseAt = code.indexOf("pointerType === 'mouse'")
    const touchAt = code.indexOf('if (isTouch.value && !mouseClick)')
    expect(mouseAt).toBeGreaterThan(0)
    expect(touchAt).toBeGreaterThan(mouseAt)
  })
})
