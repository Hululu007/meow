import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isScoreRemarks } from '../src/utils/remarks'

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

describe('② 返回键显隐按设备形态（大屏横屏且无鼠标才隐藏）', () => {
  it('手机/PC 显示；TV/投影仪（大屏横屏、无鼠标）隐藏', async () => {
    const { isBigScreenLandscape } = await import('../src/compat/deviceForm')
    const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const mm = window.matchMedia
    const set = (w: number, h: number, fine: boolean) => {
      Object.defineProperty(window, 'innerWidth', { value: w, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true })
      window.matchMedia = ((q: string) => ({ matches: q.includes('fine') ? fine : false })) as any
    }
    try {
      set(1366, 720, true) // PC
      expect(isBigScreenLandscape()).toBe(false)
      set(390, 844, false) // 手机竖屏
      expect(isBigScreenLandscape()).toBe(false)
      set(844, 390, false) // 手机横屏（短边 < 480）
      expect(isBigScreenLandscape()).toBe(false)
      set(960, 540, false) // TV / 投影仪
      expect(isBigScreenLandscape()).toBe(true)
      set(960, 540, true) // 接了鼠标的电视/模拟器按 PC 处理
      expect(isBigScreenLandscape()).toBe(false)
    } finally {
      if (iw) Object.defineProperty(window, 'innerWidth', iw)
      if (ih) Object.defineProperty(window, 'innerHeight', ih)
      window.matchMedia = mm
    }
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
    // 按钮行落在整条栏 25%~50% 高度处，这一段不透明度低于 0.86 时亮场景下按钮背后会透出画面
    expect(block).toContain('rgba(0, 0, 0, 0.86) 50%')
    // 顶部要完全透明，否则底栏上沿会有一条硬边
    expect(block).toContain('rgba(0, 0, 0, 0) 100%')
    // 高度来源是控制栏 padding（渐变靠 padding 撑开）
    expect(player).toContain('pb-2.5 pt-16 sm:px-5 sm:pb-4 sm:pt-20')
  })

  it('封面上的浮层不用主题墨色（浅色主题下深字压黑底 = 看不见）', () => {
    // 2026-11-12 实测：浅色主题 --color-ink-2 = #4a5262，压在 bg-black/65 上不可读
    for (const f of ['src/views/HistoryView.vue', 'src/views/FavoritesView.vue']) {
      for (const line of read(f).split('\n')) {
        if (!line.includes('bg-black/')) continue
        expect(line).not.toMatch(/text-ink\b|text-ink-2|text-ink-3/)
      }
    }
  })

  it('海报角标样式唯一：四处都用 .poster-badge（白字 + 同一个角）', () => {
    // 2026-11-12 用户报「首页集数看不清、和历史的还不一样」：
    // 首页原来是 text-accent + 左上，历史/收藏/搜索是白字 + 左下。
    expect(read('src/styles/tokens.css')).toContain('.poster-badge')
    for (const f of [
      'src/components/common/PosterCard.vue',
      'src/views/HistoryView.vue',
      'src/views/FavoritesView.vue',
      'src/views/SearchView.vue',
    ]) {
      expect(read(f), f).toContain('poster-badge')
    }
    // 角标不许再用主题色（海报是任意图片，accent 没有可见性保证）
    expect(read('src/components/common/PosterCard.vue')).not.toMatch(
      /poster-badge[^"]*text-(accent|ink)/,
    )
  })

  it('评分在右上、集数在左下（用户 2026-11-12 口径）', () => {
    const css = read('src/styles/tokens.css')
    expect(css).toContain('.poster-badge--score')
    // 四个渲染点都要能区分评分：评分挂 --score，其余留在左下
    for (const f of [
      'src/components/common/PosterCard.vue',
      'src/views/HistoryView.vue',
      'src/views/FavoritesView.vue',
      'src/views/SearchView.vue',
    ]) {
      expect(read(f), f).toMatch(/isScoreRemarks|posterBadges/)
      expect(read(f), f).toContain('poster-badge--score')
    }
    // 判据只认一位小数的纯数字：整数（第 12 集）不能被当成评分挪到右上
    expect(isScoreRemarks('8.8')).toBe(true)
    expect(isScoreRemarks('30集全')).toBe(false)
    expect(isScoreRemarks('12')).toBe(false)
    expect(isScoreRemarks('更新至15集')).toBe(false)
  })

  it('控制栏文字固定白色系（浅色主题下 text-ink 是深色，会糊在遮罩里）', () => {
    const css = read('src/styles/tokens.css')
    expect(css).toContain('.meow-player-root .text-ink')
    expect(css).toContain('rgba(255, 255, 255, 0.92)')
    expect(css).toContain('.meow-player-root .text-ink-3')
    // 播放器根节点必须挂这个类，否则覆盖不生效
    const player = read('src/components/player/VideoPlayer.vue')
    expect(player).toContain('meow-player-root group relative h-full w-full')
  })

  it('不用 backdrop-filter（播放中每帧全宽模糊，Chromium 66 会掉帧）', () => {
    const i = css.indexOf('.meow-ctrl-mask')
    const block = css.slice(i, css.indexOf('}', i))
    expect(block).not.toContain('backdrop-filter')
  })
})

describe('⑦ 竖屏直播页：返回键跟底栏同显隐 + 面板里不显示方向键提示', () => {
  const live = read('src/views/LiveView.vue')

  it('有 showLiveBack：播放中 + 控制栏可见 + 面板未开 + 触屏（真电视不给）', () => {
    const i = live.indexOf('const showLiveBack = computed(')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 400)
    expect(body).toContain('current.value')
    expect(body).toContain('showCtrl.value')
    // 面板改成浮动卡片后不再遮住左上角，返回键不必让位
    expect(body).not.toContain('!showGuide.value')
    expect(body).toContain('isTouch.value')
    expect(body).toContain('compactViewport.value')
  })

  it('只在竖屏显示，且挂载即开始 5 秒自动收起（否则常量常驻）', () => {
    const i = live.indexOf('const showLiveBack = computed(')
    const body = live.slice(i, i + 400)
    expect(body).toContain('!landscape.value')
    // 冷启动时 showCtrl 初始 true，必须靠挂载时的 wake() 排上收起计时
    const m = live.indexOf('onMounted(() => {')
    const mount = live.slice(m, m + 300)
    expect(mount).toContain('wake()')
  })

  it('按钮贴在左上角安全区，点了走 leaveLive', () => {
    const i = live.indexOf('v-if="showLiveBack"')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 700)
    expect(body).toContain('env(safe-area-inset-left)')
    expect(body).toContain('env(safe-area-inset-top)')
    expect(body).toContain('@click="leaveLive"')
    expect(body).toContain('aria-label="返回"')
  })

  it('「分类-台」是浮起来的圆角卡片（竖屏顶部留出返回键的位置）', () => {
    expect(live).toContain('overflow-hidden rounded-xl border border-white/10 bg-black/75')
    // 横屏贴边、竖屏顶部留 3.5rem（返回键 48px 高 + 8px 间隙）
    expect(live).toContain('top-14 bottom-3')
    expect(live).toContain('top-3 bottom-3')
    // 不再贴着左/上边缘（原来 inset-y-0 left-0 把返回键压在下面）
    expect(live).not.toContain('absolute inset-y-0 left-0 flex w-1/3')
  })

  it('ESC = 返回：面板→全屏→调试面板→离开页面，逐层退出', () => {
    const i = live.indexOf('ESC 的优先级')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 700)
    expect(body).toContain('toggleFullscreen()')
    expect(body).toContain('debugOn.value')
    expect(body).toContain('leaveLive()')
    // 面板开着时由 guide 分支先吃掉了 ESC，不会走到这里直接退页
    expect(live).toContain('showGuide.value = false')
  })

  it('方向键提示只给非触屏设备；手机上行内提示整条不渲染', () => {
    expect(live).toContain('v-if="!isTouch"')
    expect(live).not.toContain('v-if="!isTouch || stats || guideSrcHint"')
    expect(live).toContain('<span v-if="!isTouch">←→ 换列')
    // 方向键文案不能再是无条件文本
    expect(live.includes('          ←→ 换列')).toBe(false)
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

  it('右侧面板下拖分界改的是右列宽度（左列固定），分界线才会跟着指针走', () => {
    const i = live.indexOf('function startGuideSplitResize')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 1400)
    // 起始时记住左列/右列/面板宽度
    expect(body).toContain('startPanelW')
    expect(body).toContain('startRight')
    // 面板贴右缘：分界 x = 右边缘 − 右列宽 → 必须改右列，左列守住
    expect(body).toContain('guideSplitW.value = leftW')
    expect(body).toContain('guidePanelW.value = leftW + right')
    expect(body).toContain('startRight - (ev.clientX - startX)')
    // 面板宽度也要落盘，否则重开又按默认 w-1/3
    expect(body).toContain('saveGuideSize(GUIDE_W_KEY')
  })

  it('面板贴右缘：拖左边缘调整宽度，位移取反（向右拖 = 变窄）', () => {
    const i = live.indexOf('function startGuidePanelResize')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 800)
    expect(body).toContain('startW + startX - ev.clientX')
    expect(live).toContain('.guide-resize--edge {')
    expect(live).toContain('left: 0;')
  })

  it('拖拽条样式带 touch-action:none（否则手机按下会被当成滚动）', () => {
    const i = live.indexOf('.guide-resize {')
    expect(i).toBeGreaterThan(0)
    const block = live.slice(i, live.indexOf('}', i))
    expect(block).toContain('touch-action: none')
    expect(block).toContain('cursor: col-resize')
  })
})
