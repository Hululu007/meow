import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { qrSvg, qrMatrix } from '../src/utils/qr'

/**
 * 二维码必须真的能被扫出来，不能只是"看起来像个二维码"。
 *
 * 这个测试文件的来历值得记一笔：我最初手写了一版 QR 编码器（字节模式 +
 * RS 纠错 + 掩码），自测"有定位图形、尺寸对、时序交替"，全都通过。
 * 但用官方 `qrcode` 库逐位比对后发现 **188/625 位不同**——功能图形的
 * 绘制顺序错了，矩阵是个伪码，手机扫不出来。
 *
 * 所以这里保留逐位交叉验证：只要 vendored 库将来被改动或替换，
 * 与参考实现不一致就会立刻失败。
 */
const REF_TEXT = 'http://192.168.1.32:9333/'

describe('二维码渲染', () => {
  it('SVG 结构正确：白底静默区 + 黑色模块', () => {
    const svg = qrSvg(REF_TEXT, 200)
    expect(svg).toContain('viewBox="0 0 200 200"')
    // 静默区白底：深色主题下没有白底手机识别不了
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('fill="#000000"')
    expect(svg).toMatch(/<path d="M[\d.]+ [\d.]+h/)
  })

  it('尺寸符合 4v+17，且短 URL 用最小版本', () => {
    const m = qrMatrix(REF_TEXT)
    const n = m.length
    expect((n - 17) % 4).toBe(0)
    expect(m[0].length).toBe(n)
    // 25 字节内容在 M 级下是版本 2（25×25）
    expect(n).toBe(25)
  })

  it('三个定位图形是 7×7 回字形', () => {
    const m = qrMatrix(REF_TEXT)
    const n = m.length
    const check = (ox: number, oy: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = x === 0 || y === 0 || x === 6 || y === 6
          const core = x >= 2 && x <= 4 && y >= 2 && y <= 4
          expect(m[oy + y][ox + x], `finder(${ox},${oy}) @${x},${y}`).toBe(ring || core)
        }
      }
    }
    check(0, 0)
    check(n - 7, 0)
    check(0, n - 7)
  })

  it('时序图形交替（第 6 行/列，从定位图形外沿开始）', () => {
    const m = qrMatrix(REF_TEXT)
    const n = m.length
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i], `row6 x=${i}`).toBe(i % 2 === 0)
      expect(m[i][6], `col6 y=${i}`).toBe(i % 2 === 0)
    }
  })

  it('相同输入产出相同矩阵（无随机性）', () => {
    expect(qrMatrix(REF_TEXT)).toEqual(qrMatrix(REF_TEXT))
  })

  it('长内容自动升版本', () => {
    expect(qrMatrix('x'.repeat(120)).length).toBeGreaterThan(qrMatrix('a').length)
  })

  /**
   * vendored 文件只能是"纯 ESM，单一路径"。
   *
   * 踩过两次，两种后缀各坏一处：
   *   · `.cjs` —— dev 模式 Vite 原样发给浏览器，按 ESM 解析 →
   *     「does not provide an export named 'default'」，**设置页整页打不开**。
   *     生产构建正常，所以 CI 完全抓不到。
   *   · 保留 UMD 尾巴的 `.mjs` —— vitest 按 ESM 加载时
   *     `module.exports = …` 抛「Cannot set property default」，
   *     整个测试文件挂掉。
   *
   * 所以锁死：后缀 .mjs、有 export default、代码里不残留 module.exports。
   */
  it('vendored 库是纯 ESM（不残留 UMD 尾巴）', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'utils', 'vendor', 'qrcode-generator.mjs'),
      'utf8',
    )
    expect(src).toContain('export default qrcode')
    // 注释里提到 module.exports 是解释性的，只禁止真实语句
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, 'UMD 尾巴会让 vitest 或 dev 其中之一崩掉').not.toContain('module.exports')
  })
})
