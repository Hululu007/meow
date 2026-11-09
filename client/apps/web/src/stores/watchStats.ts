/**
 * 观看时长统计。
 *
 * <p><b>为什么不塞进 history</b>：历史项是「一部片一条」，会被 historyLimit
 * 裁掉；而统计要的是「每天看了多久」这种与片子无关的累计量，两者生命周期
 * 完全不同。塞进历史项会导致：删一部片 → 那几小时的观看记录也没了。
 *
 * <p><b>为什么不记录每部片的时长到历史项</b>：历史项里的 `pos` 是"看到第几秒"，
 * 不是"看了多久"——用户从头拖到尾只花了 5 秒，pos 却是 600s。真正的观看时长
 * 必须按播放器实际推进的秒数累加（见 PlayView 里的 tick）。
 *
 * <p>存储形状刻意压扁（每天一个数字，不存片子），30 天也就几百字节，
 * 不会像 history 那样撑到几十 KB 影响 localStorage 和跨端同步。
 */

const KEY = 'meow.watch.stats'
/**
 * 保留多少天。
 *
 * <p><b>从 30 提到 365</b>（2026-10-30）：热力图参考 zcode 改成"整年格子"
 * 之后，只留 30 天会导致 53 列里 48 列是空的 —— 用户看到的还是一小撮格子。
 * 全年 365 天、每天一个数字，体积上限 ~6KB（`"2026-10-30":1234,` 约 20 字节），
 * 对 localStorage 和跨端同步都无压力。
 */
const KEEP_DAYS = 365

export interface WatchStats {
  /** 'YYYY-MM-DD' → 秒 */
  days: Record<string, number>
  /** 总时长（秒）。单独存一份，避免每次遍历 */
  total: number
  /** 最后一次累加的时间戳（给"本周"算范围用） */
  at: number
}

function todayKey(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function empty(): WatchStats {
  return { days: {}, total: 0, at: 0 }
}

export function getWatchStats(): WatchStats {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const o = JSON.parse(raw) as Partial<WatchStats>
    return {
      days: o.days && typeof o.days === 'object' ? o.days : {},
      total: Number(o.total) || 0,
      at: Number(o.at) || 0,
    }
  } catch {
    return empty()
  }
}

/**
 * 小数秒的累积残差。
 *
 * <p><b>为什么必须累积</b>（2026-10-31 用户报"历史页时长统计不准/记不上"）：
 * 播放器每次 `timeupdate` 的推进量通常只有 0.2–0.25 秒（约 4 次/秒），
 * 而原实现是 `Math.round(seconds)` 之后 `if (s < 1) return` ——
 * 每次 round(0.25) = 0，**全部被丢弃**，一集看完 0 秒入账。
 *
 * <p>现在把不足 1 秒的部分攒起来，攒够 1 秒再入账。这个残差是模块级变量
 * （不是持久化的），刷新页面丢掉最多 1 秒，可以接受；持久化反而会因为
 * 多设备同步、时区等问题引入新麻烦。
 */
let carrySeconds = 0

/**
 * 累加观看时长。
 *
 * <p><b>为什么要 clamp</b>：播放器 tick 的间隔可能因为切后台/休眠变成几十秒，
 * 直接累加会把"挂着不看"算成观看。单次最多认 30 秒——真在看的话一次
 * 心跳远小于这个值，而切后台回来那一次会被截到 30。
 *
 * @param seconds 本次推进的秒数（通常是小数）
 */
export function addWatchTime(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  // 先 clamp 再加残差：一次大跳（seek/切后台回来）不该靠残差累积放大
  carrySeconds += Math.min(30, seconds)
  const whole = Math.floor(carrySeconds)
  if (whole < 1) return
  carrySeconds -= whole
  const s = whole
  const st = getWatchStats()
  const k = todayKey()
  st.days[k] = (st.days[k] || 0) + s
  st.total += s
  st.at = Date.now()
  prune(st)
  try {
    localStorage.setItem(KEY, JSON.stringify(st))
  } catch {
    /* 配额满等情况：统计丢了不影响播放 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:watch-stats'))
  }
}

/** 只保留最近 KEEP_DAYS 天，顺带清掉脏 key */
function prune(st: WatchStats): void {
  const keys = Object.keys(st.days).sort()
  if (keys.length <= KEEP_DAYS) return
  for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete st.days[k]
}

/** 最近 N 天（含今天）的逐日数组，缺失日期补 0。 */
export function recentDays(n = 7): Array<{ date: string; seconds: number }> {
  const st = getWatchStats()
  const out: Array<{ date: string; seconds: number }> = []
  const d = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i)
    const k = todayKey(dt)
    out.push({ date: k, seconds: st.days[k] || 0 })
  }
  return out
}

/** 汇总：今天 / 本周（近 7 天）/ 总计。 */
export function summary(): { today: number; week: number; total: number; days: number } {
  const week = recentDays(7).reduce((a, b) => a + b.seconds, 0)
  const st = getWatchStats()
  return {
    today: st.days[todayKey()] || 0,
    week,
    total: st.total,
    days: Object.keys(st.days).length,
  }
}

/** 清空统计（设置页"清除观看记录"用）。 */
export function clearWatchStats(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:watch-stats'))
  }
}

/** 秒 → 「3 小时 12 分」这种给人看的写法。 */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`
}

// ---------------------------------------------------------------- 统计面板用

/**
 * 逐日数组，从最早到最晚，缺失日期补 0。
 *
 * <p>与 {@link recentDays} 的区别：那个是"固定取最近 N 天"，
 * 这个按数据的真实跨度取（热力图要铺满整个 30 天窗口，不看有没有记录）。
 */
export function dailySeries(days = KEEP_DAYS): Array<{ date: string; seconds: number }> {
  return recentDays(days)
}

/** 统计面板顶部的指标卡。 */
export interface StatsOverview {
  /** 今天 */
  today: number
  /** 近 7 天 */
  week: number
  /** 近 30 天（= 保留窗口） */
  month: number
  /** 总计 */
  total: number
  /** 有记录的天数（>0 的天） */
  activeDays: number
  /** 当前连续天数（含今天；今天没看则从昨天往前算） */
  streak: number
  /** 最长连续天数 */
  longestStreak: number
  /** 单日最高时长（秒）与日期 */
  peak: { date: string; seconds: number }
  /** 日均（只按"有记录的天"平均，挂机少的日子不拉低） */
  avgPerActiveDay: number
}

/**
 * 连续天数。
 *
 * <p><b>为什么"今天没看也算连续"</b>：用户上午看一眼统计，昨天看了、
 * 前天也看了，链条应该还连着——如果一进页面就显示 0，会以为记录坏了。
 * 所以从今天往前找：今天有记录就从今天算，没有就从昨天算。
 */
function streakOf(dayKeys: string[]): { cur: number; longest: number } {
  const set = new Set(dayKeys)
  const sorted = [...dayKeys].sort()
  let longest = 0
  let run = 0
  let prev: string | null = null
  for (const k of sorted) {
    if (prev && nextDay(prev) === k) run++
    else run = 1
    if (run > longest) longest = run
    prev = k
  }
  // 当前连续：从今天（或昨天）往回数
  let cur = 0
  const d = new Date()
  if (!set.has(todayKey(d))) d.setDate(d.getDate() - 1)
  for (;;) {
    const k = todayKey(d)
    if (!set.has(k)) break
    cur++
    d.setDate(d.getDate() - 1)
  }
  return { cur, longest }
}

/** 'YYYY-MM-DD' → 第二天 */
function nextDay(k: string): string {
  const [y, m, d] = k.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + 1)
  return todayKey(dt)
}

/** 汇总统计面板需要的全部指标（一次遍历算完）。 */
export function overview(): StatsOverview {
  const series = dailySeries()
  const st = getWatchStats()
  const active = series.filter((x) => x.seconds > 0)
  const dayKeys = active.map((x) => x.date)
  const streak = streakOf(dayKeys)
  let peak = { date: '', seconds: 0 }
  for (const x of active) if (x.seconds > peak.seconds) peak = { ...x }
  const monthly = series.reduce((a, b) => a + b.seconds, 0)
  return {
    today: st.days[todayKey()] || 0,
    week: recentDays(7).reduce((a, b) => a + b.seconds, 0),
    month: monthly,
    total: st.total,
    activeDays: active.length,
    streak: streak.cur,
    longestStreak: streak.longest,
    peak,
    avgPerActiveDay: active.length ? Math.round(monthly / active.length) : 0,
  }
}
