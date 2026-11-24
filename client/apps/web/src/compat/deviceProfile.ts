/**
 * 设备档案：开机算一次，写到 `<html>`，全应用只读。
 *
 * ## 输出
 *
 * | 属性 | 取值 | 谁用 |
 * |---|---|---|
 * | `data-shell` | `web` / `tauri` / `tv` / `fpk` / `ios` | 端专属入口（托盘/ExoPlayer/更新通道） |
 * | `data-form` | `phone` / `tablet` / `desktop` / `tv-large` | **只影响布局密度**（列数/双栏/按钮显隐） |
 * | `data-orient` | `portrait` / `landscape` | 替代四套方向判据 |
 * | `data-input` | `touch` / `key` | 由 `inputModality` 维护（焦点环） |
 * | `data-tv` | `1` | 由 `index.html` 首帧写，这里只补写漏掉的 |
 *
 * ## 红线
 *
 * 形态（form）**只允许影响布局**，永远不许影响功能可用性：
 * 返回键、托盘、更新、系统音量、原生播放器一律用**身份或能力**判断。
 * 原因见 `device-adaptive.md` §8.2：iPad 带鼠标与 Mac 无法区分，
 * 768 边界存在歧义设备 —— 形态只能近似。
 *
 * ## 何时更新
 *
 * resize / 旋转只改属性（debounce 100ms），不重建组件。
 * `fpk` 身份是异步探测结果，由 `stores/appUpdate.probeCapability()` 调
 * `markShell('fpk')` 补写。
 */

import {
  currentShell,
  hasIosBridge,
  hasTvBridge,
  isTauriRuntime,
  type Shell,
} from './shell'
import { isMeowTvUa } from './ua'

export type Form = 'phone' | 'tablet' | 'desktop' | 'tv-large'
export type Orient = 'portrait' | 'landscape'

/** 视口 → 形态（纯函数，方便单测与门禁） */
export function resolveForm(
  width: number,
  height: number,
  finePointer: boolean,
  tvShell: boolean,
): Form {
  const landscape = width >= height
  const short = Math.min(width, height)
  if (!landscape) return short < 640 ? 'phone' : 'tablet'
  if (short < 480) return 'tablet'
  // ★ tv-large 必须同时是 TV 壳：iPad 横屏 1180×820 也没有精确指针，
  //   但它是平板不是电视 —— 返回键显隐用它，误判会让 iPad 丢掉返回键。
  if (tvShell && !finePointer) return 'tv-large'
  return 'desktop'
}

/**
 * 是否存在**任意**精确指针（鼠标/触控板）。
 *
 * 与 `(pointer: fine)` 的区别：`any-pointer` 在「触摸屏 + 鼠标」设备上也为真，
 * 这正是返回键红线要的判据（接了鼠标的 TV 要显示页内返回键）。
 */
export function hasAnyFinePointer(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.matchMedia?.('(any-pointer: fine)').matches ?? true
  } catch {
    /* 老内核不支持 matchMedia：按有鼠标处理（宁可多显示功能入口） */
    return true
  }
}

function dimensions(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function write(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const { width, height } = dimensions()
  const shell: Shell = isTauriRuntime()
    ? 'tauri'
    : hasTvBridge() || isMeowTvUa()
      ? 'tv'
      : hasIosBridge()
        ? 'ios'
        : 'web'
  // 已经探测到 fpk 的页面不要被下一次 resize 打回 web。
  if (root.dataset.shell !== 'fpk') root.dataset.shell = shell
  root.dataset.form = resolveForm(width, height, hasAnyFinePointer(), shell === 'tv')
  root.dataset.orient = width >= height ? 'landscape' : 'portrait'
  // 壳是 tv 但首帧脚本没写上（UA 被改过/调试环境）时补一层；
  // 反方向不清除：?tv=1 调试与 PC 端查看电视样式都依赖它。
  if (shell === 'tv') root.dataset.tv = '1'
}

/**
 * 重算身份并写回 `<html>`。
 *
 * 正常路径不需要调：壳桥在 documentStart 注入，早于本模块求值。
 * 留着这个口是为了「桥晚到」的场景（壳在页面之后才注入）与单测。
 */
export function refreshShellIdentity(): void {
  write()
}

/** 业务侧只读的形态（未安装时现算，保证单测/首屏前一致） */
export function formOf(): Form {
  if (typeof document !== 'undefined') {
    const f = document.documentElement.dataset.form
    if (f === 'phone' || f === 'tablet' || f === 'desktop' || f === 'tv-large') return f
  }
  const { width, height } = dimensions()
  return resolveForm(width, height, hasAnyFinePointer(), currentShell() === 'tv')
}

/**
 * 矮视口（手机横屏）：与 CSS `@media (max-height: 520px)` 同源。
 * 用于「首屏只铺 2 行 / 行距收紧」的 JS 侧判据。
 */
export function isShortViewport(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerHeight < 520
}

export function orientOf(): Orient {
  if (typeof document !== 'undefined') {
    const o = document.documentElement.dataset.orient
    if (o === 'portrait' || o === 'landscape') return o
  }
  const { width, height } = dimensions()
  return width >= height ? 'landscape' : 'portrait'
}

/**
 * 由能力探测补写壳身份（目前只有 fpk）。
 *
 * ★ 只允许「升级」到 fpk：tauri/tv 的身份是同步确定的，不能被异步探测改掉。
 */
export function markShell(shell: Shell): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (shell === 'fpk' && (root.dataset.shell === 'web' || root.dataset.shell === 'fpk')) {
    root.dataset.shell = 'fpk'
  }
}

let installed = false
let timer: number | undefined

function schedule(): void {
  if (typeof window === 'undefined') return
  window.clearTimeout(timer)
  timer = window.setTimeout(write, 100)
}

export function installDeviceProfile(): void {
  if (installed) return
  installed = true
  write()
  if (typeof window === 'undefined') return
  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule)
}

// 模块评估即安装（main.ts 第一行 import），保证首屏渲染前 data-* 已就位。
installDeviceProfile()
