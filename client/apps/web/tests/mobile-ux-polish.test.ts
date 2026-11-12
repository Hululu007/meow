import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 2026-11-12 移动端（竖屏）/通用样式的五条改动，逐条锁死。
 *
 * 用户原话：
 * 1. "聚焦圆环 竖屏设备默认不要显示（除非接入键盘 方向键控制后显示）"
 * 2. "移动端播放器左上角的返回按钮，显隐逻辑对齐底部控制栏（目前播放中还显示）"
 * 3. "右上角弹框点开后，滑动页面也应该隐藏关闭"
 * 4. "播放器页面底栏应该加遮罩（类似直播页左侧弹窗那种）"
 * 5. "直播页左侧弹窗…怎么自适应弹窗宽度或对分类右侧、台列表右侧加拖拽"
 *
 * 这些都是**结构性约束**（哪条样式在、哪个监听在、哪个按钮被删了），
 * 跑真实界面要设备/指针事件，不适合进单测；读源码断言改坏了立刻红。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const WEB = join(ROOT, 'client', 'apps', 'web')
const read = (p: string) => readFileSync(join(WEB, p), 'utf8')

describe('① 触屏设备默认不画焦点环', () => {
  const modPath = 'src/compat/inputModality.ts'

  it('有输入方式嗅探模块，并在 main.ts 里首屏前安装', () => {
    expect(existsSync(join(WEB, modPath))).toBe(true)
    const mod = read(modPath)
    // 默认值看触摸点数：TV 的 WebView 没有触摸点 → 默认 key（行为不变）
    expect(mod).toContain('navigator.maxTouchPoints')
    expect(mod).toContain("apply('touch')")
    expect(mod).toContain("apply('key')")
    // 只认导航键：打字的字母数字不该把环唤出来
    expect(mod).toContain('ArrowUp')
    expect(mod).toContain('ArrowRight')
    expect(mod).toContain('NAV_KEYS')
    // capture 阶段监听（tv-nav 会 stopPropagation）：第三个参数是 true
    expect(/window\.addEventListener\(\s*'keydown'[\s\S]{0,400}?true,?\s*\)/.test(mod)).toBe(true)

    const main = read('src/main.ts')
    expect(main).toContain("import './compat/inputModality'")
    // 必须排在 createApp 之前
    expect(main.indexOf("import './compat/inputModality'")).toBeLessThan(main.indexOf('createApp'))
  })

  it('行为：默认按设备定，pointerdown 切 touch，方向键切 key', async () => {
    // jsdom 里 maxTouchPoints = 0 → 默认 key（真电视同样是 0，行为不变）
    await import('../src/compat/inputModality')
    const root = document.documentElement
    expect(root.getAttribute('data-input')).toBe('key')

    // 触摸/鼠标按下 → 收起环
    root.removeAttribute('data-input')
    window.dispatchEvent(new Event('pointerdown'))
    expect(root.getAttribute('data-input')).toBe('touch')

    // 方向键 → 环回来（接了键盘的平板/电视盒子）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(root.getAttribute('data-input')).toBe('key')

    // 打字的字母不该把环唤出来
    window.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(root.getAttribute('data-input')).toBe('touch')
  })

  it('tokens.css 在 data-input=touch 时把环全部关掉（含胶囊条/分段控件/弹层）', () => {
    const css = read('src/styles/tokens.css')
    expect(css).toContain("html[data-input='touch'] .meow-tv-focus")
    expect(css).toContain("html[data-input='touch'] .cat-chips .meow-tv-focus")
    expect(css).toContain("html[data-input='touch'] .seg-group .meow-tv-focus")
    expect(css).toContain("html[data-input='touch'] [data-tv-scope] .meow-tv-focus")
    // 必须 !important：tv-nav 注入的规则本身带 !important
    const rule = css.slice(css.indexOf("html[data-input='touch'] .meow-tv-focus"))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('box-shadow: none !important')
    expect(body).toContain('outline: none !important')
  })
})

describe('② 播放器返回键跟随底部控制栏', () => {
  const player = read('src/components/player/VideoPlayer.vue')

  it('不再有常驻的浮层返回键', () => {
    expect(player).not.toContain('showFloatingBack')
    expect(player).not.toContain('全屏 + 控制栏收起时的返回键')
  })

  it('返回键仍由 showBackButton 控制（手机有、真电视没有）', () => {
    expect(player).toContain('const showBackButton = computed')
    expect(player).toContain('v-if="showBackButton"')
  })
})

describe('③ 顶栏「更多」菜单滑动即收起', () => {
  const header = read('src/components/layout/AppHeader.vue')

  it('注册了 document 的 capture 滚动监听，并成对移除', () => {
    expect(header).toContain('function onDocScroll')
    expect(header).toContain("document.addEventListener('scroll', onDocScroll, { capture: true, passive: true })")
    expect(header).toContain("document.removeEventListener('scroll', onDocScroll")
    // remove 必须带 capture，否则移除不掉（capture 参与匹配）
    expect(header).toContain('capture: true } as EventListenerOptions')
  })

  it('滚动时收起「更多」，站点下拉开着时不动它自己的滚动', () => {
    const fn = header.slice(header.indexOf('function onDocScroll'))
    const body = fn.slice(0, fn.indexOf('\n}'))
    expect(body).toContain('showMore.value = false')
    expect(body).toContain("closest('[data-site-menu]')")
  })
})

describe('④ 播放器底栏遮罩', () => {
  const player = read('src/components/player/VideoPlayer.vue')
  const css = read('src/styles/tokens.css')

  it('底栏用 .meow-ctrl-mask，且渐变底部接近全黑', () => {
    expect(player).toContain('meow-ctrl-bar meow-ctrl-mask absolute inset-x-0 bottom-0')
    const i = css.indexOf('.meow-ctrl-mask')
    expect(i).toBeGreaterThan(0)
    const block = css.slice(i, css.indexOf('}', i))
    expect(block).toContain('linear-gradient')
    expect(block).toContain('rgba(0, 0, 0, 0.96)')
    // 顶部要完全透明，否则底栏上沿会有一条硬边
    expect(block).toContain('rgba(0, 0, 0, 0) 100%')
  })

  it('不用 backdrop-filter（播放中每帧全宽模糊，Chromium 66 会掉帧）', () => {
    const i = css.indexOf('.meow-ctrl-mask')
    const block = css.slice(i, css.indexOf('}', i))
    expect(block).not.toContain('backdrop-filter')
  })
})

describe('⑥ 真全屏时浮层仍可见（Teleport 目标跟随 fullscreenElement）', () => {
  it('有 useOverlayHost：监听 fullscreenchange 并切换目标', () => {
    const path = 'src/composables/useOverlayHost.ts'
    expect(existsSync(join(WEB, path))).toBe(true)
    const mod = read(path)
    expect(mod).toContain('document.fullscreenElement')
    expect(mod).toContain("document.addEventListener('fullscreenchange', sync)")
    expect(mod).toContain("document.removeEventListener('fullscreenchange', sync)")
    // 退出全屏要回到 body
    expect(mod).toContain("|| 'body'")
  })

  it('直播指南面板不再硬编码 to="body"', () => {
    const live = read('src/views/LiveView.vue')
    expect(live).toContain('useOverlayHost')
    expect(live).toContain(':to="guideOverlayHost"')
    // 全屏容器里时，若还写死 body 就整块画不出来（2026-11-12 实测）
    expect(live.includes('<Teleport to="body">')).toBe(false)
  })
})

describe('⑤ 直播「分类-台」面板：自适应 + 可拖拽', () => {
  const live = read('src/views/LiveView.vue')

  it('左列按内容自适应（w-max + 46% 上限），长名字有 title 可看全', () => {
    expect(live).toContain('relative flex w-max min-w-[7.5rem] max-w-[46%] flex-col')
    expect(live).toContain(':title="g.group"')
    expect(live).toContain(':title="ch.name"')
  })

  it('面板与两列之间各有一个拖拽条，尺寸记 localStorage', () => {
    expect(live).toContain('data-guide-panel')
    expect(live).toContain('data-guide-side')
    expect(live).toContain('startGuidePanelResize')
    expect(live).toContain('startGuideSplitResize')
    expect(live).toContain("const GUIDE_W_KEY = 'meow.live.guideW'")
    expect(live).toContain("const GUIDE_SPLIT_KEY = 'meow.live.guideSplitW'")
    // 拖拽过程中拿 window 的 pointermove（TV 没有指针事件，天然不触发）
    expect(live).toContain("window.addEventListener('pointermove', move)")
  })

  it('拖分界时面板一起变宽，右列台列表宽度不被挤压', () => {
    const i = live.indexOf('function startGuideSplitResize')
    expect(i).toBeGreaterThan(0)
      const body = live.slice(i, i + 1200)
    // 起始时记住右列宽度
    expect(body).toContain('startPanelW')
    expect(body).toContain('rightW')
    // 每次移动：左列 = left，面板 = left + 右列
    expect(body).toContain('guideSplitW.value = left')
    expect(body).toContain('guidePanelW.value = left + rightW')
    // 面板宽度也要落盘，否则重开又按默认 w-1/3 挤压右列
    expect(body).toContain('saveGuideSize(GUIDE_W_KEY')
  })

  it('拖拽条样式带 touch-action:none（否则手机按下会被当成滚动）', () => {
    const i = live.indexOf('.guide-resize {')
    expect(i).toBeGreaterThan(0)
    const block = live.slice(i, live.indexOf('}', i))
    expect(block).toContain('touch-action: none')
    expect(block).toContain('cursor: col-resize')
  })
})
