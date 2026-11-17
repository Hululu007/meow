/**
 * 壳身份（`data-shell`）的唯一判据。
 *
 * ## 四种壳
 *
 * | 值 | 是什么 | 判据 |
 * |---|---|---|
 * | `tauri` | PC 桌面端 | `__TAURI_INTERNALS__` / `__TAURI__` |
 * | `tv` | TV / 盒子 / 投影 APK | `window.meowTv` 桥，或 UA `MeowTV`（首屏兜底） |
 * | `fpk` | fnOS 应用中心托管页面 | `probeCapability()` 探测到 `/api/_shell/*` + `/app-center/*` |
 * | `web` | 普通浏览器 / Docker | 其余 |
 *
 * ## 为什么只认这四种
 *
 * 「TV」曾经被当成身份 / 无鼠标 / 大屏 / 遥控输入四个含义用，结果 MuMu
 * 竖屏同时满足前两个而违反后两个，补丁叠补丁（`device-adaptive.md` P0-2）。
 * 现在身份只回答「这是哪个壳」，形态/输入/方向分别由 `data-form` /
 * `data-input` / `data-orient` 回答。
 *
 * ## 兼容期
 *
 * `deviceProfile` 会把结果写到 `html[data-shell]`；在没有安装它（单测直接
 * import 组件）时，这里按运行时对象现算，保证结论一致。
 */

import { isMeowTvUa } from './ua'

export type Shell = 'web' | 'tauri' | 'tv' | 'fpk'

/** Tauri 运行时（全局对象由壳注入，页面地址是 http://tauri.localhost） */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as unknown as Record<string, unknown>
  return '__TAURI_INTERNALS__' in w || '__TAURI__' in w
}

/**
 * TV 壳注入的桥对象。
 *
 * 旧 WebView 在没有该接口时**访问属性本身**就可能抛异常，所以必须 try/catch。
 */
function tvBridge(): Record<string, any> | null {
  if (typeof window === 'undefined') return null
  try {
    return (window as unknown as { meowTv?: Record<string, any> }).meowTv || null
  } catch {
    return null
  }
}

/** 有没有 TV 壳的 JS 桥（身份；不看具体方法） */
export function hasTvBridge(): boolean {
  return tvBridge() !== null
}

/**
 * TV 壳是否具备「运行时模块」能力（`moduleCheck`）。
 *
 * ★ 与身份分开：老壳有 `platform` 没有 `moduleCheck`，身份仍是 TV，
 *   但更新中心不该显示「运行时模块」行（D-2，见 device-adaptive.md）。
 */
export function hasTvModule(): boolean {
  const b = tvBridge()
  return !!b && typeof b.moduleCheck === 'function'
}

/** 当前壳身份。优先读 `html[data-shell]`（deviceProfile 算好的）。 */
export function currentShell(): Shell {
  if (typeof document !== 'undefined') {
    const s = document.documentElement.dataset.shell
    if (s === 'web' || s === 'tauri' || s === 'tv' || s === 'fpk') return s
  }
  if (isTauriRuntime()) return 'tauri'
  // UA 只作为首屏兜底：壳注入的 JS 桥晚于首帧脚本，但 UA 在导航时就定了。
  if (hasTvBridge() || isMeowTvUa()) return 'tv'
  return 'web'
}

export function isTvShell(): boolean {
  return currentShell() === 'tv'
}

export function isDesktopShell(): boolean {
  return currentShell() === 'tauri'
}

/**
 * 「TV 外观」判据（CSS 用的 `data-tv`）。
 *
 * 与身份的区别：浏览器里加 `?tv=1` 调试电视布局时，它也为真，
 * 但壳身份仍是 `web`（不要因此显示"TV 专属功能"）。
 * `index.html` 首帧按 UA 写 `data-tv`，deviceProfile 补写漏掉的。
 */
export function isTvEnv(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset.tv === '1'
}

/**
 * 主指针是否精确指针（鼠标 / 触控板）。
 *
 * 给「全屏空闲隐藏光标」这类**输入能力**用：触摸屏笔记本的 `ontouchstart`
 * 为真，但用户可能插着鼠标 —— 必须看主指针，不看有没有触摸。
 */
export function hasFinePointer(): boolean {
  try {
    return window.matchMedia?.('(pointer: fine)').matches ?? false
  } catch {
    return false
  }
}

/**
 * 宽布局（≥768 的内容区）：手机竖屏为假，其余为真。
 *
 * 由 `data-form` 推导，替代各页面手写的 `innerWidth >= 768`（B 阶段收口）。
 * 没装 deviceProfile（单测）时退回宽度比较。
 */
export function isWideLayout(): boolean {
  if (typeof document !== 'undefined') {
    const f = document.documentElement.dataset.form
    if (f) return f !== 'phone'
  }
  if (typeof window === 'undefined') return false
  return window.innerWidth >= 768
}
