/**
 * 内置壁纸的 id 白名单。
 *
 * <p>为什么单独一个文件：`prefs.ts` 要在读档时校验 wallpaper 值是否合法，
 * 而 `theme.ts` 才有完整的 `WALLPAPERS` 元数据（label/src/thumb）。
 * 但 `theme.ts` 已经 import 了 `prefs.ts`（取 getPrefs），
 * 反向 import 会成环 —— 打包器能处理，运行时却可能拿到 undefined
 * （TLA/初始化顺序问题），症状是"壁纸列表为空但不报错"。
 *
 * <p>所以把**纯字符串数组**放这里，两边都依赖它，依赖图是单向的。
 */
export const WALLPAPER_IDS = [
  '',
  'cinema',
  'aura',
  'cat',
  // 2026-10-30 新增：意境系列（暗调低对比，见 theme.ts 的注释）
  'nightcity',
  'ember',
  'dusksea',
  'nebula',
  // 2026-11-09 新增：横屏双用系列（TV 16:9 / 手机中心裁切共用一张）
  'firefly',
  'theater',
  // 2026-10-31 新增：浅色系列（明亮、有内容，配 light 主题）
  'shanshui',
  'cloudsea',
  'sakura',
  'catnap',
  'rabbit',
  'meadow',
  // 2026-11-09 新增：横屏双用（浅色组）
  'inkpeak',
  'teafield',
  'linen',
] as const

/**
 * 浅色壁纸的 id。设置页按当前明暗主题只推荐这一组或另一组。
 *
 * <p>为什么需要分组：原来 8 张全是暗调，新增的浅色壁纸混在一个列表里
 * 有两个实际后果 —— 深色主题的用户点到浅色壁纸，整页文字对比度
 * 崩掉（HTML 上有 data-wallpaper 覆盖，但正文仍是浅色）；浅色主题的
 * 用户则要在一堆暗图里翻找。分组后"当前主题推荐"那栏直接给对的一组。
 *
 * <p>判据用实测亮度而不是主观判断：暗色组 YAVG 27–49、浅色组 203–247，
 * 中间没有灰区，所以二分是安全的（2026-11-09 横屏批次：暗色 28–42、
 * 浅色 213–224）。
 */
export const LIGHT_WALLPAPERS = [
  'shanshui',
  'cloudsea',
  'sakura',
  'catnap',
  'rabbit',
  'meadow',
  'inkpeak',
  'teafield',
  'linen',
] as const

/** 这张壁纸是否属于浅色系列（'' = 无背景，不属于任何一组） */
export function isLightWallpaper(id: string): boolean {
  return (LIGHT_WALLPAPERS as readonly string[]).includes(id)
}
