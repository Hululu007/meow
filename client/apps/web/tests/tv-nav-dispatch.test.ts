import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 直接把 TV 壳的真实 tv-nav.js 加载进 jsdom，验证按键分派。
 *
 * 为什么必须跑真脚本而不是断言源码：问题2 的 bug 就藏在"按键到底有没有
 * 转发给播放器"这条运行时路径里，源码里看不出对错 —— 上游修改过三次，
 * 每次都是"看着对、跑起来不对"。
 */
const TV_NAV_SRC = readFileSync(
  join(__dirname, '..', '..', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)

type Win = Window & { __meowTvNav?: (a: string) => boolean }

/** 装一个干净页面，并把 tv-nav 注入进去 */
function bootTvNav(html: string): Win {
  document.body.innerHTML = html
  // 脚本是 IIFE，靠 window/document；用 eval 在同一个 realm 里执行
  // eslint-disable-next-line no-new-func
  new Function(TV_NAV_SRC)()
  return window as Win
}

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>'
  // tv-nav 会往 head 里塞 <style>，上一个用例的不清会累积
  document.querySelectorAll('#meow-tv-focus-style').forEach((e) => e.remove())
})

afterEach(() => {
  delete (window as any).__meowTvNav
  delete (window as any).__meowTvFocus
  delete (window as any).__meowTvDispose
  delete (window as any).__meowTvKeyOwner
})

/** 给元素一个非零几何：jsdom 默认全是 0×0，visible() 会判它不可见 */
function giveBox(el: Element, w = 100, h = 40, top = 200, left = 100): void {
  ;(el as HTMLElement).getBoundingClientRect = () =>
    ({ x: left, y: top, top, left, width: w, height: h, right: left + w, bottom: top + h, toJSON: () => ({}) }) as DOMRect
}

describe('tv-nav：播放器独占方向键时，按键必须真的转发给播放器', () => {
  it('没有焦点框 → ArrowDown 派发到页面，播放器能收到', () => {
    const w = bootTvNav('<div id="wrap"><button id="a">a</button></div>')
    giveBox(document.getElementById('a')!)
    ;(window as any).__meowTvKeyOwner = true

    const seen: string[] = []
    document.addEventListener('keydown', (e) => seen.push(e.key))

    w.__meowTvNav!('down')
    expect(seen).toContain('ArrowDown')
  })

  it('★ 焦点框残留在**不可见**元素上时，ArrowDown 仍要转发（本轮修复）', () => {
    /*
     * 用户报的"偶尔按向下键唤不出控制栏"就是这个场景：
     * 控制栏 5s 自动收起后，.meow-tv-focus 会短暂留在已隐藏的底栏按钮上。
     * 旧实现用裸 querySelector，看到 class 在就直接把按键吃去移焦点，
     * 播放器永远收不到 ArrowDown → 控制栏再也唤不出来。
     */
    const w = bootTvNav(
      '<div id="wrap"><div style="visibility:hidden"><button id="hidden">h</button></div></div>',
    )
    const hidden = document.getElementById('hidden')!
    giveBox(hidden)
    hidden.classList.add('meow-tv-focus')
    ;(window as any).__meowTvKeyOwner = true

    const seen: string[] = []
    document.addEventListener('keydown', (e) => seen.push(e.key))

    w.__meowTvNav!('down')
    expect(seen).toContain('ArrowDown')
  })

  it('焦点框在**可见**元素上时，方向键交给焦点移动，不转发', () => {
    const w = bootTvNav(
      '<div id="wrap"><button id="a">a</button><button id="b">b</button></div>',
    )
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    giveBox(a, 100, 40, 200, 100)
    giveBox(b, 100, 40, 200, 300)
    a.classList.add('meow-tv-focus')
    ;(window as any).__meowTvKeyOwner = true

    const seen: string[] = []
    document.addEventListener('keydown', (e) => seen.push(e.key))

    w.__meowTvNav!('right')
    // 右移成功，且没有把 ArrowRight 派发给页面（否则播放器会去 seek）
    expect(b.classList.contains('meow-tv-focus')).toBe(true)
    expect(seen).not.toContain('ArrowRight')
  })

  it('display:none 里的残留焦点框同样被视为没有焦点', () => {
    const w = bootTvNav(
      '<div id="wrap"><div style="display:none"><button id="hidden">h</button></div></div>',
    )
    const hidden = document.getElementById('hidden')!
    // ★ 不调 giveBox：浏览器对 display:none 子树返回全 0 的 rect，
    //   jsdom 默认也是 0×0，正好还原真实情况（宽度 <2 → visible() 为 false）
    hidden.classList.add('meow-tv-focus')
    ;(window as any).__meowTvKeyOwner = true

    const seen: string[] = []
    document.addEventListener('keydown', (e) => seen.push(e.key))

    w.__meowTvNav!('up')
    expect(seen).toContain('ArrowUp')
  })

  it('ok 键在无焦点时派发 Enter（播放器据此暂停/播放）', () => {
    const w = bootTvNav('<div id="wrap"><p>stage</p></div>')
    ;(window as any).__meowTvKeyOwner = true
    const seen: string[] = []
    document.addEventListener('keydown', (e) => seen.push(e.key))
    w.__meowTvNav!('enter')
    expect(seen).toContain('Enter')
  })
})
