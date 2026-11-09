import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 大屏/投影仪上的字号不能"越看越小"。
 *
 * 踩过的问题：模板里有 343 处硬编码 px（text-[11px] 占 263 处）。
 * px 是绝对单位，不参与 rem 缩放 —— 同样的 11px，在 640px 高的 CSS 视口里
 * 占屏高 1.7%，到 2160px 的 4K 播放器上只剩 0.5%。用户看到的就是
 * "顶栏正常、设置页字小"，其实两者都在变，只是小的那档先撑不住了。
 *
 * 根治要两件事同时成立，缺一条就回退：
 *   1. 根字号随视口放大（所有 rem 一起变）
 *   2. 硬编码 px 的那批类名在电视下被抬到 10-foot UI 的下限
 *
 * 这是纯 CSS 约定，typecheck 与功能测试都看不见，只能在源码层面锁。
 */
const CSS = join(__dirname, '..', 'src', 'styles', 'tokens.css')

function readCss(): string {
  return readFileSync(CSS, 'utf8')
}

/** 去掉注释，避免注释里提到的示例代码被误判成真实规则。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('电视大屏字号', () => {
  it('根字号随视口放大（否则全部 rem 都不动）', () => {
    const css = stripComments(readCss())
    // 必须有 html[data-tv='1'] 的 font-size
    expect(css, '缺少电视根字号规则').toMatch(/html\[data-tv='1'\]\s*\{[^}]*font-size:\s*1rem/)
    // 且至少有一个宽度断点把它继续抬高
    const bumps = [
      ...css.matchAll(/@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*html\[data-tv='1'\]\s*\{([^}]*)\}/g),
    ].filter((m) => /font-size:\s*1\.[0-9]+rem|font-size:\s*[2-9]/.test(m[2]))
    expect(bumps.length, '至少要有 2 个断点继续放大根字号').toBeGreaterThanOrEqual(2)
    // 断点值应递增（写反了会导致大屏反而更小）
    const widths = bumps.map((m) => Number(m[1]))
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
  })

  it('电视下压住 10/11/12px 那几档硬编码类名', () => {
    const css = stripComments(readCss())
    // 用属性选择器匹配完整类名，避免依赖 Tailwind 的转义形式
    for (const px of ['10px', '11px', '12px']) {
      const re = new RegExp(
        `html\\[data-tv='1'\\]\\s*\\[class~='text-\\[${px}\\]'\\]\\s*\\{[^}]*font-size:\\s*([0-9.]+)rem`,
      )
      const m = css.match(re)
      expect(m, `缺少 text-[${px}] 的电视覆盖`).toBeTruthy()
      // 抬升后的值必须 ≥ 0.8125rem(13px)：低于这个在 3 米外看不清
      expect(parseFloat(m![1]), `text-[${px}] 在电视上仍偏小`).toBeGreaterThanOrEqual(0.8125)
    }
  })

  it('组件类标题/说明也有电视档位', () => {
    const css = stripComments(readCss())
    expect(css, '.set-title 缺少电视档位').toMatch(
      /html\[data-tv='1'\]\s*\.set-title\s*\{[^}]*font-size:/,
    )
    expect(css, '.set-hint 缺少电视档位').toMatch(
      /html\[data-tv='1'\]\s*\.set-hint\s*\{[^}]*font-size:/,
    )
  })

  it('字号 token 齐全（新代码只用 token，不再写死 px）', () => {
    const css = stripComments(readCss())
    for (const t of ['--fs-tiny', '--fs-mini', '--fs-xs', '--fs-sm', '--fs-base', '--fs-md', '--fs-lg']) {
      expect(css, `缺少 token ${t}`).toContain(t)
    }
  })
})
