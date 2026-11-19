/**
 * 弹幕时间轴校准（按「片名 · 集」记住）。
 *
 * <p>为什么需要：弹幕源与播放源常常不是同一个剪辑版本（片头长度、回顾、
 * 片尾差异）。聚合源又是多平台合并，时间轴可能整体偏移几秒到几分钟。
 * 播放器本身对齐得再准，也救不了“源就不对”的弹幕。
 *
 * <p>为什么按 title（播放器拿到的 `片名 · 集`）而不是按 site/vod_id：
 * 偏移量取决于**视频版本**，不是站点。同一部片换线路后，只要还是那个
 * 剪辑版本，校准值就应该继续生效。
 *
 * <p>约定：**正值 = 弹幕延后**，负值 = 弹幕提前。范围 ±30 秒，0.5 秒一档。
 * 存 localStorage，单条记录只占几十字节；上限 500 条，超出按插入顺序淘汰。
 */

const KEY = 'meow.dm.offset.v1'
const MAX_ENTRIES = 500
const MAX_ABS_SEC = 30

/** 归一化到 0.5 秒档并夹在 ±30 秒；非法值回到 0。 */
export function normalizeDmOffset(v: number): number {
  if (!Number.isFinite(v)) return 0
  const clamped = Math.max(-MAX_ABS_SEC, Math.min(MAX_ABS_SEC, v))
  return Math.round(clamped * 2) / 2
}

function readMap(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'number') {
        const n = normalizeDmOffset(v)
        if (n !== 0) out[k] = n
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeMap(map: Record<string, number>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const keys = Object.keys(map)
    if (keys.length > MAX_ENTRIES) {
      // JSON 对象的键顺序就是插入顺序，删最早的
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k]
    }
    if (keys.length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    /* 隐私模式/配额满：校准只在本次会话生效，不影响播放 */
  }
}

/** 读某片某集的校准值（秒）。没有记录返回 0。 */
export function getDmOffset(key: string): number {
  if (!key) return 0
  return readMap()[key] || 0
}

/** 写校准值；0 等于删除记录。返回实际写入的归一化值。 */
export function setDmOffset(key: string, sec: number): number {
  if (!key) return 0
  const map = readMap()
  const v = normalizeDmOffset(sec)
  if (v === 0) delete map[key]
  else map[key] = v
  writeMap(map)
  return v
}

/** 在现有值上加减（按钮用），返回新值。 */
export function nudgeDmOffset(key: string, delta: number): number {
  return setDmOffset(key, getDmOffset(key) + delta)
}

export function resetDmOffset(key: string): void {
  setDmOffset(key, 0)
}

/** 设置页「清空校准」用；返回清掉的条数。 */
export function clearAllDmOffsets(): number {
  const n = Object.keys(readMap()).length
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  return n
}

/** 展示用：0 → `0s`，正数带 +，保留 1 位小数。 */
export function formatDmOffset(sec: number): string {
  const v = normalizeDmOffset(sec)
  if (v === 0) return '0s'
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}s`
}
