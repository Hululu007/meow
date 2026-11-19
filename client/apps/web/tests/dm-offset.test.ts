import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllDmOffsets,
  formatDmOffset,
  getDmOffset,
  normalizeDmOffset,
  nudgeDmOffset,
  resetDmOffset,
  setDmOffset,
} from '../src/stores/dmOffset'

/**
 * 弹幕时间校准（±30 秒、0.5 秒档、按片/集持久化）。
 *
 * 这是跨版本片源偏移的唯一用户侧出口；归一化和持久化错了，
 * 用户调好的值下次进播放页就丢，等于没做。
 */
describe('normalizeDmOffset', () => {
  it('按 0.5 秒四舍五入', () => {
    expect(normalizeDmOffset(0.3)).toBe(0.5)
    expect(normalizeDmOffset(-0.3)).toBe(-0.5)
    expect(normalizeDmOffset(1.24)).toBe(1)
    expect(normalizeDmOffset(1.26)).toBe(1.5)
  })

  it('夹在 ±30 秒，非法值回 0', () => {
    expect(normalizeDmOffset(99)).toBe(30)
    expect(normalizeDmOffset(-99)).toBe(-30)
    expect(normalizeDmOffset(Number.NaN)).toBe(0)
    expect(normalizeDmOffset(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('dmOffset 持久化', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('按 key 独立读写', () => {
    setDmOffset('庆余年 · 1', 2)
    setDmOffset('庆余年 · 2', -1.5)
    expect(getDmOffset('庆余年 · 1')).toBe(2)
    expect(getDmOffset('庆余年 · 2')).toBe(-1.5)
    expect(getDmOffset('别的片 · 1')).toBe(0)
  })

  it('写 0 等于删除；nudge 累积并按档归一', () => {
    setDmOffset('片 · 1', 1)
    expect(nudgeDmOffset('片 · 1', 0.5)).toBe(1.5)
    // 1.5 - 0.3 = 1.2 → 归一化到 1.0（0.5 秒档）
    expect(nudgeDmOffset('片 · 1', -0.3)).toBe(1)
    resetDmOffset('片 · 1')
    expect(getDmOffset('片 · 1')).toBe(0)
  })

  it('clearAll 清空全部', () => {
    setDmOffset('a', 1)
    setDmOffset('b', -1)
    expect(clearAllDmOffsets()).toBe(2)
    expect(getDmOffset('a')).toBe(0)
    expect(getDmOffset('b')).toBe(0)
  })

  it('format 带符号、保留 1 位', () => {
    expect(formatDmOffset(0)).toBe('0s')
    expect(formatDmOffset(1.5)).toBe('+1.5s')
    expect(formatDmOffset(-2)).toBe('-2.0s')
  })
})
