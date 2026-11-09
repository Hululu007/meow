import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 详情页要标出"这个条目来自哪个源"。
 *
 * 搜索是聚合的，同一部片可能来自十几个源；点进详情后「播放源」列的是
 * 这个源自己的线路名（4K / 腾音-4K-限 / CO-4K-限…），看不出是哪家。
 * 用户在两部同名片之间对比时，没有源名就分不清自己在哪。
 */
const DETAIL = readFileSync(
  join(__dirname, '..', 'src', 'views', 'DetailView.vue'),
  'utf8',
)

describe('详情页显示来源', () => {
  it('按 site key 从站点表取显示名', () => {
    expect(DETAIL).toMatch(/const siteLabel = computed\(/)
    expect(DETAIL).toMatch(/store\.sites\.find\(\(x\) => x\.key === site\)/)
  })

  it('取不到显示名就不显示（不甩内部 key）', () => {
    // 回退必须是空串；写成 `|| site` 会把 Jpys 这种内部 key 给用户看
    expect(DETAIL).toMatch(/return s\?\.name \|\| ''/)
    expect(DETAIL).not.toMatch(/return s\?\.name \|\| site\b/)
  })

  it('模板里放在元信息一排，且不参与焦点', () => {
    expect(DETAIL).toContain('来源 {{ siteLabel }}')
    expect(DETAIL).toMatch(/v-if="siteLabel"/)
    // 必须是 span（不可聚焦），TV 上不会多一个焦点停靠点
    const i = DETAIL.indexOf('来源 {{ siteLabel }}')
    const before = DETAIL.slice(Math.max(0, i - 200), i)
    expect(before).toContain('<span')
  })
})
