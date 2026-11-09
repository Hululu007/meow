import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Tailwind 类名与自定义颜色名的"双义"陷阱。
 *
 * 踩过（2026-11-04，用户报「访问令牌样式有误，看不清」）：
 * 项目在 `@theme` 里定义了 `--color-base`（页面底色 #f4f6fa）。于是
 * `text-base` 这个类被生成了**两条规则**：
 *   · 字号 `.text-base { font-size: 1rem }`
 *   · 颜色 `.text-base { color: var(--color-base) }`
 * 两者同特异性，谁的规则后出现谁赢。实测结果是颜色赢 ——
 * 扫码弹层里 `text-base ... text-accent` 的令牌就变成了页面底色，
 * 和背景 1:1，肉眼完全看不见，而 font-size 又是对的，看代码看不出问题。
 *
 * 只有 `base` 撞（Tailwind 的 md/lg/sm/xs 没被定义成颜色名），
 * 但以后加了 `--color-sm` 之类就会同样中招，所以这里按"字号档位关键字"
 * 统一锁：src 里出现这些字面量就报错，逼你用 `text-[length:var(--fs-*)]`
 * 或 `text-lg` 这类不冲突的写法。
 */
const ROOT = join(__dirname, '..', 'src')
const CSS = join(ROOT, 'styles', 'tokens.css')

/** Tailwind 的 font-size 关键字（`text-<key>` 会同时被当成字号工具）。 */
const SIZE_KEYS = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts|tsx|css)$/.test(name)) out.push(p)
  }
  return out
}

/** 去掉注释：注释里举例说明 `text-base` 是合法的。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
}

describe('Tailwind 字号类与颜色名不撞', () => {
  it('前提：颜色 token 里确实有与字号同名的（base）', () => {
    const css = readFileSync(CSS, 'utf8')
    // 这条挂了说明约定变了，下面的检查可以放宽/调整
    expect(css, '缺少 --color-base（本测试的前提）').toContain('--color-base')
  })

  it('src 里不出现 text-base（它会被同时解析成背景色）', () => {
    const hits: string[] = []
    for (const f of walk(ROOT)) {
      const src = stripComments(readFileSync(f, 'utf8'))
      // 排除 text-base/、text-base-xxx 这类别的语义；只抓独立类名
      if (/(?<![\w-])text-base(?![\w/-])/.test(src)) hits.push(f.replace(ROOT, 'src'))
    }
    expect(
      hits,
      `这些文件用了 text-base：${hits.join(', ')}。\n` +
        '项目定义了 --color-base，所以 text-base 会把文字染成页面底色（肉眼隐形，' +
        'font-size 却正常）。改用 text-[length:var(--fs-lg)] 或 text-lg。',
    ).toEqual([])
  })

  it('没有别的颜色 token 与字号关键字同名', () => {
    const css = readFileSync(CSS, 'utf8')
    const names = [...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1])
    // base 是历史遗留：改名要牵动全项目的 bg-base/text-base 语义，代价太大，
    // 所以只靠上一条禁止使用 text-base 来规避。新增的颜色名一律不许撞。
    const clash = names.filter((n) => n !== 'base' && SIZE_KEYS.includes(n))
    expect(
      clash,
      `这些颜色名与 Tailwind 字号关键字同名，会让 text-<名> 变成颜色：${clash.join(', ')}`,
    ).toEqual([])
  })
})
