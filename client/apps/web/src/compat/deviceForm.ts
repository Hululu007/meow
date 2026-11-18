import { hasAnyFinePointer, resolveForm } from './deviceProfile'
import { isTvShell } from './shell'

/**
 * 设备形态判断：是不是「大屏横屏」（电视 / 投影仪）。
 *
 * ## 为什么不用 UA
 * UA 分不清"电视壳"和"浏览器调试电视布局"：浏览器加 `?tv=1`、TV 壳 UA
 * 带 MeowTV，都会让 `isTvEnv()` 为真，但它们都有鼠标、都需要页内返回键。
 * 用户口径（2026-11-12）：**大屏横屏的电视/投影仪不显示返回键，其他所有
 * 设备正常显示**。按形态判断才是这句话的直译。
 *
 * ## 判据
 *
 * 1. 横屏；
 * 2. 视口短边 ≥ 480（手机横屏 390 不算大屏；TV 的 960×540 算）；
 * 3. **没有鼠标/触控板**（`any-pointer: fine` 为假）。
 *    PC、带鼠标的模拟器都算"有指针设备"，要给返回键；
 *    遥控器/纯触摸的电视、投影仪没有，隐藏。
 *
 * 三点同时成立才算大屏电视。平板上装了鼠标时也会按 PC 处理，符合直觉。
 *
 * ★ 2026-11-17 收口：三点判断已合并进 `deviceProfile.resolveForm()` →
 *   `form === 'tv-large'`。**`any-pointer: fine` 子条件不能删**（返回键红线，
 *   device-adaptive.md R6）：TV/盒子插鼠标时要显示页内返回键。
 */
export function isBigScreenLandscape(): boolean {
  if (typeof window === 'undefined') return false
  // 现算而不是读 data-form：它决定返回键显隐，resize 后不能等 100ms 去抖。
  return resolveForm(window.innerWidth, window.innerHeight, hasAnyFinePointer(), isTvShell()) === 'tv-large'
}

/**
 * 播放页左上角「返回」是否显示。
 *
 * <p>判据：**TV 壳里、大屏横屏、且没见过真实指针输入（鼠标/触摸）就不显示**。
 * 遥控器自带 BACK，而页头按钮在几何选焦里最先被命中，按 OK 就直接退出整集。
 *
 * <p>★ 为什么不能只看 `isBigScreenLandscape()`（2026-11-18 用户报
 *   「投影仪左上角又出现返回按钮」）：它依赖 `(any-pointer: fine)`，
 *   而实测投影仪（Android 9 / Chromium 66）**没接鼠标也报 fine** ——
 *   resolveForm 算成 desktop，按钮就冒出来了。媒体查询在这个 WebView 上
 *   不可信，必须用"真的产生过 pointer 事件"来佐证。
 *
 * <p>★ 竖屏 TV（模拟器竖屏、竖放的电视）例外：用户口径 2026-11-18
 *   「竖屏 tv 左上角返回按钮应该正常显示」。竖屏没有遥控器横向导航的
 *   几何问题，且页面没有顶栏可退，所以 `isLargeLandscapeViewport()`
 *   为假时一律给按钮。
 *
 * <p>R6 红线仍然成立：TV 真接了鼠标/触摸（真的动过/点过）→ 显示页内返回键。
 */
export function showPlayerBackButton(
  tvShell: boolean,
  pointerSeen: boolean,
  bigScreenLandscape: boolean,
): boolean {
  if (!bigScreenLandscape) {
    if (tvShell && !pointerSeen && isLargeLandscapeViewport()) return false
    return true
  }
  return false
}

/** 大屏横屏视口（不含"有没有指针"）：电视/投影仪的形态下限。 */
function isLargeLandscapeViewport(): boolean {
  if (typeof window === 'undefined') return false
  const w = window.innerWidth
  const h = window.innerHeight
  return w >= h && Math.min(w, h) >= 480
}
