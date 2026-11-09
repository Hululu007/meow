/**
 * 收藏。
 *
 * ## 为什么本地优先
 *
 * 收藏是用户自己攒的数据，丢了很难补。所以 localStorage 是权威来源，
 * 后端 `/api/state/favorites` 只作为跨端同步通道——后端不可用（老版本、
 * 离线、容器没起）时收藏依然能加能删，只是不跨端。
 *
 * ## 为什么合并按 at 取大
 *
 * 两端都加过同一部片时，元信息（片名/封面/备注）以较新的那次为准：
 * 源站改过片名后，旧的那条可能连封面都失效了。
 */

import type { FavoriteItem } from '@/api'
import { rememberRemarks } from './favUpdates'

export type { FavoriteItem }

const KEY = 'meow.favorites.list'

/** 上限：个人自用够用，同时避免 localStorage 被无限撑大。 */
const LIMIT = 500

export function listFavorites(): FavoriteItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return (arr as FavoriteItem[])
      .filter((x) => x && typeof x.site === 'string' && typeof x.vod_id === 'string')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
  } catch {
    return []
  }
}

export function isFavorite(site: string, vodId: string): boolean {
  return listFavorites().some((x) => x.site === site && x.vod_id === vodId)
}

export function findFavorite(site: string, vodId: string): FavoriteItem | undefined {
  return listFavorites().find((x) => x.site === site && x.vod_id === vodId)
}

/** 变更事件：带上具体动作，同步层就不用 diff 快照猜"改了什么"。 */
export interface FavoriteChange {
  /** restore = 整体替换（还原备份/导入），同步层需要全量重建后端那份。 */
  action: 'add' | 'remove' | 'clear' | 'restore'
  site?: string
  vod_id?: string
  item?: FavoriteItem
}

function persist(items: FavoriteItem[], change?: FavoriteChange) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items.slice(0, LIMIT)))
  } catch {
    /* 配额满时忽略；收藏丢了比整个页面崩掉好 */
  }
  if (!change) return
  // 与 history 同构：用事件解耦，main.ts 监听后推给后端。
  // 直接 import api 会让 store 依赖网络层，测试里还得 mock。
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<FavoriteChange>('meow:favorites-changed', { detail: change }))
  }
}

/**
 * 加/取消收藏，返回操作后的状态（true = 已收藏）。
 *
 * 重复添加不产生重复条目，但会刷新元信息（片名/封面可能变了）。
 */
export function toggleFavorite(
  item: Omit<FavoriteItem, 'at'> & { at?: number },
  opts: { notify?: boolean } = {},
): boolean {
  if (!item?.site || !item?.vod_id) return false
  const list = listFavorites()
  const idx = list.findIndex((x) => x.site === item.site && x.vod_id === item.vod_id)
  if (idx >= 0) {
    list.splice(idx, 1)
    persist(list, opts.notify === false ? undefined : {
      action: 'remove',
      site: item.site,
      vod_id: item.vod_id,
    })
    return false
  }
  const rec: FavoriteItem = {
    site: item.site,
    vod_id: item.vod_id,
    vod_name: item.vod_name || '',
    vod_pic: item.vod_pic || '',
    vod_remarks: item.vod_remarks || '',
    flag: item.flag || '',
    // 已有记录时沿用旧 at（收藏时间不该被重复点击改写），新记录才用当前时间
    at: item.at || Date.now(),
  }
  persist([rec, ...list], opts.notify === false ? undefined : { action: 'add', item: rec })
  // 记下收藏那一刻的 remarks 作为基线，之后拿它比"有没有更新"。
  // 已有记录不会被覆盖（rememberRemarks 内部判重）——否则反复点收藏
  // 会把新集数当成基线，更新提醒永远不触发。
  rememberRemarks(rec.site, rec.vod_id, rec.vod_remarks || '')
  return true
}

/**
 * 用源站最新 remarks 刷新收藏条目（不动收藏时间，也不派发同步事件）。
 *
 * <p>用在"检查更新"命中时：否则卡片上还挂着收藏当天的「全10集」，
 * 而角标写着「有更新」，看起来自相矛盾（2026-11-05）。
 */
export function refreshFavoriteRemarks(site: string, vodId: string, remarks: string): void {
  const list = listFavorites()
  const it = list.find((x) => x.site === site && x.vod_id === vodId)
  if (!it) return
  const next = (remarks || '').trim()
  if (!next || next === (it.vod_remarks || '').trim()) return
  it.vod_remarks = next
  persist(list)
}

export function removeFavorite(
  site: string,
  vodId: string,
  opts: { notify?: boolean } = {},
): void {
  const list = listFavorites()
  const next = list.filter((x) => !(x.site === site && x.vod_id === vodId))
  if (next.length === list.length) return
  persist(next, opts.notify === false ? undefined : { action: 'remove', site, vod_id: vodId })
}

export function clearFavorites(opts: { notify?: boolean } = {}): void {
  persist([], opts.notify === false ? undefined : { action: 'clear' })
}

/**
 * 用给定列表整体替换本地收藏（还原备份 / 导入用）。
 *
 * 与 `applyRemoteFavorites` 的区别：那个是并集（跨端同步，谁都不能丢），
 * 这个是覆盖（用户明确说"恢复到这个备份的状态"，本地多出来的应该消失）。
 *
 * 会派发 `{action:'restore'}`：还原之后后端那份必须跟着重建，否则下次启动
 * 的并集合并会把刚被覆盖掉的旧收藏又拉回来，用户会以为还原没生效。
 */
export function replaceFavorites(
  items: FavoriteItem[],
  opts: { notify?: boolean } = {},
): void {
  const map = new Map<string, FavoriteItem>()
  for (const x of Array.isArray(items) ? items : []) {
    if (!x || typeof x.site !== 'string' || typeof x.vod_id !== 'string') continue
    const k = `${x.site}|${x.vod_id}`
    const prev = map.get(k)
    if (!prev || (x.at || 0) > (prev.at || 0)) map.set(k, x)
  }
  const next = [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0))
  persist(next, opts.notify === false ? undefined : { action: 'restore' })
}

/**
 * 把远端收藏并进本地。
 *
 * `notify: false` 是硬要求：拉取时如果派发 `meow:favorites-changed`，
 * main.ts 会把它当成用户改动再推回后端，形成"拉→推→拉"的自激循环。
 */
export function applyRemoteFavorites(items: FavoriteItem[]): void {
  if (!Array.isArray(items) || !items.length) return
  const map = new Map<string, FavoriteItem>()
  for (const x of [...listFavorites(), ...items]) {
    if (!x || typeof x.site !== 'string' || typeof x.vod_id !== 'string') continue
    const k = `${x.site}|${x.vod_id}`
    const prev = map.get(k)
    // 元信息取较新的一条；at 缺失（老数据/后端只回 7 键）时视为最旧
    if (!prev || (x.at || 0) > (prev.at || 0)) map.set(k, x)
  }
  persist([...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0)))
  /*
   * 与 history 的 `meow:history-synced` 同一理由：远端收藏是启动后异步拉的，
   * 常常晚于收藏页挂载时的 `listFavorites()`，不广播页面会停在"还没有收藏"。
   * 独立事件名，不能复用 `meow:favorites-changed`（那会触发回推，形成循环）。
   */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:favorites-synced'))
  }
}
