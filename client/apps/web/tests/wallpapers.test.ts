/**
 * 壁纸清单门禁。
 *
 * 这组断言对应一类很容易漏的故障：只加了 WALLPAPERS 条目、忘了放图片文件
 * （或文件名大小写、扩展名写错），设置页会出现一张点开是空白的卡片。
 * 这里逐项检查 src/thumb 在 public/wallpapers 下真实存在。
 */
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WALLPAPERS } from '../src/stores/theme'
import { LIGHT_WALLPAPERS, WALLPAPER_IDS, isLightWallpaper } from '../src/stores/wallpapers'

const DIR = resolve(process.cwd(), 'public/wallpapers')

describe('内置壁纸清单', () => {
  it('WALLPAPERS 与 WALLPAPER_IDS 一一对应', () => {
    expect(WALLPAPERS.map((w) => w.value)).toEqual([...WALLPAPER_IDS])
  })

  it('每张壁纸的主图与缩略图都存在且非空', () => {
    for (const w of WALLPAPERS) {
      if (!w.src) continue
      for (const [kind, p] of [
        ['主图', w.src],
        ['缩略图', w.thumb],
      ] as const) {
        const file = resolve(DIR, basename(p))
        expect(existsSync(file), `${w.value} ${kind} 缺失：${file}`).toBe(true)
        // 纯色/极简缩略图可以小到 400B 左右，只挡真正的空文件
        expect(statSync(file).size, `${w.value} ${kind} 是空文件`).toBeGreaterThan(200)
      }
    }
  })

  it('浅色组必须是壁纸清单的子集', () => {
    for (const id of LIGHT_WALLPAPERS) {
      expect(WALLPAPER_IDS as readonly string[]).toContain(id)
      expect(isLightWallpaper(id)).toBe(true)
    }
    expect(isLightWallpaper('')).toBe(false)
    expect(isLightWallpaper('firefly')).toBe(false)
  })

  it('2026-11-09 最终保留的横屏图都在（2 暗 + 3 浅）', () => {
    const dark = ['firefly', 'theater']
    const light = ['inkpeak', 'teafield', 'linen']
    for (const id of [...dark, ...light]) {
      expect(WALLPAPER_IDS as readonly string[]).toContain(id)
      expect(existsSync(resolve(DIR, `${id}.webp`)), `${id}.webp`).toBe(true)
      expect(existsSync(resolve(DIR, `${id}-thumb.webp`)), `${id}-thumb.webp`).toBe(true)
    }
    for (const id of light) expect(isLightWallpaper(id)).toBe(true)
    for (const id of dark) expect(isLightWallpaper(id)).toBe(false)
  })

  it('2026-11-09 淘汰的 6 张已从清单和磁盘移除', () => {
    for (const id of ['deepglow', 'rainbokeh', 'starridge', 'seacottage', 'cloudwin', 'mistlake']) {
      expect(WALLPAPER_IDS as readonly string[]).not.toContain(id)
      expect(existsSync(resolve(DIR, `${id}.webp`)), `${id}.webp 应已删除`).toBe(false)
    }
  })
})
