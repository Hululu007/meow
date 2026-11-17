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
