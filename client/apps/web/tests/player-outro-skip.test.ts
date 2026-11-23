import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 片尾跳过不再"先定位到最后一秒再跳"（2026-11-23 用户实报）。
 *
 * ended 语义不依赖真实播放位置；把 currentTime 拉到 duration-1 只是为了
 * 画面停在末尾，代价是一次突兀跳转。现在直接发 ended，进度按"已看完"
 * 用 pos=duration 上报（父组件 flushToHistory 会清掉续播点）。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const V = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)

describe('跳片尾不跳最后一秒', () => {
  it('跳过片尾直接 ended + 以 duration 上报最终进度', () => {
    const i = V.indexOf('function skipOutroNow')
    const body = V.slice(i, i + 900)
    expect(body).toContain("emit('ended')")
    // 关键：不再 seek 到 duration-1
    expect(body).not.toContain('duration.value - 1')
    expect(body).toContain('flushProgress(true, true, duration.value')
  })

  it('ended 之后的 5 秒心跳不再写进度（否则续播点又被写回片尾）', () => {
    const i = V.indexOf('function flushProgress')
    const body = V.slice(i, i + 500)
    expect(body).toContain('endedSent && !final')
  })

  it('flushProgress 支持位置覆盖', () => {
    expect(V).toContain('function flushProgress(final = false, force = false, posOverride?: number)')
    expect(V).toContain('posOverride ?? v.currentTime')
  })
})
