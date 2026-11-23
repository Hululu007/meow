import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 播放途中「缓冲卡死」自愈门禁（2026-11-23 用户实报）。
 *
 * 现象：同一集某一段缓冲很好、某一段直接不动，面板显示 bufferStalledError；
 * 这不是网络抖动，是播放点落进了缓冲区空洞（hls.js 只处理 0.5s 以内），
 * 或者源端/转码断流。三条保证缺一条就会退回「无限转圈」：
 *   1. 非致命 bufferStalledError 要主动跳洞；
 *   2. 播放中要有进度看门狗（currentTime 长期不动 → 跳洞/重拉/报 stall）；
 *   3. bufferStalled 归 stall（换线），绝不能归 media（会白等转码）。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const V = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)

describe('缓冲卡死自愈', () => {
  it('bufferStalledError 主动跳洞（≤10s 的洞），跳不动再交给看门狗', () => {
    expect(V).toContain('function tryNudgeOverHole')
    expect(V).toContain("data.details === 'bufferStalledError'")
    // 洞太大不跳：交给换线
    expect(V).toContain('gap > 10')
  })

  it('播放中有进度看门狗，不是只有起播看门狗', () => {
    expect(V).toContain('function armProgressWatchdog')
    expect(V).toContain('armProgressWatchdog()')
    expect(V).toContain('clearProgressWatchdog()')
    expect(V).toContain("failPlay('播放卡住了")
  })

  it('bufferStalled 归类为 stall（换线），不是 media（转码）', () => {
    const fn = V.slice(V.indexOf('function classifyHlsDetail'), V.indexOf('function failPlay'))
    const stallAt = fn.indexOf("return 'stall'")
    const mediaAt = fn.indexOf("return 'media'")
    expect(stallAt).toBeGreaterThan(-1)
    expect(mediaAt).toBeGreaterThan(-1)
    expect(stallAt).toBeLessThan(mediaAt)
    // media 分支不能再包含 bufferstalled
    const mediaLine = fn.slice(fn.lastIndexOf('if (', mediaAt), mediaAt)
    expect(mediaLine).not.toContain('bufferstalled')
  })
})
