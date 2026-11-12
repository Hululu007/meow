/**
 * 输入方式嗅探：决定「要不要画焦点环」。
 *
 * ## 为什么需要（2026-11-12 用户报）
 *
 * > "聚焦圆环 竖屏设备默认不要显示（除非接入键盘 方向键控制后显示）"
 *
 * 焦点环是给**遥控器/键盘**用的定位光标。手机上手指点哪儿哪儿就动，环只
 * 会一直糊在屏幕上（尤其播放页左上角的返回键，看着像按钮被选中了）。
 *
 * ## 做法
 *
 * 把"最后一次输入是什么"落到 `html[data-input]`：
 *
 * - **默认**：设备有触摸（`navigator.maxTouchPoints > 0`）→ `touch`，否则 `key`。
 *   真电视的 WebView 没有触摸点，默认 `key`，焦点环行为和以前完全一致。
 * - **收到导航键**（方向键 / 回车 / Esc / Tab / 空格 / 退格）→ `key`，环出现。
 * - **触摸或鼠标按下** → `touch`，环收起。
 *
 * 样式侧只写一条 `html[data-input='touch'] .meow-tv-focus { … }`（见
 * tokens.css 末尾），因此：手机默认无环；接了蓝牙键盘按方向键立刻有环；
 * 真电视不受影响。
 *
 * 用属性而不是 class：样式是全局的，属性挂在 `<html>` 上，任何组件/注入
 * 脚本（TV 壳的 tv-nav）都能读到，不需要跨模块共享状态。
 */

/** 视为"键盘导航"的按键。只认这些：打字的字母数字不该把环唤出来。 */
const NAV_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Enter',
  'Escape',
  'Tab',
  ' ',
  'Backspace',
])

type Mode = 'touch' | 'key'

function apply(mode: Mode): void {
  const root = document.documentElement
  if (root.getAttribute('data-input') === mode) return
  root.setAttribute('data-input', mode)
}

/**
 * 首屏默认输入方式：**按屏幕方向**，不是按触摸点数。
 *
 * <p>★ 2026-11-12 踩坑：原来用 `maxTouchPoints > 0` 判"触屏 → 不画环"，
 * MuMu 76 这类横屏 TV 模拟器同样返回 &gt; 0（它带触摸屏模拟），于是
 * 横屏的焦点环也被一起关掉。用户原话：「之前改竖屏，去除了，但是正常
 * 横屏也没了」——他要的是按**竖屏**去环，不是按"有没有触摸"去环。
 *
 * <p>规则：
 *   · 横屏 → 默认 key（遥控器/键盘形态，焦点环可见）；
 *   · 竖屏 → 有触摸点默认 touch（手机手指操作不需要环）；
 *   · 竖屏无触摸（少见的竖屏盒子）→ key。
 *
 * 用户真正按键或触摸后由下面的监听覆盖；TV 壳的遥控按键不产生 DOM
 * keydown，见 tv-nav.js 里的显式切换。
 */
function isLandscape(): boolean {
  return window.innerWidth >= window.innerHeight
}

function hasTouch(): boolean {
  return (navigator.maxTouchPoints || 0) > 0
}

/** 竖屏触屏：用户明确要求"竖屏不要聚焦"，任何按键/旋转都不能把环带出来 */
function portraitTouch(): boolean {
  return !isLandscape() && hasTouch()
}

function defaultMode(): Mode {
  if (isLandscape()) return 'key'
  return hasTouch() ? 'touch' : 'key'
}

/** 所有"切到 key"的入口都走这里：竖屏触屏强制压回 touch */
function applyKey(): void {
  apply(portraitTouch() ? 'touch' : 'key')
}

export function installInputModality(): void {
  apply(defaultMode())

  // capture：tv-nav 会 stopPropagation，冒泡阶段可能收不到
  window.addEventListener(
    'keydown',
    (e) => {
      if (NAV_KEYS.has(e.key)) applyKey()
    },
    true,
  )

  window.addEventListener('pointerdown', () => apply('touch'), true)
  // 老内核/部分 WebView 的 pointer 事件不全，触摸再兜一层
  window.addEventListener('touchstart', () => apply('touch'), { capture: true, passive: true })
  /*
   * 旋转/改窗口尺寸：横屏转竖屏时把已经画出来的环收掉。
   * 只处理"转成竖屏触屏"这一个方向；转回横屏不主动画环（等用户按键）。
   */
  const onResize = () => {
    if (portraitTouch()) apply('touch')
  }
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)
}

// 模块评估即安装（main.ts 第一行 import 它旁边的 polyfill），
// 保证首屏渲染出来之前 `<html>` 上就有正确的 data-input。
installInputModality()
