/**
 * 观看历史 + 播放进度。
 *
 * 当前用 localStorage。后续接 WebDAV 时只需要替换 `persist` / `restore`
 * 两个函数，读写接口保持不变（见 docs 里提到的同步方案）。
 *
 * ## 为什么进度直接挂在历史上
 *
 * 进度天然属于「某一部片看到哪里」，单独一张表要 join、备份要改两处、
 * 跨端同步要多一个文件，收益却只有"多留几条进度"这一项。
 * 代价是进度会随 `historyLimit` 一起被裁——这也正是影视仓/Jellyfin 的行为。
 *
 * ## 为什么用 `ep_at` 而不是 `at` 判断新旧
 *
 * `at` 会被「打开详情页」「首页点一下封面」刷新，但这些动作不代表进度前进。
 * 如果只看 `at`，PC 上看到 20:00 → 手机点一下封面 → 同步回来进度被清零。
 * `ep_at` 只由真正播放时更新，跨端合并进度时以它为准。
 */

import { getPrefs } from './prefs'

export interface HistoryItem {
  site: string
  siteName: string
  vod_id: string
  vod_name: string
  vod_pic: string
  vod_remarks?: string
  /** 毫秒时间戳：最后一次打开这部片（含只点封面没播） */
  at: number

  // ---------------- 续播（老数据没有这些字段，全部可选） ----------------

  /** 当前集看到第几秒 */
  pos?: number
  /** 当前集总时长（秒）；未知为 0 */
  dur?: number
  /** 线路名，= vod_play_from 的一段 */
  flag?: string
  /** 集名，如「第03集」 */
  ep?: string
  /** 集地址，= /api/play 的 id 参数 */
  ep_url?: string
  /** 这一集进度最后更新的时间，跨端合并进度时以它为准 */
  ep_at?: number
}

/** pushHistory 的入参：进度字段可缺省，缺省时沿用已有值 */
export type HistoryInput = Omit<Partial<HistoryItem>, 'site' | 'vod_id' | 'at'> & {
  site: string
  vod_id: string
  at?: number
}

export interface Progress {
  pos: number
  dur: number
  /** 这一集进度最后更新的时间 */
  at: number
}

const KEY = 'meow.history.list'

function limit(): number {
  const n = getPrefs().historyLimit
  return Number.isFinite(n) && n > 0 ? n : 30
}

export function listHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    /*
     * ★ 读的时候按 `at` 倒序（2026-11-05 修）。
     *
     * 存储顺序并不可靠：`pushHistory` 会把命中的那条**移到最前**，
     * 而历史页补封面（fillMissingPosters）会对缺图的条目逐条回写 ——
     * 于是一次进页面就把"最新在前"重排成"最旧在前"（实测 OECT 上
     * 10月29日 排在 11月2日 前面）。`groupByDay` 的注释明确假设输入
     * 已倒序，所以这条不变式必须在这里保证，而不是指望每个写入方守规矩。
     */
    return (arr as HistoryItem[])
      .filter((x) => x && typeof x.site === 'string' && typeof x.vod_id === 'string')
      .sort((a, b) => (b.at || 0) - (a.at || 0))
  } catch {
    return []
  }
}

/** 与 localStorage 里的同一条记录合并：进度字段保留旧的，其余以新的为准 */
/**
 * 合并新旧两条记录。
 *
 * <p><b>空串不能覆盖已有值</b>（2026-10-30 修）：原实现是 `{...prev, ...next}`，
 * 于是下一次 `pushHistory` 只要带了个空 `vod_pic`（播放页从 URL 进来时
 * 本来就拿不到封面，见 PlayView.posterPic 的注释），已经把图存好的
 * 那条记录就会被抹成空 —— 历史页表现为"偶尔看不到海报"，
 * 而且是**点开一次变空一次**，越用越空。
 *
 * <p>判据：字符串字段只在 `next` 里是**非空**时才覆盖；进度字段按"有没有传"
 * 判断（`0` 是合法进度值，不能用真假来判）。
 */
function mergeInto(prev: HistoryItem | undefined, next: HistoryInput): HistoryItem {
  const at = next.at ?? Date.now()
  if (!prev) return { ...(next as HistoryItem), at }
  // 本次没带进度字段时，沿用旧记录里的进度，避免"点一下封面把进度清掉"
  const carried: Partial<HistoryItem> = {
    pos: next.pos ?? prev.pos,
    dur: next.dur ?? prev.dur,
    flag: next.flag ?? prev.flag,
    ep: next.ep ?? prev.ep,
    ep_url: next.ep_url ?? prev.ep_url,
    ep_at: next.ep_at ?? prev.ep_at,
  }
  const merged: HistoryItem = { ...prev, ...next, ...carried, at }
  /*
   * 展示字段的"空不覆盖"：这些值在源站偶尔返回空（某次 search 没给图、
   * detail 被源站限流），但之前一定有一次拿到过。一旦被空串覆盖，
   * 用户就只剩一个胶片占位图，而且没有任何办法让它回来。
   */
  merged.vod_pic = nonEmpty(next.vod_pic) || prev.vod_pic
  merged.vod_name = nonEmpty(next.vod_name) || prev.vod_name
  merged.vod_remarks = nonEmpty(next.vod_remarks) || prev.vod_remarks
  merged.siteName = nonEmpty(next.siteName) || prev.siteName
  return merged
}

/** 去掉首尾空白后非空才算"有新值"。 */
function nonEmpty(s: string | undefined): string {
  return typeof s === 'string' ? s.trim() : ''
}

function persist(items: HistoryItem[], opts: { notify?: boolean } = {}) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* 配额满时忽略，历史不是关键数据 */
  }
  if (opts.notify === false) return
  // 用事件而不是直接 import sync：sync 已经依赖本模块，直接引用会循环。
  // 由 app 层监听这个事件去触发防抖上传。
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:history-changed'))
  }
}

/** 记录一次观看。同一部影片只保留最新一条，且不会丢掉已有进度。 */
export function pushHistory(item: HistoryInput, opts: { notify?: boolean } = {}) {
  const list = listHistory()
  const idx = list.findIndex((x) => x.site === item.site && x.vod_id === item.vod_id)
  const entry = mergeInto(idx >= 0 ? list[idx] : undefined, item)
  const rest = list.filter((_, i) => i !== idx)
  persist([entry, ...rest].slice(0, limit()), opts)
}

/**
 * 记录播放进度。
 *
 * `notify: false` 用于播放中的 5 秒节流落盘——只写 localStorage，不触发
 * WebDAV 上传（否则播放全程每 5 秒就会 PUT 一次整份 history.json）。
 * 关键节点（暂停 / 切集 / 页面隐藏）传 `notify: true`。
 *
 * 传入的 `epUrl` 和记录里的不一致时，说明换集了，进度直接覆盖而不是比较。
 */
export function saveProgress(
  key: { site: string; vod_id: string },
  progress: { pos: number; dur: number; flag?: string; ep?: string; epUrl?: string },
  opts: { notify?: boolean } = {},
): void {
  const pos = Number(progress.pos)
  if (!Number.isFinite(pos) || pos < 0) return
  const list = listHistory()
  const idx = list.findIndex((x) => x.site === key.site && x.vod_id === key.vod_id)
  if (idx < 0) return // 没有历史记录就不为它凭空造一条

  const prev = list[idx]
  // 同一集才沿用"进度只能前进"的判断；换集直接记新集的。
  //
  // 这里**只比 url**：换线路时 url 也变，于是守卫被跳过、允许写入新位置——
  // 这正是想要的（换线路后从头看是真实状态）。若改成"集名相同就算同一集"，
  // 换线路反而会被当成回退而拒写，进度就卡在旧线路上不动了。
  const sameEp = !progress.epUrl || !prev.ep_url || progress.epUrl === prev.ep_url
  if (sameEp && typeof prev.pos === 'number' && prev.ep_at && pos + 1 < prev.pos) {
    // 允许小幅回退（用户主动拖回去），但拒绝"从 30 分钟跳回 5 秒"这类
    // 切集后旧集的 timeupdate 迟到写入
    return
  }

  list[idx] = {
    ...prev,
    pos,
    dur: progress.dur > 0 ? progress.dur : prev.dur,
    flag: progress.flag ?? prev.flag,
    ep: progress.ep ?? prev.ep,
    ep_url: progress.epUrl ?? prev.ep_url,
    ep_at: Date.now(),
    at: Date.now(),
  }
  persist(list, opts)
}

/**
 * 读取某部片的续播位置。
 *
 * 只有「同一集」才返回，否则第 5 集的进度会被套到第 6 集上。
 *
 * 判定按两级：先比 `epUrl`（同一线路下的同一集），对不上再比集名 `ep`。
 * **必须保留集名兜底**——换线路后同一集的 url 必然变（域名/签名不同），
 * 只认 url 会让"换条线路接着看"变成"从头开始"（实测就是这么坏的）。
 * 集名在源站之间通常一致（「第03集」），所以它是跨线路唯一稳定的标识。
 */
export function getProgress(
  key: { site: string; vod_id: string },
  epUrl?: string,
  epName?: string,
): Progress | null {
  const it = listHistory().find((x) => x.site === key.site && x.vod_id === key.vod_id)
  if (!it || typeof it.pos !== 'number' || !it.ep_at) return null
  if (epUrl && it.ep_url && it.ep_url !== epUrl) {
    // url 不一致：可能只是换了线路，集名一致就仍是同一集
    if (!epName || !it.ep || it.ep !== epName) return null
  }
  return { pos: it.pos, dur: it.dur ?? 0, at: it.ep_at }
}

/** 清掉一部片的进度（"从头开始"或看完时用） */
export function clearProgress(
  key: { site: string; vod_id: string },
  opts: { notify?: boolean } = {},
): void {
  const list = listHistory()
  const idx = list.findIndex((x) => x.site === key.site && x.vod_id === key.vod_id)
  if (idx < 0) return
  const { pos, dur, flag, ep, ep_url, ep_at, ...rest } = list[idx]
  list[idx] = rest
  persist(list, opts)
}

export function removeHistory(site: string, vodId: string) {
  persist(listHistory().filter((x) => !(x.site === site && x.vod_id === vodId)))
}

export function clearHistory() {
  persist([])
}

/**
 * 把远端历史并进本地（WebDAV 拉取后的手工还原也走这里）。
 *
 * `notify: false` 是给状态通道用的：合并结果若再广播 `meow:history-changed`，
 * 监听方会把它当成"用户产生了新变更"再去上传，下一轮又拉回来合并……
 * 上传/拉取互相触发，永远停不下来。
 */
export function restoreHistoryFrom(
  items: HistoryItem[],
  opts: { notify?: boolean } = {},
) {
  const map = new Map<string, HistoryItem>()
  for (const x of [...items, ...listHistory()]) {
    const k = `${x.site}|${x.vod_id}`
    const prev = map.get(k)
    if (!prev) {
      map.set(k, x)
      continue
    }
    // 元信息取较新的一条，进度取 ep_at 较新的一条
    const newer = (x.at || 0) > (prev.at || 0) ? x : prev
    const progA = prev.ep_at ? prev : null
    const progB = x.ep_at ? x : null
    const prog =
      progA && progB ? ((progB.ep_at || 0) > (progA.ep_at || 0) ? progB : progA) : progA || progB
    map.set(k, {
      ...prev,
      ...newer,
      ...(prog
        ? { pos: prog.pos, dur: prog.dur, flag: prog.flag, ep: prog.ep, ep_url: prog.ep_url, ep_at: prog.ep_at }
        : {}),
    })
  }
  persist([...map.values()].sort((a, b) => b.at - a.at).slice(0, limit()), opts)
}

/**
 * 应用后端状态通道（/api/state/progress）拉回来的进度。
 *
 * 后端只存进度那 8 个字段，**没有片名/封面**，所以要区分两种条目：
 *
 *  - 本地也有的片子：原样交给 `restoreHistoryFrom`。远端的 `at` 是 0，合并时
 *    必然输给本地，元信息不会被降级（否则历史页会变成一堆 vod_id）。
 *  - 本地没有的片子（别的设备看的）：用 vod_id 当显示名、ep_at 当"最后观看"。
 *    不这么补的话历史页会出现标题空白、时间显示 1970 的卡片。
 */
export function applyRemoteHistory(items: HistoryItem[]): void {
  if (!Array.isArray(items) || items.length === 0) return
  const known = new Set(listHistory().map((x) => `${x.site}|${x.vod_id}`))
  const normalized: HistoryItem[] = []
  for (const x of items) {
    if (!x || !x.site || !x.vod_id) continue
    if (known.has(`${x.site}|${x.vod_id}`)) {
      normalized.push(x)
      continue
    }
    normalized.push({
      ...x,
      vod_name: x.vod_name || x.vod_id,
      siteName: x.siteName || x.site,
      vod_pic: x.vod_pic || '',
      at: x.at || x.ep_at || Date.now(),
    })
  }
  if (!normalized.length) return
  restoreHistoryFrom(normalized, { notify: false })
  /*
   * 冷启动竞态（2026-11-05 修）：远端进度是 `main.ts` 启动后异步拉的，
   * 常常晚于历史页 `onMounted` 里的 `listHistory()`。不广播的话页面会停在
   * “还没有观看记录”，而 localStorage 里明明已经有 10 条（实测 OECT）。
   *
   * ★ 用独立事件名而不是 `meow:history-changed`：后者会触发 WebDAV 上传，
   *   变成“拉取 → 上传 → 再拉取”的自激循环（这就是本函数 notify:false 的理由）。
   */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:history-synced'))
  }
}
