/**
 * 设备形态判断：是不是「大屏横屏」（电视 / 投影仪）。
 *
 * ## 为什么不用 UA
 *
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
 */
export function isBigScreenLandscape(): boolean {
  if (typeof window === 'undefined') return false
  const landscape = window.innerWidth >= window.innerHeight
  if (!landscape) return false
  if (Math.min(window.innerWidth, window.innerHeight) < 480) return false
  let finePointer = false
  try {
    finePointer = window.matchMedia('(any-pointer: fine)').matches
  } catch {
    /* 老内核不支持 matchMedia：按无鼠标处理，TV 形态优先 */
  }
  return !finePointer
}
