import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getPrefs } from '@/stores/prefs'

/** 卡片横向间距，与各页面的 column-gap 保持一致 */
export const CARD_GAP = 16

/** 顶栏 + 分类条 + 页面内边距的粗略高度，用于推算可放卡片的区域 */
const CHROME_H = 112

export interface CardColsOptions {
  /** 每行列数上限（设置页的 homeCols） */
  max?: () => number
  /** 可用内容宽度；默认取视口宽减页面左右内边距 */
  width?: () => number
  /** 页面左右内边距总和，仅在没传 width 时使用 */
  padding?: number
  /** 页面内容区最大宽度（首页/收藏都是 1600） */
  maxWidth?: number
}

/**
 * 电视壳会在 documentElement 上打 data-tv 标记（见 client/apps/tv 的 MainActivity）。
 * 电视的 CSS 视口只有物理宽度的一半（1080p@320dpi → 960 CSS），
 * 用桌面同一套目标卡宽会永远少一半列数，所以电视单独一档。
 */
export function isTvEnv(): boolean {
  if (typeof document === 'undefined') return false
  // UA 在页面加载前就已确定，比 onPageFinished 里注入的 dataset 更早可用；
  // dataset 保留给 PC 浏览器里手动加 ?tv=1 的调试场景。
  if (document.documentElement.dataset.tv === '1') return true
  return /MeowTV/i.test(navigator.userAgent)
}

export function clampMaxCols(n: number): number {
  if (!Number.isFinite(n)) return 6
  return Math.min(10, Math.max(2, Math.round(n)))
}

/**
 * 列数按「目标卡宽能放几张」算，而不是按视口断点切档。
 *
 * 断点档位的问题：640 给 3 列、768 给 4 列，卡宽反而从 183 缩到 166；
 * 电视 960 CSS 永远落在 md 档只有 4 列。按卡宽算则卡宽单调，列数随可用宽度连续变化。
 *
 * 矮屏再兜一层：手机横屏（如 844×390）视口只有 390 高，
 * 4 列卡高 323 会把首行裁掉 65px，必须加列把卡压矮。
 */
export function resolveCardCols(
  usableWidth: number,
  usableHeight: number,
  max: number,
  tv = false,
): number {
  const limit = clampMaxCols(max)
  if (!Number.isFinite(usableWidth) || usableWidth < 200) return Math.min(limit, 3)

  /*
   * 电视目标卡宽取 76：960 CSS 下能算出 10 列，再由 limit 截到用户设定（默认 6/8）。
   *
   * ★ 但 TV 壳也可能是**手机尺寸的竖屏**（2026-11-05 实测：MuMu 竖屏
   *   1440×2560@640dpi → CSS 视口 360×640，UA 仍带 MeowTV）。这时按电视
   *   卡宽算出来是 4 列、每张只有 ~66px（用户反馈"一行 4 个是不是多了"）。
   *   所以电视卡宽加一道宽度门槛：只有真·电视视口（≥640 内容宽）才用 76。
   */
  const tvWide = tv && usableWidth >= 640
  const target = tvWide ? 76 : usableWidth >= 1000 ? 104 : 112
  let cols = Math.round((usableWidth + CARD_GAP) / (target + CARD_GAP))
  cols = Math.max(2, Math.min(cols, limit))

  if (Number.isFinite(usableHeight) && usableHeight > 0) {
    // 海报 2:3，标题再占一行
    const maxCardW = Math.max(64, ((usableHeight - 40) * 2) / 3)
    const needed = Math.ceil((usableWidth + CARD_GAP) / (maxCardW + CARD_GAP))
    cols = Math.min(limit, Math.max(cols, needed))
  }
  return cols
}

export function useCardCols(opts: CardColsOptions = {}) {
  const cols = ref(2)
  /** 矮视口（手机横屏）：行距收紧、首屏只铺 2 行 */
  const compact = ref(false)

  function update() {
    const vw = document.documentElement.clientWidth || window.innerWidth
    const usableWidth = opts.width
      ? opts.width()
      : Math.min(vw, opts.maxWidth ?? 1600) - (opts.padding ?? 48)
    const max = opts.max ? opts.max() : getPrefs().homeCols
    compact.value = window.innerHeight < 560
    cols.value = resolveCardCols(usableWidth, window.innerHeight - CHROME_H, max, isTvEnv())
  }

  onMounted(() => {
    update()
    window.addEventListener('resize', update, { passive: true })
    window.addEventListener('meow:prefs', update)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', update)
    window.removeEventListener('meow:prefs', update)
  })

  return { cols, compact, update }
}

/** 网格列数的内联样式：配合 .poster-grid 只负责行距与列宽 */
export function colsStyle(cols: number): Record<string, string> {
  return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
}
