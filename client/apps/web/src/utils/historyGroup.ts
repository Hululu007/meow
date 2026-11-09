/**
 * 历史记录按「天」分组（2026-11-03 用户要求）。
 *
 * <p>需求原话：「记录列表按照每日观看拆分加日期小标题，便于回忆哪天看的」。
 * 原来是一整片网格，只有每张卡底下一个小字时间（「3 小时前」），
 * 想找"上周三看的那部"只能一路往下扫。
 *
 * <p><b>为什么放在独立模块而不是写在 HistoryView 里</b>：
 * 分组/标题文案是纯函数，能直接单测（跨月、跨年、"今天/昨天"边界
 * 都是容易写错的地方）；而且 UI 里混着补封面、TV 菜单注册等副作用，
 * 逻辑埋在里面不好验。
 */

export interface DayGroup<T> {
  /** 'YYYY-MM-DD' */
  key: string
  /** 小标题，如「今天 · 11月3日」「昨天 · 11月2日」「2025年12月31日 周三」 */
  label: string
  /** 这一天的条目（保持原顺序） */
  items: T[]
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地时区的 'YYYY-MM-DD'（不能用 toISOString，那是 UTC，晚上 8 点后会跨天） */
export function dayKey(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 两个日期相差几天（按本地日历日，不看时分秒）。
 *
 * <p>参数顺序是 `(now, target)`，返回值 **target 在 now 之后为正、之前为负**。
 * 踩过：写成 `(target, now)` 时过去的日子得到负数，"昨天"判定永远不成立，
 * 所有条目都掉进"今年内"分支（实测页面上一片「11月2日 周一」，
 * 本该是「昨天 · 11月2日」）。
 */
function dayDiff(now: number, target: number): number {
  const a = new Date(now)
  const b = new Date(target)
  const ms =
    new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() -
    new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round(ms / 86_400_000)
}

/**
 * 小标题文案。
 *
 * <p>三个层次，都是为了"一眼定位是哪天"：
 *   · 今天 / 昨天 —— 最常用，给相对说法 + 具体日期（只看"今天"不知道几号）
 *   · 今年内 —— 「11月3日 周一」，不重复写年份
 *   · 跨年 —— 「2025年12月31日 周三」，年份是定位关键
 */
export function dayLabel(key: string, now = Date.now()): string {
  const [y, m, d] = key.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const md = `${m}月${d}日`
  const wd = WEEKDAYS[dt.getDay()]
  const diff = dayDiff(now, dt.getTime())
  if (diff === 0) return `今天 · ${md}`
  if (diff === 1) return `昨天 · ${md}`
  const nowYear = new Date(now).getFullYear()
  if (y === nowYear) return `${md} ${wd}`
  return `${y}年${md} ${wd}`
}

/**
 * 分组。**假设输入已按时间倒序**（history 的 listHistory 就是 `at` 倒序），
 * 这里只切段、不重排——重排会让组内顺序与时间轴不一致。
 *
 * <p>同一天内的多条保持原始顺序（最近打开的在最前）。
 */
export function groupByDay<T extends { at: number }>(
  items: T[],
  now = Date.now(),
): DayGroup<T>[] {
  const out: DayGroup<T>[] = []
  let cur: DayGroup<T> | null = null
  for (const it of items) {
    const k = dayKey(it.at)
    if (!cur || cur.key !== k) {
      cur = { key: k, label: dayLabel(k, now), items: [] }
      out.push(cur)
    }
    cur.items.push(it)
  }
  return out
}
