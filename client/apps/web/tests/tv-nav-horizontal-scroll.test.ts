/**
 * 2026-11-10 用户报：TV 首页分类胶囊按右键到「欧美剧」后焦点出界，看不见所选。
 *
 * 根因有两层：
 *  1. tv-nav 的 `scrollIntoViewWithin()` 只处理 `overflow-y`，横向滚动容器
 *     （分类胶囊 `overflow-x-auto`）完全不滚；
 *  2. tv-nav 移焦是"加 class"而不是 `focus()`，HomeView 原来只监听 focusin
 *     做居中，遥控器场景永远收不到。
 *
 * 这里按源码契约锁住两处修复，避免以后重构又退回去。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(__dirname, '..', '..', '..', '..')
const TV_NAV = join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js')
const HOME = join(REPO, 'client', 'apps', 'web', 'src', 'views', 'HomeView.vue')

/** 取一个顶层函数的函数体（按大括号配平）。 */
function fnBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  if (at < 0) throw new Error(`找不到 ${signature}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${signature} 的大括号没有闭合`)
}

describe('TV 横向滚动容器：焦点必须滚进可视区', () => {
  const nav = readFileSync(TV_NAV, 'utf8')
  const body = fnBody(nav, 'function scrollIntoViewWithin(')

  it('逐层滚动时检查 overflow-x（不能只看 overflow-y）', () => {
    expect(body).toContain('st.overflowX')
    expect(body).toMatch(/scrollableX/)
    expect(body).toContain('node.scrollLeft')
  })

  it('横向余量至少覆盖焦点环的外扩（2px + 12px）', () => {
    expect(body).toMatch(/padX\s*=\s*1[6-9]/)
  })
})

describe('首页分类胶囊：遥控器移焦要居中', () => {
  const home = readFileSync(HOME, 'utf8')

  it('监听 tv-nav 的 meow:tv-focus（只监听 focusin 不够）', () => {
    expect(home).toContain("addEventListener('meow:tv-focus', onTvFocus)")
    expect(home).toContain("removeEventListener('meow:tv-focus', onTvFocus)")
  })

  it('从全局高亮元素里只取分类胶囊', () => {
    expect(home).toContain("document.querySelector('.cat-chips .meow-tv-focus')")
  })
})
