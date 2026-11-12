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
    // 默认值按方向：横屏 = key（MuMu 模拟器也有触摸点，不能只看 maxTouchPoints）
    expect(mod).toContain('function defaultMode')
    expect(mod).toContain('function isLandscape')
    expect(mod).toContain('window.innerWidth >= window.innerHeight')
    expect(mod).toContain("if (isLandscape()) return 'key'")
    expect(mod).toContain('function portraitTouch')
    expect(mod).toContain('navigator.maxTouchPoints')
    expect(mod).toContain("apply('touch')")
    expect(mod).toContain('applyKey')
    expect(mod).toContain("portraitTouch() ? 'touch' : 'key'")
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

  it('竖屏触屏按方向键也不画环（77 竖屏仍有环的回归）', async () => {
    await import('../src/compat/inputModality')
    const root = document.documentElement
    const iw = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const ih = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const mt = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 1, configurable: true })
    try {
      root.setAttribute('data-input', 'key')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      expect(root.getAttribute('data-input')).toBe('touch')
      // 旋转成竖屏也要把已画的环收掉
      root.setAttribute('data-input', 'key')
      window.dispatchEvent(new Event('resize'))
      expect(root.getAttribute('data-input')).toBe('touch')
    } finally {
      if (iw) Object.defineProperty(window, 'innerWidth', iw)
      if (ih) Object.defineProperty(window, 'innerHeight', ih)
      if (mt) Object.defineProperty(navigator, 'maxTouchPoints', mt)
    }
  })

  it('TV 壳的遥控按键显式切 key：原生直调 JS 不产生 DOM keydown，否则环永远不出现', () => {
    const nav = readFileSync(
      join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
      'utf8',
    )
    const i = nav.indexOf('window.__meowTvNav = function')
    expect(i).toBeGreaterThan(0)
    const body = nav.slice(i, i + 1400)
    expect(body).toContain("setAttribute('data-input', 'key')")
    // 竖屏不切 key（手机/竖放模拟器用户要求不显示焦点环）
    expect(body).toContain('window.innerWidth >= window.innerHeight')
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

  it('浅色卡片（倍速/搜索弹幕）保留主题色，深色胶囊统一白字', () => {
    const css = read('src/styles/tokens.css')
    expect(css).toContain('.meow-player-root .meow-light-card')
    expect(css).toContain('color: var(--color-ink)')
    expect(css).toContain('.meow-on-dark')
    // 两块浅色卡片必须挂上逃生舱类，否则白字压白底
    expect(read('src/components/player/RateSelect.vue')).toContain('meow-light-card')
    expect(read('src/components/player/VideoPlayer.vue')).toContain('bg-elevated p-3.5 meow-light-card')
    // 续播提示条是黑底胶囊，必须白字
    expect(read('src/views/PlayView.vue')).toContain('text-ink meow-on-dark')
  })

  it('不用 backdrop-filter（播放中每帧全宽模糊，Chromium 66 会掉帧）', () => {
    const i = css.indexOf('.meow-ctrl-mask')
    const block = css.slice(i, css.indexOf('}', i))
    expect(block).not.toContain('backdrop-filter')
  })
})

describe('⑦ 直播页：返回键跟面板同显隐 + 信号源可导航 + 面板里不显示方向键提示', () => {
  const live = read('src/views/LiveView.vue')

  it('有 showLiveBack：真电视不给；其余（PC/Web/竖屏）与面板同显隐，不常驻', () => {
    const i = live.indexOf('const showLiveBack = computed(')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 500)
    expect(body).toContain('current.value')
    expect(body).toContain('!isBigScreenLandscape()')
    // ★ 2026-11-12 用户口径：PC/Web 也不常驻——返回键和面板同时显示/消失。
    // 面板已挪到右侧，宽屏上左按钮/右面板互不遮挡。
    expect(body).toContain('showGuide.value')
    expect(body).not.toContain('!isTouch.value')
    expect(body).not.toContain('!landscape.value')
    expect(body).not.toContain('showCtrl.value')
  })

  it('顶部「信号源」行进方向键导航：分类首行再↑进入，↓到底回分类，Enter 切源并收起面板', () => {
    // 列类型必须包含 source，否则 ↑↓ 永远只在 group/channel 两列里打转
    expect(live).toContain("const guideColumn = ref<'source' | 'group' | 'channel'>")
    expect(live).toContain('const guideSource = ref(0)')
    expect(live).toContain('function guideMoveSource(')
    // 分类第一条再往上
    expect(live).toContain("guideColumn.value = 'source'")
    expect(live).toContain('guideSource.value = playlists.value.length - 1')
    // 行本身要可定位、有光标样式、文案说清是「换源」
    expect(live).toContain('data-guide-col="source"')
    expect(live).toContain("guideColumn === 'source' && guideSource === pi")
    expect(live).toContain('信号源')
    expect(live).toContain("'换源'")
    // Enter：切源并收起（切完旧坐标失效）
    const i = live.indexOf('async function guideOk()')
    const body = live.slice(i, i + 900)
    expect(body).toContain("if (guideColumn.value === 'source')")
    expect(body).toContain('showGuide.value = false')
    expect(body).toContain('await openPlaylist(p)')
  })

  it('面板在右侧；宽屏不留顶部空档，窄屏才给返回键让出 3.5rem', () => {
    // 返回键显隐按"大屏横屏 + 无鼠标"形态判断，不靠 UA
    expect(live).toContain("from '@/compat/deviceForm'")
    expect(live).toContain('isBigScreenLandscape()')
    expect(live).not.toContain('const isTrueTv = computed(')
    // 面板改到右侧（2026-11-12 用户要求），且不再压住左上角返回键
    expect(live).toContain('absolute right-3 flex w-1/3')
    expect(live).not.toContain('absolute left-3 flex w-1/3')
    // 横屏上下对称 12px（返回键已在左侧）；竖屏才留 top-14 给返回键，
    // 底部还要让开手机底部标签栏（--tabbar-clear，2026-11-12 直播成为一级入口）
    expect(live).toMatch(/landscape\s*\?\s*'top-3 bottom-3'/)
    expect(live).toContain("'top-14 bottom-[calc(0.75rem+var(--tabbar-clear))]'")
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
    // 必须在面板遮罩内部（页面根的 stacking context 压不过 body 上的遮罩），
    // 且 click.stop 防止冒泡到遮罩的"点空白关面板"
    expect(body).toContain('@click.stop="leaveLive"')
    expect(body).toContain('aria-label="返回"')
  })

  it('「分类-台」是贴右缘的浮起圆角卡片；窄屏顶部留出返回键的位置', () => {
    expect(live).toContain('overflow-hidden rounded-xl border border-white/10 bg-black/75')
    // 宽屏贴右/上/下边；窄屏顶部留 3.5rem（返回键 48px 高 + 8px 间隙），
    // 底部让开标签栏
    expect(live).toContain("top-14 bottom-[calc(0.75rem+var(--tabbar-clear))]")
    expect(live).toContain('top-3 bottom-3')
    expect(live).toContain('absolute right-3')
    // 不再贴着左/上边缘（原来 inset-y-0 left-0 把返回键压在下面）
    expect(live).not.toContain('absolute inset-y-0 left-0 flex w-1/3')
  })

  it('首尾焦点环完整：列表纵向留 14px + scroll-padding 16px，信号源块也不贴边', () => {
    // 外环 2px + 12px 辉光 = 14px；内边距 16px 留 2px 余量
    expect(live).toContain('guide-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4')
    expect(live).toContain('scroll-padding-block: 16px')
    // 信号源行也在 overflow-hidden 的面板里：横向同样要留够
    expect(live).toContain('border-b border-white/10 px-4 pb-4')
  })

  it('打开面板时把当前分类/台滚到列表靠前（不能只靠 watch，首次不触发）', () => {
    const i = live.indexOf('function openGuide()')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 1600)
    expect(body).toContain("scrollGuideColIntoView('group', 'start')")
    expect(body).toContain("scrollGuideColIntoView('channel', 'start')")
    expect(live).toContain('function scrollGuideColIntoView(')
  })

  it('全屏退出键在面板打开时隐藏（避免和面板返回键叠在同一位置）', () => {
    const i = live.indexOf('const showExitFsButton = computed(')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 400)
    expect(body).toContain('!showGuide.value')
  })

  it('返回点击有 WebView 兜底：history.back 空操作时 260ms 后 replace 首页', () => {
    const i = live.indexOf('function leaveLive()')
    expect(i).toBeGreaterThan(0)
    const body = live.slice(i, i + 700)
    expect(body).toContain('router.currentRoute.value.fullPath')
    expect(body).toContain("router.replace('/')")
    expect(body).toContain('260')
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
