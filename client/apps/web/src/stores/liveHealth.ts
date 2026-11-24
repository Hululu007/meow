/**
 * 直播频道健康记忆（#1）。
 *
 * 后端 `/api/live` 的 `tried/failed` 是**源级**的（有多少站点返回了频道），
 * 完全没碰频道 URL；而界面把它显示成「已试 N 源 · 无直播 M」，用户就以为
 * 「源健康 = 每个台都能播」。实际点进去大量黑屏。
 *
 * 播放页其实早就能判坏台（6 秒起播看门狗、hls fatal、video.error），
 * 但这些结论只影响当次自动跳台，从不落盘 —— 下次进来所有台又"健康"了。
 *
 * 这份记忆把运行时判定落盘，列表直接呈现：
 *   · 连续失败 ≥2 且之后没成功过 → 灰显 + 「上次不可播」+ 排到同组末尾
 *   · 任何一次真的播出画面（playing）→ 清掉失败计数
 *   · TTL 24h：直播源时好时坏，不许永久判死
 *
 * 只按**频道名**记：同一个台在不同 m3u 里的 URL 每天变，按 URL 记永远对不上；
 * 频道名是用户能看到的稳定标识。
 */
const KEY = 'meow.live.health.v1'
const MAX_ENTRIES = 2000
const TTL_MS = 24 * 3600 * 1000
/** 连续失败到这个数才灰显：单次失败可能只是网络抖动 */
const BAD_FAILS = 2

export interface LiveHealthEntry {
  fails: number
  lastFailAt: number
  lastOkAt: number
}

type All = Record<string, LiveHealthEntry>

function readAll(): All {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return {}
    const out: All = {}
    const now = Date.now()
    for (const [name, v] of Object.entries(o as Record<string, unknown>)) {
      if (!name || !v || typeof v !== 'object') continue
      const e = v as Partial<LiveHealthEntry>
      const last = Math.max(Number(e.lastFailAt) || 0, Number(e.lastOkAt) || 0)
      if (!last || now - last > TTL_MS) continue
      out[name] = {
        fails: Math.max(0, Number(e.fails) || 0),
        lastFailAt: Number(e.lastFailAt) || 0,
        lastOkAt: Number(e.lastOkAt) || 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(all: All): void {
  const names = Object.keys(all)
  if (names.length > MAX_ENTRIES) {
    names
      .sort((a, b) => Math.max(all[a].lastFailAt, all[a].lastOkAt) - Math.max(all[b].lastFailAt, all[b].lastOkAt))
      .slice(0, names.length - MAX_ENTRIES)
      .forEach((n) => delete all[n])
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 配额满：不是关键数据 */
  }
}

export function liveHealthOf(name: string): LiveHealthEntry | null {
  const n = (name || '').trim()
  if (!n) return null
  return readAll()[n] || null
}

/** 这个台现在是否应显示为"上次不可播"。 */
export function isLiveBad(name: string): boolean {
  const e = liveHealthOf(name)
  if (!e) return false
  return e.fails >= BAD_FAILS && e.lastFailAt >= e.lastOkAt
}

/** 播放失败（看门狗超时 / hls fatal / video.error / 自动播放被拒）。 */
export function noteLiveFail(name: string): void {
  const n = (name || '').trim()
  if (!n) return
  const all = readAll()
  const cur = all[n] || { fails: 0, lastFailAt: 0, lastOkAt: 0 }
  all[n] = { fails: cur.fails + 1, lastFailAt: Date.now(), lastOkAt: cur.lastOkAt }
  writeAll(all)
}

/** 真的出画面了：失败计数清零（不要被旧失败压着）。 */
export function noteLiveOk(name: string): void {
  const n = (name || '').trim()
  if (!n) return
  const all = readAll()
  const cur = all[n]
  if (!cur || (cur.fails === 0 && cur.lastOkAt > 0)) return
  all[n] = { fails: 0, lastFailAt: cur.lastFailAt, lastOkAt: Date.now() }
  writeAll(all)
}

/**
 * 同组排序：已知坏的排到末尾，其余保持 m3u 原顺序。
 * 用稳定排序（JS 规范保证），不会把 CCTV-1 排到 CCTV-2 后面。
 */
export function sortLiveByHealth<T extends { name: string }>(list: T[]): T[] {
  if (list.length < 2) return list
  return [...list].sort((a, b) => Number(isLiveBad(a.name)) - Number(isLiveBad(b.name)))
}

/** 只用于测试/清空。 */
export function clearLiveHealth(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}
