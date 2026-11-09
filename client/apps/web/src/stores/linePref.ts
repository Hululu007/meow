/**
 * 线路偏好（按「片」记，不按「集」记）。
 *
 * ## 为什么单独一个文件
 *
 * - `prefs` 是设置，塞进去会让设置备份带上几百部片的线路名，且清空设置会丢。
 * - `history` 会被 `historyLimit`（默认 30）裁掉，偏好不该跟着消失。
 *
 * ## 为什么要记
 *
 * 源站的第一条线路经常是坏的或画质最差的，用户手选一条能用的之后，
 * 切集、重进详情页、从历史续播都会退回默认线路——每次都白选一次。
 */
const KEY = 'meow.linepref'

type LineMap = Record<string, { name: string; at: number }>

function keyOf(site: string, vodId: string): string {
  return `${site}|${vodId}`
}

function readAll(): LineMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as LineMap) : {}
  } catch {
    return {}
  }
}

/** 取记住的线路名；没有则返回空串 */
export function getLinePref(site: string, vodId: string): string {
  if (!site || !vodId) return ''
  const it = readAll()[keyOf(site, vodId)]
  return typeof it?.name === 'string' ? it.name : ''
}

/**
 * 记住线路。
 *
 * 只存名字不存下标：源站增减线路会让下标整体错位，名字是稳定标识。
 * 名字也可能被源站改名，所以读取方一律"找不到就退回第一条"。
 */
export function setLinePref(site: string, vodId: string, name: string): void {
  if (!site || !vodId || !name) return
  const all = readAll()
  all[keyOf(site, vodId)] = { name, at: Date.now() }
  // 只在条目数超限时裁剪：这是长期数据，但也不该无限增长。
  // 200 部片约 10KB，远低于 localStorage 配额。
  const keys = Object.keys(all)
  if (keys.length > 200) {
    keys
      .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
      .slice(0, keys.length - 200)
      .forEach((k) => delete all[k])
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 配额满时忽略——偏好不是关键数据 */
  }
}

export function clearLinePref(site: string, vodId: string): void {
  const all = readAll()
  delete all[keyOf(site, vodId)]
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 忽略 */
  }
}
