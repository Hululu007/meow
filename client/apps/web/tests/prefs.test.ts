import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULTS,
  DENSITY_PRESETS,
  __resetPrefsCache,
  getPrefs,
  paramsToDensity,
  savePrefs,
  setDanmakuDensity,
  setDanmakuTuning,
} from '../src/stores/prefs'

/**
 * 自动播放三态。
 *
 * 这里重点验证两件事：
 *  1. 老数据（autoNext: boolean）能正确迁移，不会因为升级静默改行为
 *  2. 枚举和秒数有兜底，坏数据不会让播放页拿到非法值
 */

describe('autoNextMode 三态', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetPrefsCache()
  })

  it('默认是倒计时 5 秒', () => {
    const p = getPrefs()
    expect(p.autoNextMode).toBe('countdown')
    expect(p.autoNextDelay).toBe(5)
  })

  it('老数据 autoNext=true 迁移成倒计时（保持"会自动播"的行为）', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ autoNext: true }))
    __resetPrefsCache()
    expect(getPrefs().autoNextMode).toBe('countdown')
  })

  it('老数据 autoNext=false 迁移成不自动', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ autoNext: false }))
    __resetPrefsCache()
    expect(getPrefs().autoNextMode).toBe('off')
  })

  it('迁移后不残留 autoNext 字段', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ autoNext: true }))
    __resetPrefsCache()
    getPrefs()
    const raw = JSON.parse(localStorage.getItem('meow.prefs') || '{}')
    expect(raw.autoNext).toBeUndefined()
    expect(raw.autoNextMode).toBe('countdown')
  })

  it('非法枚举值回落到倒计时', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ autoNextMode: 'wtf' }))
    __resetPrefsCache()
    expect(getPrefs().autoNextMode).toBe('countdown')
  })

  it('倒计时秒数夹在 3–30 之间', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ autoNextDelay: 999 }))
    __resetPrefsCache()
    expect(getPrefs().autoNextDelay).toBe(30)

    localStorage.setItem('meow.prefs', JSON.stringify({ autoNextDelay: 0 }))
    __resetPrefsCache()
    expect(getPrefs().autoNextDelay).toBe(3)
  })

  it('三种模式都能写入并读回', () => {
    for (const m of ['immediate', 'countdown', 'off'] as const) {
      savePrefs({ autoNextMode: m })
      expect(getPrefs().autoNextMode).toBe(m)
    }
  })

  it('默认值里不再有 autoNext', () => {
    expect('autoNext' in DEFAULTS).toBe(false)
    expect('autoNextMode' in DEFAULTS).toBe(true)
  })
})

/**
 * 弹幕密度档位。
 *
 * 档位是「滚动时长 + 显示区域」的预设组合，两者耦合。
 * 这里重点保证三件事：
 *  1. 标准档必须等于历史默认（12s / 70%）——升级不能改观感
 *  2. 手调高级项后档位自动降级 custom，避免显示与实际不符
 *  3. 老数据没有该字段时，从现存参数反推而不是一律重置
 */
describe('danmakuDensity 档位', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetPrefsCache()
  })

  it('默认是标准档，且等于历史默认值 12s / 70%', () => {
    const p = getPrefs()
    expect(p.danmakuDensity).toBe('standard')
    expect(p.danmakuDuration).toBe(12)
    expect(p.danmakuArea).toBe(0.7)
  })

  it('切档位会同时写好时长和区域', () => {
    const sparse = setDanmakuDensity('sparse')
    expect(sparse.danmakuDuration).toBe(18)
    expect(sparse.danmakuArea).toBe(0.55)

    const dense = setDanmakuDensity('dense')
    expect(dense.danmakuDuration).toBe(9)
    expect(dense.danmakuArea).toBe(0.85)
  })

  it('手调时长后档位降级为 custom', () => {
    setDanmakuDensity('standard')
    const p = setDanmakuTuning({ duration: 8 })
    expect(p.danmakuDensity).toBe('custom')
    expect(p.danmakuDuration).toBe(8)
    // 区域保持不变
    expect(p.danmakuArea).toBe(0.7)
  })

  it('手调区域后档位同样降级为 custom', () => {
    setDanmakuDensity('standard')
    const p = setDanmakuTuning({ area: 0.4 })
    expect(p.danmakuDensity).toBe('custom')
    expect(p.danmakuArea).toBe(0.4)
  })

  it('手调后恰好调回某档的完整参数，会自动回到那一档', () => {
    setDanmakuDensity('standard')
    setDanmakuTuning({ duration: 8 })
    expect(getPrefs().danmakuDensity).toBe('custom')
    // 12 / 0.7 正好是标准档
    const back = setDanmakuTuning({ duration: 12, area: 0.7 })
    expect(back.danmakuDensity).toBe('standard')
  })

  it('老数据没有 danmakuDensity 时从现存参数反推', () => {
    // 模拟一个老版本存下来的 prefs：有 duration/area 但没有 density
    localStorage.setItem(
      'meow.prefs',
      JSON.stringify({ danmakuDuration: 9, danmakuArea: 0.85 }),
    )
    __resetPrefsCache()
    const p = getPrefs()
    expect(p.danmakuDensity).toBe('dense') // 9/0.85 正是密集档
    expect(p.danmakuDuration).toBe(9)
    expect(p.danmakuArea).toBe(0.85)
  })

  it('老数据参数对不上任何档位时标为 custom，不覆盖用户的值', () => {
    localStorage.setItem(
      'meow.prefs',
      JSON.stringify({ danmakuDuration: 17, danmakuArea: 0.62 }),
    )
    __resetPrefsCache()
    const p = getPrefs()
    expect(p.danmakuDensity).toBe('custom')
    // 关键：不能把手调过的值重置成 standard
    expect(p.danmakuDuration).toBe(17)
    expect(p.danmakuArea).toBe(0.62)
  })

  it('参数反推是双向稳定的（density → params → density）', () => {
    for (const d of ['sparse', 'standard', 'dense'] as const) {
      const params = DENSITY_PRESETS[d]
      expect(paramsToDensity(params.duration, params.area)).toBe(d)
    }
  })
})

describe('更新源/令牌随 Prefs 推送（2026-11-06）', () => {
  it('DEFAULTS 里有 updateSource / updateToken', () => {
    // 手机扫码推送只搬 Prefs（main.ts 的 __meowPrefsApply 用 Object.keys(getPrefs())
    // 当白名单），所以这两个键必须在 DEFAULTS 里 —— 否则手机上填好、推不到电视。
    const keys = Object.keys(DEFAULTS) as string[]
    expect(keys).toContain('updateSource')
    expect(keys).toContain('updateToken')
  })

  it('savePrefs 之后 getPrefs 能读回来', () => {
    savePrefs({ updateSource: 'https://example.test/releases/latest', updateToken: 't0k3n' })
    expect(getPrefs().updateSource).toBe('https://example.test/releases/latest')
    expect(getPrefs().updateToken).toBe('t0k3n')
    savePrefs({ updateSource: '', updateToken: '' })
  })
})

describe('主题风格迁移（2026-11-09 移除 miuix）', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetPrefsCache()
  })

  it('老数据 miuix 迁到 claude，而不是回落 meow', () => {
    // 直接回 meow 会让用户以为主题被重置；claude 是同一"暖橙强调"槽位。
    localStorage.setItem('meow.prefs', JSON.stringify({ themeStyle: 'miuix' }))
    __resetPrefsCache()
    expect(getPrefs().themeStyle).toBe('claude')
  })

  it('未知风格仍回落 meow', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ themeStyle: 'not-a-theme' }))
    __resetPrefsCache()
    expect(getPrefs().themeStyle).toBe('meow')
  })

  it('新风格原样保留', () => {
    localStorage.setItem('meow.prefs', JSON.stringify({ themeStyle: 'nord' }))
    __resetPrefsCache()
    expect(getPrefs().themeStyle).toBe('nord')
  })
})
