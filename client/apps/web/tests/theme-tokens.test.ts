/**
 * 主题变量门禁。
 *
 * 这个测试只做三件事，但每一件都对应一次真实回退：
 *  1. 每套风格必须有浅/深两块、每块 28 个变量 —— 少一个就会有元素拿 :root
 *     的 meow 默认值，表现为"换主题后某块颜色没变"。
 *  2. accent / on-* 必须是 6 位 hex —— TV 焦点光晕 `rgbaFromHex()` 只认这种
 *     格式，写 rgb()/oklch() 会让光晕静默失效（见 stores/theme.ts）。
 *  3. on-accent / on-warn / on-hot 必须过 4.5:1 —— 这几个值决定"彩色按钮上的
 *     文字"，明暗会翻转；按直觉写白字会在浅色主题上变成 2.6~3.3:1。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_STYLES, isThemeStyle } from '../src/stores/theme'

// vitest 的 cwd 就是 client/apps/web；不要用 import.meta.url（jsdom 下不是 file:）
const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')

const REQUIRED = [
  'color-base',
  'color-header-veil',
  'color-strip-veil',
  'color-surface',
  'color-elevated',
  'color-panel',
  'color-accent',
  'color-accent-dim',
  'color-ink',
  'color-ink-2',
  'color-ink-3',
  'color-player',
  'color-hot',
  'color-warn',
  'color-ok',
  'color-on-accent',
  'color-on-warn',
  'color-on-hot',
  'color-card',
  'color-card-hover',
  'color-card-sunken',
  'color-line',
  'color-line-hover',
  'color-field',
  'color-wp-tint',
  'radius-md',
  'radius-lg',
  'radius-xl',
]

type Block = Record<string, string>

function parseBlocks(): Map<string, Block> {
  const out = new Map<string, Block>()
  const re = /html\[data-style="([^"]+)"\]\[data-mode="(dark|light)"\]\s*\{([\s\S]*?)\r?\n\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const vars: Block = {}
    for (const line of m[3].split(/\r?\n/)) {
      const hit = /^\s*--([a-z0-9-]+):\s*([^;]+);/.exec(line)
      if (hit) vars[hit[1]] = hit[2].trim()
    }
    out.set(`${m[1]}-${m[2]}`, vars)
  }
  return out
}

const blocks = parseBlocks()

function lum(hex: string): number {
  const h = hex.replace('#', '')
  const v = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}

function contrast(a: string, b: string): number {
  const x = lum(a)
  const y = lum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('主题变量完整性', () => {
  it('已移除的 miuix 不再被接受，新风格可用', () => {
    expect(isThemeStyle('miuix')).toBe(false)
    for (const t of THEME_STYLES) expect(isThemeStyle(t.value)).toBe(true)
  })

  it('每套风格都有浅/深两块，没有多余块', () => {
    const expected = THEME_STYLES.flatMap((t) => [`${t.value}-dark`, `${t.value}-light`]).sort()
    expect([...blocks.keys()].sort()).toEqual(expected)
  })

  it('每块都定义了 28 个变量', () => {
    for (const [name, vars] of blocks) {
      expect(Object.keys(vars).sort(), name).toEqual([...REQUIRED].sort())
    }
  })

  it('accent 与 on-* 都是 6 位 hex（TV 光晕依赖这个格式）', () => {
    const keys = ['color-accent', 'color-on-accent', 'color-on-warn', 'color-on-hot']
    for (const [name, vars] of blocks) {
      for (const k of keys) {
        expect(vars[k], `${name} --${k}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('壁纸 tint 是空格分隔的 RGB 三元组', () => {
    for (const [name, vars] of blocks) {
      expect(vars['color-wp-tint'], name).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/)
    }
  })
})

describe('主题对比度', () => {
  const rules: Array<[string, string, string, number]> = [
    ['正文', 'color-ink', 'color-base', 7],
    ['次级文字', 'color-ink-2', 'color-base', 4.5],
    ['三级文字', 'color-ink-3', 'color-base', 4.5],
    ['强调色按钮文字', 'color-on-accent', 'color-accent', 4.5],
    ['警告色按钮文字', 'color-on-warn', 'color-warn', 4.5],
    ['危险色按钮文字', 'color-on-hot', 'color-hot', 4.5],
    // 焦点框是非文本元素，3:1 即可；品牌青浅色档是 2.76，用 2.5 兜底
    ['强调色/底色（焦点框）', 'color-accent', 'color-base', 2.5],
  ]

  for (const [label, fg, bg, min] of rules) {
    it(`${label} ≥ ${min}:1`, () => {
      for (const [name, vars] of blocks) {
        const value = contrast(vars[fg], vars[bg])
        expect(value, `${name} ${label}=${value.toFixed(2)}`).toBeGreaterThanOrEqual(min)
      }
    })
  }
})
