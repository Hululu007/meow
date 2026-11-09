import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页「存储」区的两处布局回归（2026-11-02 用户截图指出"显示不全"）。
 *
 * 真因不是 CSS 宽度：**弹幕配额那一块被写进了汇总网格内部**。
 * `<div class="grid sm:grid-cols-2">` 先占掉一列，它自己再按 4 列切，
 * 每个磁贴只剩 ~95px —— 200MB 的数字被输入框裁掉、下拉框的值溢出。
 *
 * 另一个次要问题：数字输入框的原生 spinner 吃掉 ~17px，`w-14`（56px）
 * 里放不下三位数，右对齐后数字顶出可视区。
 */

const dir = join(__dirname, '..', 'src')
const SETTINGS = readFileSync(join(dir, 'views', 'SettingsView.vue'), 'utf8')
const TOKENS = readFileSync(join(dir, 'styles', 'tokens.css'), 'utf8')
const TILE_SELECT = readFileSync(join(dir, 'components', 'common', 'TileSelect.vue'), 'utf8')

/** 从某个 <div 起点向后走，返回与之配对的闭合标签结束位置 */
function divRange(src: string, startIdx: number): [number, number] {
  const re = /<\/?div\b[^>]*>/g
  re.lastIndex = startIdx
  let depth = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) return [startIdx, re.lastIndex]
  }
  return [startIdx, -1]
}

describe('弹幕配额必须放在汇总网格外面', () => {
  it('不在 `grid sm:grid-cols-2` 的范围内', () => {
    const gridAt = SETTINGS.indexOf('<div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">')
    expect(gridAt).toBeGreaterThan(0)
    const [, gridEnd] = divRange(SETTINGS, gridAt)
    expect(gridEnd).toBeGreaterThan(gridAt)

    const quotaAt = SETTINGS.indexOf('v-model.number="danmakuQuotaMb"')
    expect(quotaAt).toBeGreaterThan(0)
    // 配额输入必须在网格之外——在里面就会被挤成 ~95px 宽
    expect(quotaAt).toBeGreaterThan(gridEnd)
  })

  it('视频/弹幕配额输入都带 num-field（只隐藏 spinner，宽度不动）', () => {
    expect(SETTINGS).toMatch(/v-model\.number="cacheQuotaGb"[\s\S]{0,260}class="num-field w-14/)
    expect(SETTINGS).toMatch(/v-model\.number="danmakuQuotaMb"[\s\S]{0,260}class="num-field w-14/)
  })

  it('不靠改网格列数/加宽磁贴来修（用户要求别动其他控件）', () => {
    // 4 列是设置页统一节奏；改 2 列会把旁边没问题的行一起拉宽（踩过）
    const storage = SETTINGS.slice(SETTINGS.indexOf('缓存配额'), SETTINGS.indexOf('观看记录'))
    expect(storage).not.toMatch(/set-grid-narrow/)
  })
})

describe('数字输入框隐藏原生 spinner', () => {
  it('tokens.css 有 .num-field 的规则', () => {
    expect(TOKENS).toMatch(/\.num-field \{[\s\S]{0,160}appearance: textfield/)
    expect(TOKENS).toMatch(/\.num-field::-webkit-inner-spin-button/)
    expect(TOKENS).toMatch(/-webkit-appearance: none/)
  })
})

describe('下拉选项文案要能在 193px 磁贴里放下', () => {
  it('淘汰策略的两个 label ≤ 5 字', () => {
    // 4 列网格在 TV 视口（1138 CSS）下每块只有 193px；9 字的
    // 「自动删最久没看的」实测 148px，会把「超限时」标题挤成 0 宽。
    const m = SETTINGS.match(/const evictModeOptions = \[([\s\S]*?)\]/)
    expect(m).toBeTruthy()
    const labels = [...m![1].matchAll(/label: '([^']+)'/g)].map((x) => x[1])
    expect(labels.length).toBe(2)
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(5)
  })
})
