import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * tv-nav.js 必须能在 **Chrome 66** 上解析。
 *
 * 起因（2026-10-30，用户报「首页只有菜单、返回键有效」）：
 * 这个文件里写了一处 `var SCOPE_IDLE_CLOSE_MS = 20_000` ——
 * numeric separator 是 ES2021 / Chrome 75+ 才有的语法。
 * 投影仪（极米 Z6X Pro / Android 9 / **Chrome 66**）解析整个文件时抛
 * `SyntaxError: Invalid or unexpected token`，于是 tv-nav.js **一行都没执行**：
 *
 *   · `window.__meowTvNav` 不存在 → 方向键全部失效
 *   · 焦点框样式（脚本早期注入的 <style>）也没了 → 连选中框都看不到
 *   · 而菜单键/返回键走的是 Vue 侧的 `__meowTvMenu` / `__meowTvConsumeBack`
 *     （定义在 web bundle 里，与 tv-nav.js 无关）→ 仍然正常
 *
 * 症状与用户描述完全一致。这类错误在 Node/现代浏览器里**完全静默**，
 * 只有真机才暴露，所以必须用静态门禁拦住。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const NAV = join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js')

/** 去掉注释与字符串里的内容，只留可执行代码，避免注释里的示例文本误报。 */
function codeOnly(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let state: 'code' | 'line' | 'block' | 's' | 'd' | 't' | 're' = 'code'
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue }
      if (c === "'") { state = 's'; i++; continue }
      if (c === '"') { state = 'd'; i++; continue }
      if (c === '`') { state = 't'; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } i++; continue }
    if (state === 'block') { if (c === '*' && c2 === '/') { state = 'code'; i += 2 } else i++; continue }
    // 字符串：处理转义
    if (c === '\\') { i += 2; continue }
    if ((state === 's' && c === "'") || (state === 'd' && c === '"') || (state === 't' && c === '`')) {
      state = 'code'
    }
    i++
  }
  return out
}

describe('tv-nav.js 必须兼容 Chrome 66（投影仪）', () => {
  const src = readFileSync(NAV, 'utf8')
  const code = codeOnly(src)

  it('不使用数字分隔符（20_000 这类）', () => {
    // 这是实际踩到的那个：一条就让整个文件语法错误
    const hits = [...code.matchAll(/\b\d[\d_]*_\d[\d_]*\b/g)].map((m) => m[0])
    expect(hits, `发现数字分隔符 ${hits.join(', ')}（Chrome 75+ 才支持）`).toEqual([])
  })

  it('不使用可选链 ?. 与空值合并 ??', () => {
    // Chrome 80+；投影仪是 66
    expect(code).not.toMatch(/\?\.[a-zA-Z_$[]/)
    expect(code).not.toMatch(/\?\?/)
  })

  it('不使用逻辑赋值（||= &&= ??=）', () => {
    expect(code).not.toMatch(/\|\|=|&&=|\?\?=/)
  })

  it('不使用 Object.fromEntries / Array.at / String.replaceAll', () => {
    // 分别需要 Chrome 73 / 92 / 85
    expect(code).not.toMatch(/Object\.fromEntries/)
    expect(code).not.toMatch(/\.at\(\s*-?\d/)
    expect(code).not.toMatch(/\.replaceAll\(/)
  })

  it('不使用 BigInt 字面量与 catch 省略绑定', () => {
    expect(code).not.toMatch(/\b\d+n\b/) // 1n
    // catch {} （Chrome 66 需要 catch (e)）
    expect(code).not.toMatch(/catch\s*\{/)
  })

  it('__meowTvNav 真的有定义（否则方向键全废）', () => {
    expect(src).toContain('window.__meowTvNav = function')
  })
})
