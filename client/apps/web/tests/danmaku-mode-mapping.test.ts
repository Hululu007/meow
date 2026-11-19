import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 弹幕模式（顶部/底部）链路（2026-11-19）。
 *
 * 背景：腾讯 `barrage_list[].content_style` 里 position 2=顶部/3=底部；
 * 爱奇艺 bulletInfo 的 `<position>` 0=滚动/1=顶部/2=底部。旧实现两者都把
 * p 的 mode 写死成 1，前端又只认 2/3（CatVod 旧约定），于是用户看到的
 * 永远只有滚动弹幕。现在统一转成 B 站约定（4=底部、5=顶部），
 * 前端渲染器和聚合源（danmu_api）用同一套。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')
const src = readFileSync(API, 'utf8')

describe('后端保留弹幕位置', () => {
  it('腾讯解析 content_style 的 position（2 顶 / 3 底）', () => {
    expect(src).toContain('content_style')
    expect(src).toMatch(/if \(pos == 2\) return 5;/)
    expect(src).toMatch(/if \(pos == 3\) return 4;/)
  })

  it('爱奇艺解析 bulletInfo 的 position（1 顶 / 2 底）', () => {
    expect(src).toContain('IQIYI_POSITION')
    expect(src).toMatch(/pos == 100 \|\| pos == 108\) mode = 5/)
    expect(src).toMatch(/pos == 200 \|\| pos == 208\) mode = 4/)
  })

  it('两种源都按实际 mode 写回 p 字段', () => {
    // 两处 `<d p="` 拼装都必须用 b[3]，不能再写死 ",1,25,"
    expect(src.match(/append\(b\[3\]\)\.append\(",25,"\)/g)?.length).toBe(2)
    expect(src).not.toContain('append(",1,25,")')
  })
})

describe('后端保留渐变与权重', () => {
  it('腾讯：content_style.gradient_colors + show_weight', () => {
    expect(src).toContain('tencentStyleGradient')
    expect(src).toContain('gradient_colors')
    expect(src).toContain('show_weight')
  })

  it('爱奇艺：like/plus/diss 折算权重', () => {
    expect(src).toContain('IQIYI_LIKE')
    expect(src).toContain('IQIYI_PLUS')
    expect(src).toContain('IQIYI_DISS')
  })

  it('XML 输出带 g / w 可选属性', () => {
    expect(src).toContain('g=\\"')
    expect(src).toContain('w=\\"')
  })
})
