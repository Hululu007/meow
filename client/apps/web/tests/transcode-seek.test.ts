import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  seekOutsideProduced,
  transcodeRestartStart,
  fmtSeekClock,
  TRANSCODE_SEEK_BACK,
} from '../src/utils/transcodeSeek'

/**
 * 片库/点播转码的 seek 边界（issue #17 的验收口径）。
 *
 * 转码只从起点顺序产出分片；拖到真实内容窗口之外时旧实现静默夹回
 * （"拖了没反应/回弹"）。这组用例锁住：窗口判定、重转起点回退量、提示文案。
 */
describe('转码 seek 窗口', () => {
  it('没有转码任务（ahead=0）时不判定为超界', () => {
    expect(seekOutsideProduced(600, 0)).toBe(false)
  })

  it('已转出范围内的拖动立即生效', () => {
    expect(seekOutsideProduced(100, 600)).toBe(false)
    expect(seekOutsideProduced(598, 600)).toBe(false)
  })

  it('超出已转出范围 → 从目标点重转（不夹回）', () => {
    expect(seekOutsideProduced(599, 600)).toBe(true)
    expect(seekOutsideProduced(600, 600)).toBe(true)
    expect(seekOutsideProduced(1200, 600)).toBe(true)
  })

  it('起点重转后，拖回黑场填充区也要重转（否则是黑屏）', () => {
    expect(seekOutsideProduced(600, 1200, 900)).toBe(true)
    expect(seekOutsideProduced(899, 1200, 900)).toBe(true)
    expect(seekOutsideProduced(950, 1200, 900)).toBe(false)
  })

  it('重转起点回退 5 秒且不为负', () => {
    expect(transcodeRestartStart(600)).toBe(600 - TRANSCODE_SEEK_BACK)
    expect(transcodeRestartStart(3)).toBe(0)
    expect(transcodeRestartStart(0)).toBe(0)
    expect(transcodeRestartStart(Number.NaN)).toBe(0)
  })

  it('提示文案按小时/分钟切换', () => {
    expect(fmtSeekClock(90)).toBe('1:30')
    expect(fmtSeekClock(750)).toBe('12:30')
    expect(fmtSeekClock(3723)).toBe('1:02:03')
  })
})

describe('接线：播放器 → 播放页 → 后端 start', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..')
  const PLAYER = readFileSync(
    join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
    'utf8',
  )
  const PLAY = readFileSync(
    join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
    'utf8',
  )

  it('用户 seek 用窗口判定（超出即发 seek-beyond，不夹回）', () => {
    expect(PLAYER).toContain('seekOutsideProduced(target, props.aheadSeconds || 0')
    expect(PLAYER).toContain("(e: 'seek-beyond', sec: number): void")
    // 开始点也要参与判定：拖回黑场填充区同样重转
    expect(PLAYER).toContain('aheadStartSeconds')
  })

  it('播放页把 startOffset 传给播放器，并用它重转', () => {
    expect(PLAY).toContain(':ahead-start-seconds="libraryStart"')
    expect(PLAY).toContain('libraryStart.value = r.startOffset')
    expect(PLAY).toContain('@seek-beyond="onSeekBeyond"')
    expect(PLAY).toContain('transcodeRestartStart(target)')
  })
})
