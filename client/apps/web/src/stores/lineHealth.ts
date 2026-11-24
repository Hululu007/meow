/**
 * 线路健康记忆（#16）。
 *
 * 用户实报「能出结果的源也不是所有线路都能播放，需要频繁切线路」：
 * 每次进同一部片都从源站给的第一条线路试起，而那条经常是死链，
 * 只能等 12–45 秒看门狗。这份记忆做三件事：
 *
 *   · 排序：成功率高的线路排前面（未验证的排中间，全失败的排最后）
 *   · 短预算：从没播成功过的线路用 10s/8s 看门狗，死链更快跳走
 *   · 避开：连续失败 ≥2 次且从未成功 → 预算再收紧，基本等于快速跳过
 *
 * 只记**站 × 线路名**，不记集/片：同一站点的线路质量跨片稳定，
 * 而线路名是源站改名后仍可读的稳定标识（下标会整体错位）。
 * TTL 30 天：源站会修，不能永久判死。
 */
const KEY = 'meow.line.health.v1'
const MAX_SITES = 300
const MAX_AGE_MS = 30 * 24 * 3600 * 1000

export interface LineHealthEntry {
  ok: number
  fail: number
  lastOkAt: number
  lastFailAt: number
}

type All = Record<string, LineHealthEntry>

function keyOf(site: string, name: string): string {
  return `${site}|${name}`
}

function readAll(): All {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return {}
    const out: All = {}
    const now = Date.now()
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const e = v as Partial<LineHealthEntry>
      const last = Math.max(Number(e.lastOkAt) || 0, Number(e.lastFailAt) || 0)
      if (!last || now - last > MAX_AGE_MS) continue
      out[k] = {
        ok: Math.max(0, Number(e.ok) || 0),
        fail: Math.max(0, Number(e.fail) || 0),
        lastOkAt: Number(e.lastOkAt) || 0,
        lastFailAt: Number(e.lastFailAt) || 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(all: All): void {
  const keys = Object.keys(all)
  if (keys.length > MAX_SITES) {
    keys
      .sort(
        (a, b) =>
          Math.max(all[a].lastOkAt, all[a].lastFailAt) -
          Math.max(all[b].lastOkAt, all[b].lastFailAt),
      )
      .slice(0, keys.length - MAX_SITES)
      .forEach((k) => delete all[k])
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 配额满：健康记忆不是关键数据 */
  }
}

export function getLineHealth(site: string, name: string): LineHealthEntry | null {
  if (!site || !name) return null
  return readAll()[keyOf(site, name)] || null
}

/** 这一集/这条线路真的播起来了（progress 推进 >3s 时记一次）。 */
export function noteLineOk(site: string, name: string): void {
  if (!site || !name) return
  const all = readAll()
  const k = keyOf(site, name)
  const cur = all[k] || { ok: 0, fail: 0, lastOkAt: 0, lastFailAt: 0 }
  // 成功一次就把失败计数折半：源站修好后不该被旧失败压很久
  all[k] = {
    ok: cur.ok + 1,
    fail: Math.floor(cur.fail / 2),
    lastOkAt: Date.now(),
    lastFailAt: cur.lastFailAt,
  }
  writeAll(all)
}

/** 这条线路失败（起播超时/播放错误/预检判死）。 */
export function noteLineFail(site: string, name: string): void {
  if (!site || !name) return
  const all = readAll()
  const k = keyOf(site, name)
  const cur = all[k] || { ok: 0, fail: 0, lastOkAt: 0, lastFailAt: 0 }
  all[k] = { ...cur, fail: cur.fail + 1, lastFailAt: Date.now() }
  writeAll(all)
}

/**
 * 排序分值：拉普拉斯平滑的成功率 + 24 小时内成功过的加成。
 * 未验证 = 0.5（中间），全失败 = 0（最后），稳定成功 = 接近 1（最前）。
 */
export function lineScore(site: string, name: string): number {
  const e = getLineHealth(site, name)
  if (!e) return 0.5
  const base = (e.ok + 1) / (e.ok + e.fail + 2)
  const recent = e.lastOkAt && Date.now() - e.lastOkAt < 24 * 3600 * 1000 ? 0.15 : 0
  return base + recent
}

/** 稳定排序：分数高的在前，同分保持源站原顺序。 */
export function sortLinesByHealth<T extends { name: string }>(site: string, lines: T[]): T[] {
  if (!site || lines.length < 2) return lines
  return [...lines].sort((a, b) => lineScore(site, b.name) - lineScore(site, a.name))
}

/**
 * 看门狗预算（毫秒，0 = 用播放器默认 20s/12s）。
 *
 *   · 未验证（<2 次记录）→ **默认预算**：4K 冷启动实测 10–14s，
 *     一上来就给短阈值会把正常慢源误杀；死链由起播前预检（2s）先拦。
 *   · 连续失败 ≥2 且从未成功 → 8s/6s：基本等于快速跳过
 *   · 成功过但失败占多数 → 12s/8s
 *   · 稳定成功 → 默认预算（慢站保留 45s 上限）
 */
export function lineBudget(site: string, name: string): { startup: number; stall: number } {
  const e = getLineHealth(site, name)
  if (!e || e.ok + e.fail < 2) return { startup: 0, stall: 0 }
  if (e.ok === 0 && e.fail >= 2) return { startup: 8_000, stall: 6_000 }
  if (e.ok > 0 && e.fail >= e.ok * 2) return { startup: 12_000, stall: 8_000 }
  return { startup: 0, stall: 0 }
}

/** 只用于测试/清空。 */
export function clearLineHealth(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}
