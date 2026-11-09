/**
 * 遥控器菜单键的上下文动作。
 *
 * 为什么用"页面注册、全局收起"而不是给每个卡片加按钮：
 *   电视上卡片本身就是一个大按钮，焦点在它上面时按菜单键是唯一自然的
 *   "对这张卡片还能做什么"的入口；把「移除 / 详情」做成卡片上的第二个
 *   可聚焦元素，会让上下左右多出一层跳跃，选片反而变慢。
 *
 * provider 由页面提供（只有页面知道焦点在哪张卡片上），
 * TvActionSheet 只负责渲染与焦点，不猜任何业务。
 */
import { shallowRef } from 'vue'

export interface TvMenuAction {
  label: string
  hint?: string
  run: () => void
}

export interface TvMenuProvider {
  /** 面板标题，通常是片名 */
  title: string
  actions: TvMenuAction[]
}

const cur = shallowRef<TvMenuProvider | null>(null)

/**
 * 页面级处理器：只有页面知道"焦点这张卡片"是什么、能对它做什么。
 * 同一时刻只有一个页面在路由上，所以单个槽位足够；卸载时清空。
 */
type Handler = (focused: Element | null) => TvMenuProvider | null
let handler: Handler | null = null

export function registerTvMenuHandler(fn: Handler): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

/**
 * 菜单键触发：无处理器或无当前卡片时什么都不做（不弹空面板）。
 *
 * 顺序：先问页面级钩子，再走 provider。
 *
 * 为什么要有钩子这一层：有些页面对菜单键的期望不是"弹出动作面板"，
 * 而是"把焦点送回某处"——设置页就是这样（用户要求：在右侧内容区按菜单键
 * 要聚焦到左侧菜单栏首位）。而壳的菜单键不经过 `dispatchKeyEvent`，
 * 页面收不到 keydown，只能靠这条约定链。
 *
 * 钩子返回 true 表示"这次菜单键我处理了"，不再弹面板。
 */
export function openTvMenuFor(focused: Element | null): void {
  const hook = (window as unknown as { __meowTvMenuHook?: () => boolean })
    .__meowTvMenuHook
  if (typeof hook === 'function') {
    try {
      if (hook()) return
    } catch {
      /* 钩子出错就走正常 provider，别让菜单键彻底失效 */
    }
  }
  const p = handler?.(focused)
  if (p && p.actions.length) {
    cur.value = p
    return
  }
  /*
   * 兜底：当前上下文没有卡片动作时，菜单键打开 AI 助手。
   *
   * 用户需求（2026-10-30）：「分析菜单按键绑定效果。是否能够绑定AI助手弹框弹出」。
   *
   * 为什么这个兜底合理：菜单键在电视上是"对当前焦点还能做什么"。
   * 坐在海报上时有「继续播放 / 打开详情 / 移除」；而坐在分类条、
   * 设置页空白处、顶栏图标上时原本**什么都不会发生**（实测 6 个页面
   * 只有 2 个注册了 provider）。空按键是最让人困惑的体验。
   *
   * 而 AI 助手恰好是"任何页面都可能想用"的通用入口（问片、问为什么播不了），
   * 且它本来就有浮层形态，不需要页面提供上下文。
   *
   * 如果 AI 不可用（播放页隐藏 / 独立页），`__meowAiOpen` 返回 false，
   * 此时仍然什么都不做 —— 与原来的行为一致，不会更差。
   */
  const w = window as unknown as {
    __meowAiOpen?: () => boolean
    __meowAiIsOpen?: () => boolean
    __meowAiClose?: () => void
  }
  if (typeof w.__meowAiOpen !== 'function') return
  // 已经开着 → 收起（电视上同一个键开关，与 __meowTvMenu 的语义一致）
  if (typeof w.__meowAiIsOpen === 'function' && w.__meowAiIsOpen()) {
    try {
      w.__meowAiClose?.()
    } catch {
      /* 收起失败就别管了 */
    }
    return
  }
  try {
    w.__meowAiOpen()
  } catch {
    /* AI 打不开就算了，别让菜单键抛错 */
  }
}

/** 页面在"当前焦点卡片变化"时调用；传 null 表示没有可操作对象 */
export function setTvMenu(p: TvMenuProvider | null): void {
  cur.value = p
}

export function tvMenuIsOpen(): boolean {
  return !!cur.value && cur.value.actions.length > 0
}

export function tvMenuTitle(): string {
  return cur.value?.title || ''
}

export function tvMenuActions(): TvMenuAction[] {
  return cur.value?.actions || []
}

export function closeTvMenu(): void {
  cur.value = null
}

/**
 * 是否该响应这次菜单键。
 *
 * 只在 TV 环境（壳注入了 meowTv 桥）才接管：PC/Web 上菜单键应保持
 * 浏览器默认行为（右键菜单等），抢过来只会让人莫名其妙。
 */
export function isTvShell(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as { meowTv?: { platform?: () => string } }
  return !!w.meowTv && typeof w.meowTv.platform === 'function'
}

/**
 * 把菜单键接到页面上。
 *
 * 壳（MainActivity）只负责把 KEYCODE_MENU 转成 `window.__meowTvMenu()`；
 * "当前焦点是哪张卡片、能对它做什么"由页面回答——壳读不到 Vue 的响应式状态。
 *
 * 判据用 `.meow-tv-focus`（tv-nav 画的那个黄框），它才是用户眼睛看到的选中项；
 * document.activeElement 在 TV 上通常是 body。
 */
export function installTvMenuBridge(): () => void {
  if (typeof window === 'undefined') return () => {}
  const w = window as unknown as { __meowTvMenu?: () => void }
  w.__meowTvMenu = () => {
    const focused = document.querySelector('.meow-tv-focus')
    // 面板已经开着时再按菜单键 = 收起，符合电视"同一键开关"的直觉
    if (cur.value) {
      closeTvMenu()
      return
    }
    openTvMenuFor(focused)
  }
  return () => {
    delete w.__meowTvMenu
  }
}
