import { describe, expect, it } from 'vitest'
import { clampMaxCols, resolveCardCols } from '@/composables/useCardCols'

/**
 * 列数规则：按可用宽度能放几张卡，受用户上限约束；
 * 矮屏（手机横屏）再兜一层保证首行装得下。
 *
 * 这里的宽度都是「内容区宽度」= 视口宽 - 页面左右内边距 48。
 */
describe('resolveCardCols 电视壳的手机竖屏（UA 是 MeowTV，但视口只有手机大）', () => {
  it('360 CSS 竖屏按手机卡宽给 3 列，不再按电视卡宽算出 4 列', () => {
    // MuMu 竖屏实测：1440×2560@640dpi → 360×640 CSS
    expect(resolveCardCols(312, 528, 6, true)).toBe(3)
  })

  it('真·电视横屏（960 CSS）仍按电视卡宽走用户上限', () => {
    expect(resolveCardCols(912, 528, 6, true)).toBe(6)
  })
})

describe('resolveCardCols 常规视口', () => {
  it('手机竖屏 375 给 3 列（每张约 98px）', () => {
    expect(resolveCardCols(327, 700, 8)).toBe(3)
  })

  it('大屏手机竖屏 430 仍是 3 列', () => {
    expect(resolveCardCols(382, 820, 8)).toBe(3)
  })

  it('640 宽的小横屏给 5 列', () => {
    expect(resolveCardCols(592, 248, 8)).toBe(5)
  })

  it('平板竖屏 768 给 6 列', () => {
    expect(resolveCardCols(720, 912, 8)).toBe(6)
  })

  it('1024 给 8 列', () => {
    expect(resolveCardCols(976, 656, 8)).toBe(8)
  })

  it('桌面 1440 / 1920 落在用户上限 8', () => {
    expect(resolveCardCols(1392, 788, 8)).toBe(8)
    expect(resolveCardCols(1552, 968, 8)).toBe(8)
  })

  it('用户上限设 6 时桌面只给 6 列', () => {
    expect(resolveCardCols(1552, 968, 6)).toBe(6)
  })
})

describe('resolveCardCols 电视', () => {
  it('960 CSS（1080p@320dpi）在电视档给 8 列', () => {
    expect(resolveCardCols(912, 428, 8, true)).toBe(8)
  })

  it('同一宽度在普通浏览器里只给 7 列', () => {
    expect(resolveCardCols(912, 428, 8, false)).toBe(7)
  })

  it('用户上限 10 时电视给 10 列', () => {
    expect(resolveCardCols(912, 428, 10, true)).toBe(10)
  })
})

describe('resolveCardCols 矮屏兜底', () => {
  it('568×320 横屏：4 列会让卡高于可视区，兜底提到 5 列', () => {
    // 可视高 320-112=208，4 列卡宽 130 → 海报 195 + 标题 40 = 235 > 208
    expect(resolveCardCols(520, 208, 8)).toBe(5)
  })

  it('844×390 横屏：6 列已经装得下，不再加列', () => {
    expect(resolveCardCols(796, 278, 8)).toBe(6)
  })

  it('竖屏不会因为兜底被加列', () => {
    expect(resolveCardCols(327, 700, 8)).toBe(3)
  })
})

describe('clampMaxCols', () => {
  it('夹到 2..10', () => {
    expect(clampMaxCols(0)).toBe(2)
    expect(clampMaxCols(99)).toBe(10)
    expect(clampMaxCols(NaN)).toBe(6)
  })
})
