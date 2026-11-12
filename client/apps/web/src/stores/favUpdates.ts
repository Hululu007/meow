/**
 * 追剧更新提醒。
 *
 * <p><b>判定依据是 `vod_remarks`</b>（"更新至第48集" / "全36集" / "蓝光"）。
 * 收藏时把当时的 remarks 存下来（`favRemarks`），之后定期拿最新的比一次，
 * 不一致就认为是"更新了"。
 *
 * <p><b>为什么不比剧集总数</b>：那需要拉 detail（每部片一次请求，几十部就是
 * 几十次），而列表接口（home/category/search）返回的就带 remarks。代价差一个量级。
 *
 * <p><b>为什么不做后台定时</b>：Web/PC 关掉就没了，TV 更不可能常驻。做法是
 * 「打开收藏页/首页时顺手查一次」，用户能感知到的场景也就这些。
 */

const KEY = 'meow.fav.remarks'
/** 两次全量检查的最小间隔。太频繁会被源站限流。 */
const CHECK_INTERVAL_MS = 6 * 3600_000

interface Store {
  /** `${site}|${vod_id}` → 收藏时的 remarks */
  seen: Record<string, string>
  /** 上次全量检查时间 */
  at: number
  /**
   * 上次检查命中的更新：`${site}|${vod_id}` → 最新的 remarks。
   *
   * <p><b>为什么要落盘</b>（2026-11-05）：检查结果原来是收藏页的组件状态，
   * 离开页面就没了；而 `at` 落了盘 → 6 小时内不会重查 → 再进来角标全消失。
   * 用户看到的正是"刚才有红点，回来就没了"。
   */
  hits: Record<string, string>
}

/**
 * 模块级缓存。
 *
 * <p>为什么需要：顶栏要显示"几部有更新"，而它挂在 `route.fullPath` 的
 * computed 上 —— 每次导航都重算。不缓存的话就是每次导航都 JSON.parse
 * 一遍 localStorage。
 *
 * <p>★ 缓存带"原始串"对照（`cacheRaw`）：只有 localStorage 里那个串和
 * 上次读到的一字不差才复用解析结果。别的代码（或测试）直接改了
 * localStorage 时缓存会自动失效 —— 只按"模块内写过"来判断会读到脏数据。
 * 代价是每次读多一次 `getItem` + 字符串比较（浏览器里是哈希查表，很便宜），
 * 省掉的是 JSON.parse（几百条收藏时是毫秒级）。
 */
let cache: Store | null = null
let cacheRaw: string | null = null

function load(): Store {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    raw = null
  }
  if (cache && cacheRaw === raw) return cache
  if (!raw) {
    cache = { seen: {}, at: 0, hits: {} }
    cacheRaw = raw
    return cache
  }
  try {
    const o = JSON.parse(raw) as Partial<Store>
    cache = {
      seen: o.seen && typeof o.seen === 'object' ? o.seen : {},
      at: Number(o.at) || 0,
      hits: o.hits && typeof o.hits === 'object' ? o.hits : {},
    }
  } catch {
    cache = { seen: {}, at: 0, hits: {} }
  }
  cacheRaw = raw
  return cache
}

function save(st: Store): void {
  cache = st
  let raw: string | null = null
  try {
    raw = JSON.stringify(st)
    localStorage.setItem(KEY, raw)
  } catch {
    /* 统计丢了不影响主体功能 */
  }
  cacheRaw = raw
  notifyChanged()
}

/**
 * 检查结果变了 → 广播，让顶栏角标刷新。
 *
 * <p>为什么不用事件名 `meow:favorites-changed`：那个是"收藏条目变了"
 * （会触发同步回推），这里只是"更新状态变了"，不能混用，否则会自激。
 */
function notifyChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:fav-updates-changed'))
  }
}

export function keyOf(site: string, vodId: string): string {
  return `${site}|${vodId}`
}

/**
 * 收藏时记下当时的 remarks。
 *
 * <p>只在**没有记录**时写入：用户反复点收藏不该把"已看过的新集数"覆盖成
 * 最新值——那会让更新提醒永远不触发。
 */
export function rememberRemarks(site: string, vodId: string, remarks: string): void {
  const st = load()
  const k = keyOf(site, vodId)
  if (st.seen[k] !== undefined) return
  st.seen[k] = remarks || ''
  save(st)
}

/**
 * 记录当前 remarks（用户已经看到了，视为"已读"）。
 *
 * <p>用在收藏页：用户点进那部片，就说明他看到了最新集数，
 * 下次不该再提醒同一件事。
 */
export function markSeen(site: string, vodId: string, remarks: string): void {
  const st = load()
  const k = keyOf(site, vodId)
  st.seen[k] = remarks || ''
  // 用户已经看到了，这条不再算"有更新"
  delete st.hits[k]
  save(st)
}

/**
 * 全部标记已读（清掉所有更新角标）。
 *
 * <p>用户口径（2026-11-05）："是否需要增加已读，重置更新态"。
 * 点进详情已经会自动清一条，但收藏多了以后逐个点开不现实，
 * 所以给一个"全部已读"。
 *
 * <p>★ 基线要更新成**最新值**（hits 里存着的），不是收藏时的旧值 ——
 * 否则下一轮检查又会把这些部全报成"有更新"。
 */
export function markAllSeen(): number {
  const st = load()
  const n = Object.keys(st.hits).length
  for (const [k, latest] of Object.entries(st.hits)) {
    st.seen[k] = latest
  }
  st.hits = {}
  save(st)
  return n
}

/**
 * 重置更新态：清掉角标但**不动基线**。
 *
 * <p>与 `markAllSeen` 的区别：那个把基线推到最新（"我知道了"），
 * 这个只是"别再烦我"（"这条我不需要提醒，但下次有新集数还是要提醒"）。
 * 后者适合"追的片已经完结/不想看更新"的场合。
 *
 * @returns 被清掉的条数
 */
export function resetUpdates(): number {
  const st = load()
  const n = Object.keys(st.hits).length
  st.hits = {}
  save(st)
  return n
}

/**
 * 只更新基线，**不动 hits**。
 *
 * <p>与 `markSeen` 的区别：markSeen 是"已读"（清提醒），这个是"我看过
 * 当前的状态了"（下次从这里起算新增）。详情页打开时用它 —— 发现新增
 * 的同一刻就要把基线推过去，否则刷新一次详情页就重复提示；
 * 但提醒要不要消（hits）由"用户是否真的去看了"决定，不归详情页管。
 */
export function updateBaseline(site: string, vodId: string, remarks: string): void {
  const st = load()
  st.seen[keyOf(site, vodId)] = remarks || ''
  save(st)
}

/**
 * 挂一条未读更新（顶栏红点 / 收藏角标的数据源）。
 *
 * <p>详情页对比快照发现新增时调用。只该对**收藏中**的剧调用 ——
 * 顶栏红点数的是 hits 总数，非收藏的剧挂进来会让红点数字和
 * 收藏页对不上。
 */
export function recordUpdateHit(site: string, vodId: string, latest: string): void {
  const st = load()
  st.hits[keyOf(site, vodId)] = latest || ''
  save(st)
}

// ---------------------------------------------------------------- 详情/播放页标新

/** "自上次看新增的集数范围"：序号 from..to（1 起，含两端） */
export interface NewEpisodesRange {
  from: number
  to: number
  count: number
}

/**
 * 会话内的新增范围。
 *
 * <p>为什么放内存不放 localStorage：详情页算出"第 11-29 集是新的"后
 * 把基线推到了当前值，播放页再对比快照永远是 0 —— 范围必须**传递**，
 * 不能重算。会话级变量正好：刷新页面后详情页重新对比一遍，语义不变。
 */
const sessionNew = new Map<string, NewEpisodesRange>()

/** 读会话内的新增范围（播放页选集面板标新用）。 */
export function sessionNewEpisodes(site: string, vodId: string): NewEpisodesRange | null {
  return sessionNew.get(keyOf(site, vodId)) || null
}

/**
 * 详情页打开时对比快照，返回"自上次看新增的集数范围"。
 *
 * <p><b>快照就是 `seen`</b>：上次打开详情页（或收藏那一刻）的 remarks。
 * 对比用 `parseEpisodeCount` 抠集数 —— remarks 抠不出集数（电影时长、
 * 画质标签）时没有可比的基准，不标新，只把基线存下来。
 *
 * <p><b>幂等</b>：返回范围的同时把基线推到当前值，所以同一次会话里
 * 详情页调过之后，播放页再调会返回 null（它的范围从 `sessionNewEpisodes`
 * 拿）。直接进播放页（历史续播）的场景由播放页自己调一次。
 *
 * @param totalEps 该剧最长的线路有多少集（ remarks 说的集数可能和
 *   实际线路对不上，标新按实际格子数算）
 */
export function consumeNewEpisodes(
  site: string,
  vodId: string,
  currentRemarks: string,
  totalEps: number,
): NewEpisodesRange | null {
  const k = keyOf(site, vodId)
  const prev = getSeenRemarks(site, vodId)
  const prevEp = prev === undefined ? null : parseEpisodeCount(prev)
  const total = Math.max(0, Math.floor(totalEps) || 0)
  let range: NewEpisodesRange | null = null
  if (prevEp !== null && total > 0 && prevEp < total) {
    range = { from: prevEp + 1, to: total, count: total - prevEp }
  }
  // 这次打开就是"已知状态"，基线必须推过去 —— 否则刷新一次重复提示一次
  updateBaseline(site, vodId, currentRemarks)
  if (range) sessionNew.set(k, range)
  else sessionNew.delete(k)
  return range
}

/**
 * 最近一次检查命中的更新（`${site}|${vod_id}` → 最新 remarks）。
 *
 * <p>页面初始化时读它，角标就不会因"离开再回来"而消失。
 */
export function savedHits(): Record<string, string> {
  return load().hits
}

/** 有更新的条数（顶栏角标用）。 */
export function pendingUpdateCount(): number {
  return Object.keys(load().hits).length
}

/** 保存本轮检查命中的更新（整体替换：没命中的旧记录应当消失）。 */
export function saveHits(hits: Record<string, string>): void {
  const st = load()
  st.hits = hits
  save(st)
}

/**
 * 从 remarks 里抠出集数。
 *
 * <p>源站的 remarks 形状很杂：`全29集` / `更新至第12集` / `更新至165集` /
 * `蓝光` / `02:06:00`（时长）/ 空。**只有带"集"字的才算数**。
 *
 * <p>取所有匹配里的最大值：有的源写成 `更新至12集  更新至13集`（多线路）。
 *
 * @returns 集数；抠不出来（时长、画质标签、空）返回 null
 */
export function parseEpisodeCount(remarks: string): number | null {
  const s = (remarks || '').trim()
  if (!s) return null
  const re = /(\d+)\s*集/g
  let best: number | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1])
    if (Number.isFinite(n) && (best === null || n > best)) best = n
  }
  return best
}

/**
 * 新增了多少集。
 *
 * <p>基线是 `seen`（收藏那一刻的 remarks），现值是 `hits`（检查拿到的最新值）。
 * 两边都抠集数再相减。
 *
 * <p>★ 一定用 `seen` 而不是收藏条目上的 `vod_remarks`：后者在检查命中后
 * 会被 `refreshFavoriteRemarks` 覆盖成最新值（卡片角签要显示新集数），
 * 拿它当"旧值"永远差 0。
 *
 * @returns 新增集数；抠不出集数（非集数 remarks）返回 null
 */
export function updateDelta(site: string, vodId: string, nowRemarks: string): number | null {
  const old = getSeenRemarks(site, vodId)
  if (old === undefined) return null
  const a = parseEpisodeCount(old)
  const b = parseEpisodeCount(nowRemarks)
  if (a === null || b === null) return null
  return b - a
}

/** 取收藏时的 remarks（用于比较）。 */
export function getSeenRemarks(site: string, vodId: string): string | undefined {
  return load().seen[keyOf(site, vodId)]
}

export interface UpdateHit {
  site: string
  vod_id: string
  /** 旧值（收藏时） */
  from: string
  /** 新值（现在） */
  to: string
}

/**
 * 判断一条收藏是否"更新了"。
 *
 * <p><b>基线为空也算更新</b>（2026-11-05）：收藏时源站常常没给 remarks，
 * 于是 `seen` 记的是空串。原来的规则"两边都有值才比"会让这类收藏**永远**
 * 不提醒 —— 用户反馈"收藏页看不到更新标记"，很大一部分是这条。
 * 现在：基线为空、现在有值 → 视为更新（只报一次，点进去就 markSeen）。
 *
 * <p>现在为空不参与：源站偶尔返回空 remarks，那不是更新，是抖动。
 */
export function isUpdated(site: string, vodId: string, nowRemarks: string): boolean {
  const old = getSeenRemarks(site, vodId)
  if (old === undefined) return false
  const b = (nowRemarks || '').trim()
  if (!b) return false
  const a = (old || '').trim()
  if (!a) return true
  return a !== b
}

/** 上次全量检查的时间（0 = 从没查过），用来在页面上显示"x 分钟前检查" */
export function lastCheckedAt(): number {
  return load().at
}

/** 是否到了该做一次全量检查的时间。 */
export function shouldCheck(): boolean {
  return Date.now() - load().at > CHECK_INTERVAL_MS
}

/** 记一次全量检查的时间（避免短时间内重复打源站）。 */
export function markChecked(): void {
  const st = load()
  st.at = Date.now()
  save(st)
}

/** 清理已不在收藏里的记录，避免无限增长。 */
export function pruneRemarks(aliveKeys: string[]): void {
  const st = load()
  const set = new Set(aliveKeys)
  let changed = false
  for (const k of Object.keys(st.seen)) {
    if (!set.has(k)) {
      delete st.seen[k]
      changed = true
    }
  }
  for (const k of Object.keys(st.hits)) {
    if (!set.has(k)) {
      delete st.hits[k]
      changed = true
    }
  }
  if (changed) save(st)
}

/**
 * 导出追剧基准（WebDAV 快照用）。
 *
 * 要的是 `seen`（收藏时看到的 remarks），不是 `hits`（本轮检查发现的更新）：
 * 前者是长期基线，换机后没有它，第一次检查会把所有收藏都当"已更新"；
 * 后者是一次检查的临时结果，6 小时后本来就会重算。
 */
export function exportSeenRemarks(): Record<string, string> {
  return load().seen
}

/**
 * 合并远端基准（WebDAV 快照还原用）。
 *
 * 本地已有的 key 一律不动，只补缺失：`seen` 没有时间戳可比，而"本机
 * 已经看过哪一集"以本机为准更安全——还原旧快照不该把新集重新标成未看。
 */
export function mergeSeenRemarks(input: Record<string, string>): number {
  const remote = input && typeof input === 'object' ? input : {}
  const st = load()
  let changed = 0
  for (const [k, v] of Object.entries(remote)) {
    if (!k || typeof v !== 'string' || !v) continue
    if (!(k in st.seen)) {
      st.seen[k] = v
      changed++
    }
  }
  if (changed) save(st)
  return changed
}
