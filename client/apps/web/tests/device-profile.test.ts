/**
 * 设备判据门禁（device-adaptive.md §6 D 阶段）。
 *
 * 两条防线：
 *  1. **源码扫描**：除 `src/compat/` 外，不允许再出现散判信号
 *     （UA、pointer 媒体查询、裸 innerWidth/innerHeight、maxTouchPoints）。
 *     历史债的根源就是这些判据散落在页面里，同一台设备在不同页面得到不同结论。
 *  2. **行为锁**：形态映射（phone/tablet/desktop/tv-large）与壳身份
 *     （身份 vs moduleCheck 能力）按文档表逐格断言。
 *
 * 新增端差异时：能力 → 探桥方法；身份 → `compat/shell`；形态 → `data-form`。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { resolveForm } from '../src/compat/deviceProfile'

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/** 去掉注释，避免文档里提到 `MeowTV` / `userAgent` 也触发门禁 */
function stripComments(code: string): string {
  return code
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const sources = walk(SRC)
  .filter((p) => /\.(ts|vue|css)$/.test(p))
  .filter((p) => !relative(SRC, p).replace(/\\/g, '/').startsWith('compat/'))

describe('① 判据单一来源：散判信号只允许出现在 compat/', () => {
  const rules: Array<[string, RegExp]> = [
    // 区分 UA 字面量 MeowTV 与桥对象 meowTv：只禁前者
    ['UA 判断', /MeowTV/],
    ['指针媒体查询', /matchMedia\(\s*['"]\(pointer/],
    ['裸视口宽度阈值', /innerWidth\s*>=/],
    ['裸视口高度阈值', /innerHeight\s*</],
    ['UA 读取', /navigator\.userAgent/],
    ['触摸点数', /maxTouchPoints/],
    ['旧断点 899', /max-width:\s*899/],
    ['旧断点 1023', /max-width:\s*1023/],
  ]

  for (const [label, re] of rules) {
    it(`${label} 不再散落在业务代码里（${re}）`, () => {
      const hits = sources.filter((p) => {
        const code = stripComments(readFileSync(p, 'utf8'))
        return re.test(code)
      })
      expect(hits.map((p) => relative(SRC, p).split('\\').join('/'))).toEqual([])
    })
  }

  it('isTvShell 只有一个实现（compat/shell.ts），其余都是 re-export', () => {
    const defs = walk(SRC)
      .filter((p) => /\.(ts|vue)$/.test(p))
      .filter((p) => /export function isTvShell\s*\(/.test(readFileSync(p, 'utf8')))
    expect(defs.map((p) => relative(SRC, p).split('\\').join('/'))).toEqual(['compat/shell.ts'])
  })

  it('所有 poster-grid 都用 colsStyle（禁止写死断点列数）', () => {
    const bad: string[] = []
    for (const p of walk(SRC).filter((f) => f.endsWith('.vue'))) {
      const lines = readFileSync(p, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/class="[^"]*poster-grid/.test(line)) return
        if (!/colsStyle\s*\(/.test(line)) bad.push(`${relative(SRC, p).split('\\').join('/')}:${i + 1}`)
      })
    }
    expect(bad).toEqual([])
  })
})

describe('② 形态映射（data-form 的纯函数）', () => {
  it('手机竖屏 390×844 → phone', () => {
    expect(resolveForm(390, 844, false, false)).toBe('phone')
  })
  it('平板竖屏 820×1180 → tablet（iPad Air 4）', () => {
    expect(resolveForm(820, 1180, false, false)).toBe('tablet')
  })
  it('手机横屏 852×393 → tablet（短边 <480）', () => {
    expect(resolveForm(852, 393, false, false)).toBe('tablet')
  })
  it('PC 1280×720（有精确指针）→ desktop', () => {
    expect(resolveForm(1280, 720, true, false)).toBe('desktop')
  })
  it('TV 壳 1138×640（无精确指针）→ tv-large', () => {
    expect(resolveForm(1138, 640, false, true)).toBe('tv-large')
  })
  it('MuMu 带鼠标（有精确指针）→ desktop（插鼠标的盒子要显示返回键）', () => {
    expect(resolveForm(1138, 640, true, true)).toBe('desktop')
  })
  it('iPad 横屏 1180×820（web 壳、无精确指针）→ desktop，不是 tv-large', () => {
    // 返回键靠 form 判；iPad 不能被当成电视丢掉返回键
    expect(resolveForm(1180, 820, false, false)).toBe('desktop')
  })
  it('同尺寸但 TV 壳 → tv-large（形态 + 身份两个条件）', () => {
    expect(resolveForm(1180, 820, false, true)).toBe('tv-large')
  })
})

describe('③ 壳身份与模块能力分开（D-2）', () => {
  it('老壳只有 platform：身份是 TV，但没有 moduleCheck', async () => {
    delete document.documentElement.dataset.shell
    ;(window as any).meowTv = { platform: () => 'tv' }
    try {
      const { isTvShell, hasTvModule, currentShell } = await import('../src/compat/shell')
      expect(currentShell()).toBe('tv')
      expect(isTvShell()).toBe(true)
      expect(hasTvModule()).toBe(false)
    } finally {
      delete (window as any).meowTv
    }
  })

  it('新壳有 moduleCheck：身份与能力都为真', async () => {
    delete document.documentElement.dataset.shell
    ;(window as any).meowTv = { platform: () => 'tv', moduleCheck: () => '{}' }
    try {
      const { isTvShell, hasTvModule } = await import('../src/compat/shell')
      expect(isTvShell()).toBe(true)
      expect(hasTvModule()).toBe(true)
    } finally {
      delete (window as any).meowTv
    }
  })

  it('data-shell=fpk 时不再算 TV（fnOS 页面是 web 壳的能力分支）', async () => {
    document.documentElement.dataset.shell = 'fpk'
    try {
      const { isTvShell, isDesktopShell, currentShell } = await import('../src/compat/shell')
      expect(currentShell()).toBe('fpk')
      expect(isTvShell()).toBe(false)
      expect(isDesktopShell()).toBe(false)
    } finally {
      delete document.documentElement.dataset.shell
    }
  })
})
