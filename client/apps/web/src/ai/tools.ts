/**
 * 语义工具层：把高频意图固化成一次调用。
 *
 * 设计见 docs/47 §一。为什么不复用 `pc_dom` / `pc_eval` 那套 UI 原语：
 *   · 慢：一次"帮我找部片"要 5–10 轮 DOM 往返 + 2–3 次推理，十几秒
 *   · 脆：DOM 结构一变就点错，静默点错比报错更难查
 *   · 用户看得见：屏幕上按钮自己动，没有 loading 态，像 bug
 *
 * 这里全部是 `src/api/` 现有函数的语义包装 —— **零新业务逻辑**。
 * 应用内 AI 直接调；外部 MCP 客户端要协议时由壳翻译成 tools/list。
 */

import { apiBase, fetchSearchAllWait, fetchSites } from '@/api'
import { rankGroups } from '@/api/searchRank'
import { siteAffinity } from '@/api/searchAffinity'
import { fetchServerLogs } from '@/api/logs'
import { fetchHealthState } from '@/api/health'
import { fetchLibrary, listCache, listCacheGrouped, type CachedVod } from '@/api/library'
import { getPrefs } from '@/stores/prefs'
import { diagnose, collectSources, type Diagnosis, type DiagSources } from './diagnose'

// ---------------------------------------------------------------- 工具结果

export interface ToolResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** 这次调用做了什么（给 AI 与日志用，一句话） */
  summary?: string
}

function ok<T>(data: T, summary: string): ToolResult<T> {
  return { ok: true, data, summary }
}

function fail<T>(error: string): ToolResult<T> {
  return { ok: false, error }
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${apiBase()}${path}`)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

/**
 * POST + JSON body。
 *
 * ★ `/api/{site}/{action}` 的分派**只读 body，完全忽略 query**
 * （ApiServer 里是 `read(ex.getRequestBody())` 后直接 `call(site, action, body)`）。
 * 所以 site 域的所有动作——detail / play / category / search——都必须用 POST。
 *
 * ★ 这个 bug 特别阴：GET + query **不会报错，会返回 200 和一个空壳 list**。
 *   实测 `GET /api/AppGet/detail?ids=17688` → `{list:[{vod_name:null, vod_play_from:"", ...}]}`，
 *   同参数 POST → `vod_name="庆余年 第一季"` + 6871 字节的 vod_play_url。
 *   于是 meow_play 走到 `parseLines('')` 得 0 条线路，报"该片没有播放源"，
 *   AI 换线路重试全部同样失败——而手动点播放（走 POST）完全正常，
 *   所以从界面上看像是"AI 坏了但应用没坏"。
 */
async function postJson<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 1. meow_state

export interface MeowState {
  version: string
  sites: number
  ext: number
  capabilities: string[]
  degraded: Array<{ site: string; failures?: number; lastError?: string }>
  disabled: string[]
  /** 最近的 warn/error（最多 3 条）。全量日志用 meow_logs 按需取 */
  logs: Array<{ level: string; tag?: string; text: string }>
  /** 采样窗口内各级别条数（info/warn/error） */
  logCounts?: Record<string, number>
  /** 可用的日志模块标签 —— meow_logs 的 tag 参数就从这里选 */
  logTags?: string[]
  /** 日志不可用的原因（旧后端无 /api/logs 时给出） */
  logHint?: string
  route: string
}

/**
 * AI 的"眼睛"。任何操作前先调它建立上下文。
 *
 * 为什么把 4 个端点的结果合成一个：分开调要 4 轮往返，
 * 而 AI 每次对话开头都用得上——合并后一次就够。
 */
export async function meowState(): Promise<ToolResult<MeowState>> {
  try {
    const [health, hs, logs] = await Promise.all([
      getJson<any>('/api/health'),
      fetchHealthState().catch(() => null),
      /*
       * ★ 取 200 条再自己裁，而不是"最后 20 条"（2026-11-02 实测改）。
       *
       * 实测运行中的缓冲区里，最后 20 条**全是** `GET /api/...` 请求日志，
       * warn/error 零条 —— 原来那句"最近日志"对 AI 毫无信息量，
       * 真出事时那条 error 早被挤出窗口。
       *
       * 这里只回**概况**（各级别条数 + 最近几条异常 + 有哪些模块），
       * 具体日志让模型自己按需调 meow_logs（行数/级别/模块由它决定）。
       */
      fetchServerLogs({ limit: 200 }).catch(() => null),
    ])
    if (!health) return fail('后端不可达（/api/health 无响应）')
    const allLogs: LogEntry[] =
      logs && logs.state === 'ok' && logs.data
        ? (logs.data.items || []).map((i: any) => ({
            at: Number(i.at) || 0,
            level: String(i.level || 'info'),
            tag: String(i.tag || ''),
            text: String(i.text || ''),
          }))
        : []
    const logCounts = allLogs.reduce<Record<string, number>>((a, e) => {
      a[e.level] = (a[e.level] || 0) + 1
      return a
    }, {})
    // 最近 3 条异常：这是"建立上下文"阶段唯一有信息量的日志
    const recentAbnormal = allLogs
      .filter((e) => e.level === 'error' || e.level === 'warn')
      .slice(-3)
      .map((e) => ({ level: e.level, tag: e.tag, text: e.text.slice(0, 120) }))
    // 可用模块标签：告诉模型 meow_logs 的 tag 能填什么
    const logTags = Array.from(new Set(allLogs.map((e) => e.tag).filter(Boolean))).slice(0, 12)
    // 同 meowSources：健康明细才是真源，顶层数组在冷启动时是空的
    const detail = (hs?.sites || {}) as Record<
      string,
      { degraded?: boolean; disabled?: boolean; fail?: number; lastError?: string }
    >
    const degradedList = Object.keys(detail)
      .filter((k) => detail[k]?.degraded || (hs?.degraded || []).includes(k))
      .map((k) => ({
        site: k,
        failures: detail[k]?.fail,
        lastError: detail[k]?.lastError || undefined,
      }))
    const disabledList = Object.keys(detail).filter(
      (k) => detail[k]?.disabled || (hs?.disabled || []).includes(k),
    )
    const logHint =
      logs && logs.state === 'unsupported'
        ? '后端版本较旧，无 /api/logs（meow_logs 也不可用）'
        : undefined
    return ok(
      {
        version: String(health.version || ''),
        sites: Number(health.sites || 0),
        ext: Number(health.ext || 0),
        capabilities: (health.capabilities || []) as string[],
        degraded: degradedList,
        disabled: disabledList,
        logs: recentAbnormal,
        logCounts,
        logTags,
        logHint,
        route: location.hash || '',
      },
      `后端 ${health.version}，${health.sites} 源，${degradedList.length} 个降级`
        + `；日志 ${allLogs.length} 条（warn ${logCounts.warn || 0} / error ${logCounts.error || 0}）`,
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 2. meow_diagnose

export interface DiagnoseInput extends Partial<DiagSources> {
  /** 把后端日志也拉进来（默认 true；AI 追问时可能只想要本地证据） */
  withBackendLogs?: boolean
}

/**
 * 核心价值：一次把"为什么播不了"的因果链拼出来。
 *
 * 规则层先行（§2.2）：零 LLM 依赖、100ms 出结论、断网也能跑。
 * explanation 字段这里**永远是 null** —— 人话由上层调 LLM 补，
 * 前端不该因为"没配模型"而改变 UI（§2.6）。
 */
export async function meowDiagnose(
  input: DiagnoseInput = {},
): Promise<ToolResult<Diagnosis>> {
  try {
    const src = collectSources(input)
    if (input.withBackendLogs !== false) {
      const logs = await fetchServerLogs({ limit: 60 }).catch(() => null)
      if (logs && logs.state === 'ok' && logs.data) {
        src.backendLogs = (logs.data.items || []).map((i: any) => ({
          level: i.level,
          tag: i.tag,
          text: i.text,
        }))
      }
    }
    const d = diagnose(src)
    const summary = d.cause
      ? `诊断：${d.cause.code}（${d.cause.confidence}）`
      : '诊断：未发现已知故障特征'
    return ok(d, summary)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 3. meow_search

export interface SearchHit {
  name: string
  year?: string
  remarks?: string
  pic?: string
  sources: Array<{ site: string; vod_id: string }>
}

/**
 * 不该被当成片名去搜的词。
 *
 * ★ 这是**代码级兜底**，不是给模型看的知识——提示词里已经写了"这些情况不要搜"，
 *   但弱模型仍会犯（实测 deepseek 把"那就放它吧"当关键词，搜出
 *   「扶你青云反成仇，那就放你尘埃」这种无关片）。这里拦住高频的应答词，
 *   让工具直接返回一个明确的"这不是片名"错误，模型就会改口问用户。
 *
 * 只拦**整句就是应答词**的情况：片名里含"好"字（「你好，李焕英」）不受影响。
 */
const NON_TITLE_RE =
  /^(那就|那就放|就|好|行|可以|嗯|对|是|开始|放吧|播吧|看吧|它|这个|那个|第一个|刚才那个|还有别的吗|换一个|换个源|继续)\s*[吧了呢啊。！?？!]*$/

/**
 * 最常用入口。返回**结构化**结果而不是让 AI 从 DOM 读卡片。
 *
 * ★ 排序必须在 `slice(0, limit)` **之前**（2026-11-02）。
 *   后端返回的分组顺序是"哪个源先返回谁在前"，且没有跨源归并
 *   （`SearchGroup` 的 key 是 `源+片名+id`，不是片名）。实测《我不是大师》：
 *   正剧被挤到第 25 位之后，前 6 条是"我不是酒神"和哔哩解说。
 *   所以这里按 `rankGroups` 重排再截断，AI 面板拿到的前 6 条才是正片。
 */
export async function meowSearch(
  keyword: string,
  opts: { limit?: number } = {},
): Promise<ToolResult<SearchHit[]>> {
  const wd = keyword.trim()
  if (!wd) return fail('keyword 不能为空')
  // 关键词太短或无实义 → 明确告诉模型"这不能当片名搜"，
  // 而不是让它拿回一堆无关结果再当真的用。
  if (wd.length < 2 || NON_TITLE_RE.test(wd)) {
    return fail(
      `「${wd}」不是片名，不能用来搜索。如果用户在回应上一轮，请直接用上一轮确认过的片名和 site/vod_id 调 meow_play；否则先问用户是哪部片。`,
    )
  }
  try {
    /*
     * 走异步接口而不是同步的 fetchSearchAll：
     * AI 需要完整结果（不能只拿首屏几条），但不该占住一个请求线程 5~8 秒 ——
     * 请求池只有 12 个，AI 对话期间用户看搜索页会互相拖慢。
     *
     * 并发数取设置页的 `searchThreads`（原来写死 8）：并发是用户的选择，
     * 搜索页和 AI 走同一个值，不然"同一个词 AI 比搜索框慢"会被当成 bug。
     */
    const threads = Number(getPrefs().searchThreads) || 8
    const r = await fetchSearchAllWait(wd, threads)
    const limit = opts.limit ?? 20
    // 先排序再截断：后端顺序是源返回顺序，直接截断会只拿到先返回的那批
    const ranked = rankGroups(r.groups || [], wd, await siteAffinity())
    const list: SearchHit[] = ranked.slice(0, limit).map((g) => ({
      name: g.vod_name || '',
      remarks: g.vod_remarks,
      pic: g.vod_pic,
      sources: (g.sources || []).map((c) => ({ site: c.site, vod_id: c.vod_id })),
    }))
    return ok(list, `「${wd}」命中 ${list.length} 部（${r.groups?.length || 0} 组）`)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 4. meow_sources

export interface SourceHealth {
  total: number
  sites: Array<{
    key: string
    name: string
    degraded: boolean
    disabled: boolean
    /** 连续失败次数（健康表里有记录时才有） */
    fail?: number
    lastError?: string
  }>
}

export async function meowSources(): Promise<ToolResult<SourceHealth>> {
  try {
    const [sites, hs] = await Promise.all([
      fetchSites(),
      fetchHealthState().catch(() => null),
    ])
    // ★ 别只信顶层 degraded/disabled 数组：健康表是按需建立的（某个源被调用过
    //   才会出现一条记录），顶层数组在"刚启动还没跑过请求"时是空的。
    //   以 sites 明细为真源，顶层数组只作为补充。
    const detail = (hs?.sites || {}) as Record<
      string,
      { degraded?: boolean; disabled?: boolean; fail?: number; streak?: number; lastError?: string }
    >
    const degraded = new Set<string>([
      ...(hs?.degraded || []),
      ...Object.keys(detail).filter((k) => detail[k]?.degraded),
    ])
    const disabled = new Set<string>([
      ...((hs?.disabled || []) as string[]),
      ...Object.keys(detail).filter((k) => detail[k]?.disabled),
    ])
    const list = (sites || []).map((s: any) => {
      const k = String(s.key)
      const d = detail[k]
      return {
        key: k,
        name: String(s.name || k),
        degraded: degraded.has(k),
        disabled: disabled.has(k),
        fail: d?.fail,
        lastError: d?.lastError || undefined,
      }
    })
    return ok(
      { total: list.length, sites: list },
      `${list.length} 源，${degraded.size} 降级 / ${disabled.size} 停用`,
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 5. meow_cache

export interface CacheSummary {
  tasks: number
  unfinished: number
  bytes: number
  /** 按剧聚合后的条数（一剧一条，见后端的 grouped 端点） */
  vods?: number
  /** 每部剧的剧名/集数/占用，最多列 8 条 */
  list?: Array<{ name: string; done: number; total: number; bytes: number; downloading: number }>
  /** 弹幕缓存占用（老后端没有这个字段） */
  danmakuBytes?: number
}

/**
 * 缓存查询：列出已缓存/正在下的剧。
 *
 * <p><b>为什么读 grouped 而不是平铺 list</b>：用户问"我缓存了什么"要的是
 * 剧名（「我不是大师 3 集」），平铺 list 给的是"我不是大师 1 / 我不是大师 2 …"，
 * 24 集就 24 行，AI 复述出来是一堆噪音。
 */
export async function meowCache(action: 'list' = 'list'): Promise<ToolResult<CacheSummary>> {
  if (action !== 'list') {
    return fail(`action=${action} 尚未实现（当前只支持 list）`)
  }
  try {
    const [g, r] = await Promise.all([
      listCacheGrouped().catch(() => null),
      listCache().catch(() => null),
    ])
    const vods = (g?.items || []) as CachedVod[]
    const tasks = ((r as any)?.items || []) as any[]
    const unfinished = tasks.filter((t) => t.state && t.state !== 'done').length
    const bytes = vods.length
      ? vods.reduce((a, v) => a + Number(v.totalBytes || 0), 0)
      : tasks.reduce((a, t) => a + Number(t.bytes || 0), 0)
    const list = vods.slice(0, 8).map((v) => ({
      name: v.name || v.vodId,
      done: v.doneEpisodes,
      total: v.episodes,
      bytes: v.totalBytes,
      downloading: v.downloading,
    }))
    const dm = (r as any)?.danmakuBytes
    const summary = vods.length
      ? `已缓存 ${vods.length} 部（其中 ${vods.reduce((a, v) => a + v.downloading, 0)} 集在下载）`
      : '还没有缓存任何片子'
    return ok(
      {
        tasks: tasks.length,
        unfinished,
        bytes,
        vods: vods.length,
        list,
        ...(typeof dm === 'number' ? { danmakuBytes: dm } : {}),
      },
      summary,
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 5b. meow_cache_start

export interface CacheStartInput {
  site: string
  vod_id: string
  /** 只下这几集（集名/集号）；不传 = 整季 */
  episodes?: string[]
  /** 线路名；不传用第一条能用的 */
  line?: string
}

/**
 * 开始缓存（整季或指定集）—— **只做前置解析，不真的下载**。
 *
 * <p><b>为什么不在工具里直接开始下载</b>：下载是写操作且耗流量/磁盘，
 * 按 §4.9 纪律二必须由用户确认，不能给模型自主决定。
 * 所以这个工具只做"把每一集的可下载直链解析出来"这件无副作用的事，
 * 把结果交回 UI，由 UI 弹确认框、用户点了才真正入队
 * （见 AiPanel 的 pendingCache 流程）。
 *
 * <p><b>为什么解析要在这里做而不是确认后</b>：解析每集要打一次 `/api/play`，
 * 整季 24 集要十几秒。放在确认之后会让用户面对一个"点了确认却卡很久"的按钮；
 * 放在确认之前，确认框里能直接显示"12 集，共 3.4 GB"这种可判断的信息。
 */
export async function meowCacheStart(
  input: CacheStartInput,
): Promise<ToolResult<CachePlan>> {
  const { site, vod_id } = input
  if (!site || !vod_id) return fail('需要 site 与 vod_id')
  try {
    const det = await postJson<any>(`/api/${encodeURIComponent(site)}/detail`, { id: vod_id })
    const v = det?.list?.[0]
    if (!v) return fail('详情为空（源可能已失效）')
    const lines = parseLines(v.vod_play_from || '', v.vod_play_url || '')
    if (!lines.length) return fail('该片没有播放源，无法缓存')

    const line = input.line
      ? lines.find((l) => l.name === input.line) || lines[0]
      : lines[0]
    let eps = line.episodes
    if (input.episodes?.length) {
      const want = input.episodes.map((s) => String(s).trim())
      eps = eps.filter((e) => want.includes(e.name) || want.includes(epNoOf(e.name)))
      if (!eps.length) return fail(`这条线路里找不到要缓存的集：${want.join('、')}`)
    }

    const items: Array<{ ep: string; name: string; url: string }> = []
    for (const e of eps) {
      const r = await postJson<any>(`/api/play`, {
        site,
        id: e.url,
        flag: line.name,
      })
      const url = typeof r?.url === 'string' ? r.url : ''
      // 拿不到 http 直链的集直接跳过：硬提会给后端一堆注定失败的下载
      if (!/^https?:/i.test(url)) continue
      items.push({ ep: e.name, name: `${v.vod_name || vod_id} ${e.name}`, url })
    }
    if (!items.length) {
      return fail('这一线路的地址都需要解析器，拿不到可下载的直链，暂时无法缓存')
    }

    return ok(
      {
        kind: 'cache-plan',
        site,
        vodId: String(v.vod_id || vod_id),
        name: String(v.vod_name || vod_id),
        line: line.name,
        items,
        skipped: eps.length - items.length,
        poster: typeof v.vod_pic === 'string' ? v.vod_pic : '',
        vodName: String(v.vod_name || ''),
        vodYear: String(v.vod_year || ''),
        vodArea: String(v.vod_area || ''),
        vodRemarks: String(v.vod_remarks || ''),
      },
      `已解析《${v.vod_name || vod_id}》${items.length} 集，等你确认后开始下载`,
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/** 待确认的缓存计划。UI 拿它弹确认框，用户点确认才真正提交。 */
export interface CachePlan {
  kind: 'cache-plan'
  site: string
  vodId: string
  name: string
  line: string
  items: Array<{ ep: string; name: string; url: string }>
  /** 因为拿不到直链而跳过的集数 */
  skipped: number
  poster: string
  vodName: string
  vodYear: string
  vodArea: string
  vodRemarks: string
}

/** 「第3集」→ "3"；已经是数字就原样返回。 */
function epNoOf(name: string): string {
  const m = /(\d{1,4})/.exec(name || '')
  return m ? m[1] : name
}

// ---------------------------------------------------------------- 6. meow_library

export async function meowLibrary(): Promise<ToolResult<unknown>> {
  try {
    const ov = await fetchLibrary()
    return ok(
      { libs: ov.libs, tops: (ov.tops || []).map((t) => ({ id: t.id, name: t.name, dirs: (t.dirs || []).length })) },
      `${ov.libs.length} 个片库`,
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 7. meow_danmaku

export async function meowDanmaku(query: {
  name?: string
  episode?: string
}): Promise<ToolResult<unknown>> {
  const q = new URLSearchParams()
  if (query.name) q.set('name', query.name)
  if (query.episode) q.set('episode', query.episode)
  if (!q.toString()) return fail('需要 name 或 episode')
  const r = await getJson<any>(`/api/proxy/danmaku/search?${q}`)
  if (!r) return fail('弹幕接口无响应')
  return ok(r, `弹幕候选 ${(r.candidates || []).length} 个`)
}

// ---------------------------------------------------------------- 8. meow_live

export async function meowLive(): Promise<ToolResult<unknown>> {
  const r = await getJson<any>('/api/live')
  if (!r) return fail('直播接口无响应')
  // ★ 后端返回的是 {tried, playlists, groups, failed}，**没有 channels**。
  //   读错字段会让"有台"误报成"0 个频道"——实测踩过：tried=27 / failed=27
  //   那次真因是当天上游全挂，但工具说的是"0 个频道"，看不出区别。
  const groups = (r.groups || []) as Array<{ channels?: unknown[] }>
  const n = groups.reduce((s, g) => s + (g.channels?.length || 0), 0)
  const failed = Number(r.failed || 0)
  const tried = Number(r.tried || 0)
  const summary =
    n > 0
      ? `直播 ${groups.length} 组 / ${n} 个频道${failed ? `（${failed}/${tried} 源失败）` : ''}`
      : tried > 0
        ? `直播源全部失败（${failed}/${tried}）——上游当天不可用，不是应用问题`
        : '直播未配置源'
  return ok(r, summary)
}

// ---------------------------------------------------------------- 9. meow_play

export interface PlayInput {
  site: string
  vod_id: string
  /** 不传就用第一条线路的第一集 */
  line?: string
  episode?: string
}

/**
 * 一次完成"选线路 + 选集 + 播放"。
 *
 * **内部必须带失败换线**（§1.6）：线路挨个试，第一个能拿到 url 的就是它。
 * 注意这里只到"拿到可播地址"为止 —— 真正跳播放页交给调用方，
 * 因为跳转在应用内是 router.push，在 MCP 场景下要由壳决定。
 */
export async function meowPlay(
  input: PlayInput,
): Promise<ToolResult<{ url: string; line: string; episode: string; tried: string[] }>> {
  const { site, vod_id } = input
  if (!site || !vod_id) return fail('需要 site 与 vod_id')
  try {
    const det = await postJson<any>(`/api/${encodeURIComponent(site)}/detail`, { id: vod_id })
    const v = det?.list?.[0]
    if (!v) return fail('详情为空（源可能已失效）')
    const lines = parseLines(v.vod_play_from || '', v.vod_play_url || '')
    if (!lines.length) return fail('该片没有播放源')

    const order = input.line
      ? [lines.find((l) => l.name === input.line), ...lines].filter(Boolean)
      : lines
    const tried: string[] = []
    for (const line of order as Array<{ name: string; episodes: Array<{ name: string; url: string }> }>) {
      if (!line) continue
      tried.push(line.name)
      const eps = line.episodes
      const ep = input.episode ? pickEpisode(eps, input.episode) : eps[0]
      if (!ep) continue
      const pr = await postJson<any>(`/api/${encodeURIComponent(site)}/play`, {
        flag: line.name,
        id: ep.url,
      })
      const url = pr?.url || pr?.data?.url || ''
      if (url) {
        return ok({ url, line: line.name, episode: ep.name, tried }, `线路「${line.name}」可播`)
      }
    }
    return fail(`试过 ${tried.length} 条线路都拿不到可播地址`)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * 从剧集表里挑出第 N 集。
 *
 * ★ 不能用 `name.includes(n)`：源站集名形如「第14集」「第04集」「EP4」，
 *   用 '4' 去 includes 会先命中「第14集」——用户要第 4 集，播的是第 14 集。
 *   这是最坏的一类 bug：能播、画面正常、但集数错了。
 *
 * ★ 入参可能不是数字：模型会把用户原话里的「第一集」直接传进来。
 *   `Number('第一集')` 是 NaN，原来会落到"精确/包含匹配"分支，
 *   而源站集名是 '1'、'第01集'，一条都对不上 —— 表现为"试过 6 条线路都拿不到地址"。
 *   所以先把中文数字归一化，再走数字比较。
 */
const CN_DIGIT: Record<string, string> = {
  零: '0', 一: '1', 二: '2', 三: '3', 四: '4', 五: '5',
  六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
}

/** 从「第一集」「第01集」「EP4」「1集」里抽出数字；抽不出返回 null */
export function episodeNumber(s: string): number | null {
  const t = s.trim()
  // 阿拉伯数字优先（1 / 01 / 第12集 / EP3）
  const m = /([0-9]{1,4})/.exec(t)
  if (m) return Number(m[1])
  // 中文数字：一字一位（支持到十九；"二十"这类走下面两步）
  const cn = /[零一二三四五六七八九十]+/.exec(t)
  if (cn) {
    const raw = cn[0]
    if (raw.length === 1) return Number(CN_DIGIT[raw] ?? NaN)
    // 十X / X十 / X十Y
    const tens = raw.indexOf('十')
    if (tens >= 0) {
      const hi = tens === 0 ? 1 : Number(CN_DIGIT[raw[0]] ?? NaN)
      const lo = tens === raw.length - 1 ? 0 : Number(CN_DIGIT[raw[tens + 1]] ?? NaN)
      if (Number.isFinite(hi) && Number.isFinite(lo)) return hi * 10 + lo
    }
  }
  return null
}

function pickEpisode<T extends { name: string }>(eps: T[], want: string): T | null {
  const wantNum = episodeNumber(want)
  if (wantNum === null || !Number.isFinite(wantNum)) {
    // 非数字集名（"预告"）：退回精确包含
    return eps.find((e) => e.name === want) || eps.find((e) => e.name.includes(want)) || null
  }
  for (const e of eps) {
    const n = episodeNumber(e.name)
    if (n === wantNum) return e
  }
  return null
}

/** 与 `api/index.ts` 的 parsePlayLines 同规则（后端 vod_play_from / vod_play_url 三格式） */
function parseLines(
  from: string,
  url: string,
): Array<{ name: string; episodes: Array<{ name: string; url: string }> }> {
  const names = from.split('$$$').filter(Boolean)
  const groups = url.split('$$$')
  return groups.map((g, i) => ({
    name: names[i] || `线路${i + 1}`,
    episodes: g
      .split('#')
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('$')
        if (idx < 0) return { name: part, url: part }
        return { name: part.slice(0, idx), url: part.slice(idx + 1) }
      })
      .filter((e) => !!e.url),
  }))
}

// ---------------------------------------------------------------- 11. meow_logs

/** 日志筛选条件。**全部由模型决定**，不在代码里替它预设"看多少条/什么级别"。 */
export interface LogsInput {
  /** 最低级别：只看该级别及以上（info < warn < error） */
  minLevel?: 'info' | 'warn' | 'error'
  /** 模块标签，精确匹配（可用值见 meow_state 的 logTags） */
  tag?: string
  /** 关键词，匹配正文或标签，不区分大小写 */
  keyword?: string
  /** 只看最近多少分钟 */
  minutes?: number
  /** 最多返回多少条（默认 50，上限 500）。取**最新的** limit 条 */
  limit?: number
}

export interface LogEntry {
  id?: number
  at: number
  level: string
  tag: string
  text: string
}

const LEVEL_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 }

/**
 * 纯函数：按条件裁剪日志。抽出来是为了单测（不依赖 fetch）。
 *
 * <p><b>为什么这些条件都在前端筛、不交给后端</b>：
 *   · 后端 `level` 是**精确匹配**（warn 不含 error），而模型说"warn 及以上"
 *     是最自然的表达，前端按 rank 过滤才对得上；
 *   · 后端 `since` 是**日志 id** 不是时间戳，模型没有 id 的概念；
 *   · 关键词过滤后端本来就不支持（`LogsView` 也是前端筛的）。
 * 后端只负责"最多给 2000 条"这个全量窗口。
 */
export function filterLogs(
  all: LogEntry[],
  input: LogsInput,
  now = Date.now(),
): { items: LogEntry[]; matched: number; scanned: number } {
  const minRank = LEVEL_RANK[input.minLevel || 'info'] ?? 0
  const tag = (input.tag || '').trim()
  const kw = (input.keyword || '').trim().toLowerCase()
  const since = input.minutes && input.minutes > 0 ? now - input.minutes * 60_000 : 0
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50) || 50, 1), 500)
  const hit = all.filter(
    (e) =>
      (LEVEL_RANK[e.level] ?? 0) >= minRank &&
      (!tag || e.tag === tag) &&
      (!since || (e.at || 0) >= since) &&
      (!kw ||
        (e.text || '').toLowerCase().includes(kw) ||
        (e.tag || '').toLowerCase().includes(kw)),
  )
  return { items: hit.slice(-limit), matched: hit.length, scanned: all.length }
}

/**
 * 日志查询。
 *
 * <p><b>为什么必须有这个工具</b>（2026-11-02 实测）：`meow_state` 原来固定取
 * "最后 20 条"，而实测运行中的缓冲区里那 20 条**全是** `GET /api/...` 这类
 * 请求噪音、warn/error 零条 —— AI 看到的"最近日志"信息量为零，
 * 真出事时那条 error 早被挤出窗口。
 *
 * <p>现在把**看多少条、什么级别、哪个模块、多长时间窗**全交给模型：
 * 它按用户问题决定（"刚才报什么错" → `minLevel:'warn', minutes:5`；
 * "后端是不是卡了" → `tag:'req', limit:100`）。
 */
export async function meowLogs(input: LogsInput = {}): Promise<ToolResult<{
  items: LogEntry[]
  matched: number
  scanned: number
  availableTags?: string[]
}>> {
  try {
    // 2000 = 后端环形缓冲容量，也是它单次能给的上限
    const r = await fetchServerLogs({ limit: 2000 }).catch(() => null)
    if (!r) return fail('后端不可达（/api/logs 无响应）')
    if (r.state === 'unsupported') {
      // 旧后端没有这个端点：明确区分"没有日志"与"读不到日志"
      return fail(r.detail || '后端版本较旧，没有 /api/logs 端点（需要 0.9.16+）')
    }
    if (r.state === 'unreachable') return fail(`连不上后端：${r.detail || ''}`)
    if (r.state !== 'ok' || !r.data) return fail(r.detail || '读取日志失败')

    const all: LogEntry[] = (r.data.items || []).map((i: any) => ({
      id: typeof i.id === 'number' ? i.id : undefined,
      at: Number(i.at) || 0,
      level: String(i.level || 'info'),
      tag: String(i.tag || ''),
      text: String(i.text || ''),
    }))
    const { items, matched, scanned } = filterLogs(all, input)

    if (!items.length) {
      /*
       * 空结果要给出**可操作的下一步**，否则模型只会说"没有日志"。
       * 列出真实存在的模块标签，它下一轮就能把 tag 调对。
       */
      const tags = Array.from(new Set(all.map((e) => e.tag).filter(Boolean))).slice(0, 12)
      return ok(
        { items: [], matched: 0, scanned, availableTags: tags },
        `没有匹配的日志（扫描 ${scanned} 条）。可用模块：${tags.join('、') || '无'}`,
      )
    }
    const lv = items.reduce<Record<string, number>>((a, e) => {
      a[e.level] = (a[e.level] || 0) + 1
      return a
    }, {})
    const lvText = Object.entries(lv).map(([k, v]) => `${k} ${v}`).join(' / ')
    return ok(
      { items, matched, scanned },
      `${items.length} 条（${lvText}）；共匹配 ${matched} 条 / 扫描 ${scanned} 条`,
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

// ---------------------------------------------------------------- 工具清单

/**
 * 给 MCP `tools/list` 用的定义。
 *
 * 只列元数据（名字/描述/参数），不绑执行器——执行器由调用方按名字查表。
 * 描述里刻意写「什么时候用它」，模型靠这个选工具（§一 规模建议 9 个）。
 */
export const TOOL_DEFS = [
  { name: 'meow_state', desc: '建立上下文：版本、站点数、降级源、日志概况与可用日志模块。任何操作前先调。要看具体日志再调 meow_logs。', args: [] },
  { name: 'meow_logs', desc: '查后端日志（2000 条环形缓冲）。用户问"刚才报什么错/为什么失败/后端怎么了"，或 meow_diagnose 的结论不够、需要按级别/模块/时间窗确认时用它。条件由你决定：拿不准就先不带条件取 50 条看全局，再按需收窄。', args: ['minLevel?', 'tag?', 'keyword?', 'minutes?', 'limit?'] },
  { name: 'meow_diagnose', desc: '解释"为什么播不了"：返回 cause/evidence/suggestion。', args: ['withBackendLogs'] },
  { name: 'meow_search', desc: '按片名搜片，跨源合并，返回可播来源列表。', args: ['keyword', 'limit'] },
  { name: 'meow_play', desc: '选线路+选集+拿可播地址，内部自动换线。', args: ['site', 'vod_id', 'line?', 'episode?'] },
  { name: 'meow_sources', desc: '源健康清单：可用/降级/停用。', args: [] },
  { name: 'meow_cache', desc: '查缓存：已缓存哪几部、各下到第几集、占多少空间、有无在下载。用户问"我缓存了什么/下完没/占多大"时用它。', args: ['action=list'] },
  { name: 'meow_cache_start', desc: '解析出一部片可下载的直链，准备缓存（**不直接下载**，结果交给界面让用户确认）。用户说"帮我缓存/下载这部/缓存第3集"且已有 site 与 vod_id 时用它。', args: ['site', 'vod_id', 'episodes?', 'line?'] },
  { name: 'meow_library', desc: '本地/NAS 片库概览。', args: [] },
  { name: 'meow_danmaku', desc: '弹幕源诊断：这部为什么没弹幕。', args: ['name?', 'episode?'] },
  { name: 'meow_live', desc: '直播频道与坏台情况。', args: [] },
] as const

export const TOOL_IMPL = {
  meow_state: meowState,
  meow_logs: meowLogs,
  meow_diagnose: meowDiagnose,
  meow_search: meowSearch,
  meow_play: meowPlay,
  meow_sources: meowSources,
  meow_cache: meowCache,
  meow_cache_start: meowCacheStart,
  meow_library: meowLibrary,
  meow_danmaku: meowDanmaku,
  meow_live: meowLive,
} as const
