import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 弹幕文字位图缓存：像素预算（2026-11-02）。
 *
 * <p>背景：原来的上限是「600 条」，但条数管不住长度——实测一条 435px 的
 * 长弹幕占 19,575 px 位图，中位数只有 12,510 px，长句是短句的 3 倍。
 * 600 条全是大字长句时最坏吃到 **44.8 MB** canvas 后备存储，
 * 而这块内存**不记在 JS 堆里**（实测 JS 堆 20.7MB、位图 20.9MB，两笔账），
 * TV 盒子最容易在这里翻车。
 *
 * <p>jsdom 没有 canvas 实现（makeSprite 直接返回 null），所以这里用
 * 源码锚点锁行为，运行期数值由 debugState() 暴露到设备上核对。
 */
const SRC = readFileSync(
  join(__dirname, '..', 'src', 'components', 'player', 'danmaku.ts'),
  'utf8',
)

function region(marker: string, len: number): string {
  const i = SRC.indexOf(marker)
  expect(i, `找不到锚点 ${marker}`).toBeGreaterThan(-1)
  return SRC.slice(i, i + len)
}

describe('位图缓存像素预算', () => {
  it('有像素预算常量，且比条数上限更贴近真实占用', () => {
    const body = region('const SPRITE_PIXEL_BUDGET', 200)
    expect(body).toMatch(/6 \* 1024 \* 1024/)
    // 条数上限仍然保留作硬保险
    expect(SRC).toContain('const SPRITE_CACHE_MAX = 600')
  })

  it('增量维护像素计数（不是每次遍历重算）', () => {
    expect(SRC).toContain('private spritePx = 0')
    // 写入时加、淘汰时减
    const make = region('private makeSprite', 3000)
    expect(make).toContain('this.spritePx += cv.width * cv.height')
    expect(make).toContain('this.spritePx -= victim.width * victim.height')
  })

  it('淘汰同时看条数与像素，且丢到刚好回到预算内（不是一次丢一半）', () => {
    const make = region('private makeSprite', 3000)
    expect(make).toContain('this.spriteCache.size >= SPRITE_CACHE_MAX')
    expect(make).toContain('SPRITE_PIXEL_BUDGET')
    // 旧实现是 drop = Math.floor(SPRITE_CACHE_MAX / 2)
    expect(make).not.toContain('Math.floor(SPRITE_CACHE_MAX / 2)')
  })

  it('淘汰循环有死循环保护（单条超预算时不能清空后无限循环）', () => {
    const make = region('private makeSprite', 3000)
    expect(make).toContain('guard')
    expect(make).toContain('this.spriteCache.size > 0')
  })

  it('dpr 变化清空缓存时必须同步归零计数', () => {
    const clear = region('this.spriteCache.clear()', 120)
    expect(clear).toContain('this.spritePx = 0')
  })

  it('debugState 暴露缓存占用，便于设备上排查', () => {
    const st = region('debugState(): {', 1200)
    expect(st).toContain('spriteCacheSize')
    expect(st).toContain('spriteCachePx')
    expect(st).toContain('spriteCacheBudgetPx')
  })
})
