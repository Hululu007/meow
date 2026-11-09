import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「弹幕一顿一顿」的回归门禁（2026-11-04 用户报）。
 *
 * 现象：播不到一分钟弹幕就开始一顿一顿（PC / TV 都有），画面本身没停。
 *
 * 根因：`stalled` 是**网络层**事件 —— 它只说明这一刻没收到网络数据，
 * 画面往往还在用已缓冲的垫子正常播。但缓冲冻结逻辑把它和 `waiting`
 * 一起接进了 onBufferStart：
 *
 *   stalled → dm.pause() → running=false
 *   tick 不再推进（每帧插值停了），只剩 timeupdate 里的 sync 在重画
 *   → 弹幕退化成 4Hz，每 250ms 挪一下
 *
 * 而恢复只挂在 `playing` / `canplay` 上 —— 画面没停就不会派发这两个事件，
 * 引擎于是永久冻住（顺带把转圈浮层也点亮后再也关不掉）。
 *
 * 两条修法都必须保留：
 *   1. `stalled` 不再参与冻结
 *   2. 解冻判据落在「画面时间真的往前走了」上（timeupdate 自愈）
 */
const PLAYER = readFileSync(
  resolve(__dirname, '../src/components/player/VideoPlayer.vue'),
  'utf8',
)

/** 只留代码行，去掉注释（注释里会写 `stalled` 等字样） */
function codeOnly(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CODE = codeOnly(PLAYER)

describe('缓冲冻结不能把弹幕引擎冻死', () => {
  it('stalled 不再冻结引擎（网络层事件，画面可能还在播）', () => {
    expect(CODE).not.toMatch(/addEventListener\(\s*'stalled'/)
    // 也不该让它点亮转圈（旧代码会点亮后永远不关）
    expect(CODE).not.toContain("'stalled'")
  })

  it('waiting 仍然冻结（这才是"画面真的停了"）', () => {
    expect(CODE).toContain("addEventListener('waiting', onBufferStart)")
    const i = CODE.indexOf('const onBufferStart')
    expect(i).toBeGreaterThan(-1)
    const body = CODE.slice(i, i + 500)
    expect(body).toContain('freezeDanmakuForBuffer()')
  })

  it('冻结/解冻是一对，且带来源标志（不能把用户主动暂停也放开）', () => {
    expect(CODE).toContain('let dmFrozenForBuffer = false')
    expect(CODE).toContain('function freezeDanmakuForBuffer()')
    expect(CODE).toContain('function thawDanmakuFromBuffer()')
    const i = CODE.indexOf('function thawDanmakuFromBuffer')
    const body = CODE.slice(i, i + 700)
    expect(body).toContain('if (!dmFrozenForBuffer) return')
    expect(body).toMatch(/dm\.value\?\.start\(\)/)
    expect(body).toMatch(/dm\.value\?\.sync\(vv\.currentTime\)/)
  })

  it('解冻判据是「画面时间往前走了」，不等 playing/canplay', () => {
    const i = CODE.indexOf('function onTimeUpdate')
    expect(i).toBeGreaterThan(-1)
    const body = CODE.slice(i, i + 2600)
    // 时间点真的推进才解冻：缓冲期间 currentTime 不动，恢复后第一帧就满足
    expect(body).toMatch(/dmFrozenForBuffer && !v\.seeking && v\.currentTime > dmFrozenAt \+ 0\.05/)
    expect(body).toContain('thawDanmakuFromBuffer()')
    // 自愈必须同时把转圈关掉，否则浮层一直盖在画面上
    expect(body).toContain('buffering.value = false')
  })

  it('换源复位状态（否则旧时间点会让新源一进来就白解冻一次）', () => {
    const i = CODE.indexOf('function setupSource')
    const body = CODE.slice(i, i + 900)
    expect(body).toContain('dmFrozenForBuffer = false')
  })
})
