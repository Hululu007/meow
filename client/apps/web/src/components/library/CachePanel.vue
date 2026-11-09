<script setup lang="ts">
/**
 * 缓存面板：已下载/下载中/待续传的剧集。
 *
 * 同一份组件被两处使用——片库页顶部（compact=true，作为「我的缓存」分区）
 * 与 /offline 路由（compact=false，兼容旧书签与深链）。
 * 抽出来是为了避免两套列表逻辑不一致（此前就有过设置页与离线页各写一份的教训）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  cacheExportUrl,
  controlCache,
  fmtSize,
  listCache,
  listCacheGrouped,
  type CacheTask,
  type CachedEpisode,
  type CachedVod,
} from '@/api/library'
import {
  fetchBatchList,
  fetchBatchStatus,
  fetchCacheTasks,
  resumeCacheTasks,
  type BatchStatus,
  type UnfinishedTask,
} from '@/api/library'
import { colsStyle, useCardCols } from '@/composables/useCardCols'

/** true 时作为片库页的内嵌分区渲染（标题降级） */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

/**
 * 离线缓存列表：已下载可直接播、下载中显示进度、未完成可续传。
 *
 * <p><b>为什么播放跳 /play</b>：播放页已实现「优先本地清单」
 * （PlayView 的 pickCachedPlaylist），复用它才能拿到进度记忆、弹幕、连播；
 * 在这里另写一个播放器只会是第二套不一致的行为。
 *
 * <p><b>批次进度与单集进度是两条通道</b>：批次端点回答"整季下到哪了"，
 * 单集 `GET /api/cache?id=` 回答"这一集能不能播"，两者不重复。
 */

const router = useRouter()
const totalBytes = ref(0)
const quotaBytes = ref(0)
const evictMode = ref('lru')
const cacheDir = ref('')
const loading = ref(true)
const error = ref('')

/**
 * 按剧聚合的缓存（一剧一张海报卡片）—— 2026-10-30 改版的主数据源。
 *
 * <p>原来是一集一张小卡片，一部 24 集的剧会铺满 24 格，海报重复 24 次、
 * 用户根本分不清"这部剧我下到第几集了"。现在一剧一格，点开才看集数。
 */
const vods = ref<CachedVod[]>([])
/**
 * 海报墙用和本地片库同一套列数算法。
 *
 * 原来是写死的 `grid-cols-2 sm:3 lg:4 xl:5`：1000px 宽时只给 3 列，
 * 每张卡 300px 宽、450px 高，比片库页的卡大一圈（用户实测："卡片过大吧，
 * 对齐本地片库"）。按卡宽算列数才能和片库/首页一致。
 */
const { cols } = useCardCols({ maxWidth: 1400 })
/**
 * 点开的剧（非空时整页切到「缓存详情」层）。
 *
 * ★ 不用 Teleport 弹框（2026-10-30 用户要求）：TV 上弹框要在两层之间挪焦点，
 *   退层还得先关弹框再关详情——"套深沉面板 tv 不好操作"。
 *   改成和本地片库同一套「页面内换层」：海报墙 ⇄ 详情，返回键一级一级退。
 */
const openedVod = ref<CachedVod | null>(null)
/** 选集网格里当前聚焦/选中的集（下面的单集操作条按它生效） */
const selEp = ref('')
/** 正在执行控制动作的集 id */
const ctrlBusy = ref<Record<string, boolean>>({})

/** 批次概览（每个整季下载一条） */
const batches = ref<BatchStatus[]>([])
/** 重启前被打断 / 失败可续的任务 */
const unfinished = ref<UnfinishedTask[]>([])
const resuming = ref('')
const resumeMsg = ref('')

/**
 * 注：``playable`` / ``inProgress`` 两个按任务平铺的 computed 已删除
 * （2026-10-30 改版）。展示改成按剧聚合后，主视图不再按"单集状态"过滤；
 * 下载中的集由 ``activeEps()`` 从聚合视图里取，走「下载进度」弹框。
 */

/**
 * 还在跑的批次。全部跑完的批次不再轮询，但保留展示（用户要看"整季下完了吗"）。
 * state 的取值见 batchStatus：running / done / partial / failed。
 */
const liveBatches = computed(() => batches.value.filter((b) => b.state === 'running'))

/**
 * 未完成任务里真正需要用户动手的那些。
 *
 * 过滤掉"所属批次还在列表里"的全部任务：它们已经在批次卡片里逐集列出，
 * 失败的集在卡片上有「重试失败 N 集」，再在下面重复一份会让人以为有两套队列。
 * 判据必须带"批次还在"——批次记录 7 天会被剪枝（VideoCache.pruneOldEntries），
 * 任务上的 batchId 却留着，只看 batchId 会让这些任务永远不显示。
 */
const pendingList = computed(() => {
  const liveIds = new Set(batches.value.map((b) => b.batch))
  return unfinished.value.filter((t) => !(t.batchId && liveIds.has(t.batchId)))
})

/**
 * 可续传的条数。
 *
 * 只算 failed：`idle` 是批次里"还没轮到"的排队占位（后端 startBatch 先建占位
 * 再逐集 submit 到固定 2 路池），对它调 resume 会新起线程直接开跑、绕过队列。
 * running 的提交上去也只会原样返回，没必要算进按钮的可用性。
 */
const resumableCount = computed(() => pendingList.value.filter((t) => t.state === 'failed').length)

function batchStateText(b: BatchStatus): string {
  if (b.state === 'running') return `下载中 ${b.done}/${b.total}`
  if (b.state === 'done') return `已完成 ${b.total} 集`
  if (b.state === 'partial') return `部分失败：成功 ${b.done} / 失败 ${b.failed}`
  return `失败 ${b.failed} 集`
}

function batchStateClass(b: BatchStatus): string {
  if (b.state === 'running') return 'bg-accent/15 text-accent'
  if (b.state === 'done') return 'bg-ok/15 text-ok'
  if (b.state === 'partial') return 'bg-warn/15 text-warn'
  return 'bg-hot/15 text-hot'
}

function itemStateText(it: { state: string; percent?: number; error?: string }): string {
  if (it.state === 'done') return '已完成'
  if (it.state === 'running') return `下载中 ${it.percent || 0}%`
  if (it.state === 'failed') return it.error ? `失败：${it.error}` : '失败'
  if (it.state === 'canceled') return '已取消'
  return '排队中'
}

function itemStateClass(it: { state: string }): string {
  if (it.state === 'done') return 'text-ok'
  if (it.state === 'running') return 'text-accent'
  if (it.state === 'failed') return 'text-hot'
  return 'text-ink-3'
}

let pollTimer: number | undefined

/**
 * 拉取全部数据：可播列表 + 批次概览 + 未完成任务。
 *
 * 一次进页面要三个请求，但它们各自回答不同问题，合并成一个端点反而
 * 会让后端承担前端的展示形状（离线页与设置页的需求并不一样）。
 */
async function refresh(quiet = false) {
  if (!quiet) loading.value = true
  error.value = ''
  try {
    /*
     * 主数据走 `grouped`（一剧一条），但仍保留平铺 `listCache`：
     * 批次视图和"未完成任务"用的是任务级字段（done/total 分片数），
     * 聚合结构里没有这些。两个端点各回答一层问题，不合并。
     */
    const [g, r] = await Promise.all([listCacheGrouped(), listCache()])
    if (!r.ok && !g.ok) {
      error.value = '后端没有响应。离线内容存放在后端的数据目录里，后端不可达时读不到列表。'
      return
    }
    vods.value = g.items || []
    totalBytes.value = g.totalBytes || r.totalBytes || 0
    quotaBytes.value = r.quotaBytes || 0
    evictMode.value = r.evictMode || 'lru'
    cacheDir.value = r.cacheDir || ''
    // 打开中的剧要跟着刷新（否则进度弹框里的数字不动）
    if (openedVod.value) {
      const again = vods.value.find(
        (v) => v.site === openedVod.value!.site && v.vodId === openedVod.value!.vodId,
      )
      openedVod.value = again || null
    }
    const [bs, ut] = await Promise.all([
      fetchBatchList().catch(() => [] as BatchStatus[]),
      fetchCacheTasks().then((x) => x.items || []).catch(() => [] as UnfinishedTask[]),
    ])
    batches.value = bs
    unfinished.value = ut
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    // 轮询节奏跟着"还有没有在跑"走：全下完就停，避免空转
    schedulePoll()
  }
}

/**
 * 3 秒一次的静默刷新。
 *
 * 用 setTimeout 链而不是 setInterval：一个请求没回来就再排一次，
 * 慢后端下 setInterval 会堆积并发请求。卸载时由 onBeforeUnmount 清定时器。
 *
 * 正在跑的批次用 `GET /api/cache/status?batch=<id>` 逐个拉：概览端点
 * 返回的是全部批次，跑得久的整季会带着一堆已完成批次一起回来，
 * 而按 id 只取需要的那个。已结束的批次沿用上次结果，不再重复请求。
 *
 * 只在"还有东西在动"时轮询：有 running 的批次，或有一条单集任务在跑
 * （单集下载不走批次，播放页点的「下载到本机」就属于这种）。
 * 全部落定时停掉，避免页面开着就一直在打后端。
 */
function schedulePoll() {
  clearTimeout(pollTimer)
  const live = liveBatches.value
  const single = unfinished.value.some((t) => t.state === 'running')
  if (!live.length && !single) return
  pollTimer = window.setTimeout(async () => {
    if (live.length) {
      const updated = await Promise.all(
        live.map((b) => fetchBatchStatus(b.batch).catch(() => null)),
      )
      // 就地替换：保持顺序稳定，避免卡片跳动
      const byId = new Map<string, BatchStatus>()
      for (const b of updated) if (b) byId.set(b.batch, b)
      batches.value = batches.value.map((b) => byId.get(b.batch) || b)
    }
    // 批次推进时，可播列表与未完成任务都会变，顺手刷一次（失败不打断）
    try {
      const r = await listCache()
      if (r.ok) totalBytes.value = r.totalBytes || 0
    } catch {
      /* 同上 */
    }
    try {
      const ut = await fetchCacheTasks()
      unfinished.value = ut.items || []
    } catch {
      /* 同上 */
    }
    schedulePoll()
  }, 3000)
}

function play(t: CacheTask) {
  // 带上 site/vod/ep：播放页要靠它们复算缓存 id 并命中本地清单
  void router.push({
    name: 'play',
    params: { site: t.site || '' },
    query: {
      name: t.name || '',
      ep: t.ep || '',
      vod: t.vodId || '',
      flag: '',
      id: '',
    },
  })
}

/**
 * 从聚合卡片播某一集。
 *
 * 仍走 /play 而不是直接给 <video src>：播放页已有「优先本地清单」逻辑
 * （PlayView.pickCachedPlaylist），复用它才有进度记忆、连播、弹幕。
 * 这里只需要把 site/vodId/ep 三个值拼对。
 */
function playEpisode(v: CachedVod, epId: string) {
  const ep = v.eps.find((e) => e.id === epId)
  if (!ep) return
  void router.push({
    name: 'play',
    params: { site: v.site },
    query: {
      // 缓存时 name 存的是"剧名 第N集"，播放页要用它算弹幕的剧名
      name: ep.name || v.name,
      ep: ep.ep || '',
      vod: v.vodId || '',
      flag: '',
      id: '',
    },
  })
}

/** 一部剧里"能播的集"（清单已落盘）。 */
function playableEps(v: CachedVod) {
  return v.eps.filter((e) => e.playable)
}

/**
 * 从第一集可播的开始播 —— 详情层的「继续观看」用它。
 *
 * 一集都没下完时不弹任何东西：把焦点落到第一集，让用户看到下面的单集操作条
 * （以前这里弹「下载进度」弹框，2026-10-30 去掉了深层面板）。
 */
function playFirst(v: CachedVod) {
  const list = playableEps(v)
  if (!list.length) {
    selEp.value = v.eps[0]?.id || ''
    return
  }
  playEpisode(v, list[0].id)
}

/**
 * 进详情时记下"是谁打开的"，关闭时把焦点还给它。
 *
 * <p>不记的话：遥控器在海报卡片上按 OK 进详情、看完点返回，焦点框会悬在
 * 已卸载的卡片上（tv-nav 下次按键才重新找），用户视角是"焦点没了，得乱按一下"。
 * 优先用 tv-nav 当前高亮的那张卡（`.meow-tv-focus`），鼠标场景取点击目标。
 */
let detailOpener: HTMLElement | null = null

/** 点海报卡片进详情层。默认选中"最该操作的那一集"（在下的 → 第一个没下完的）。 */
function openDetail(v: CachedVod) {
  const hl = document.querySelector('.meow-tv-focus') as HTMLElement | null
  detailOpener = hl && document.contains(hl) ? hl : null
  openedVod.value = v
  const act = v.eps.find((e) => e.state === 'running') || v.eps.find((e) => !e.playable)
  selEp.value = act ? act.id : ''
}

function closeDetail() {
  openedVod.value = null
  selEp.value = ''
  const w = window as unknown as { __meowTvFocus?: (el: unknown, pin?: boolean) => boolean }
  if (detailOpener && document.contains(detailOpener) && typeof w.__meowTvFocus === 'function') {
    w.__meowTvFocus(detailOpener, true)
  }
  detailOpener = null
}

/** 选集网格里当前选中的那一集（单集操作条的数据源）。 */
const selEpObj = computed(() => {
  const v = openedVod.value
  if (!v || !selEp.value) return null
  return v.eps.find((e) => e.id === selEp.value) || null
})

/** 详情层副标题：年份 · 地区 · 备注，空字段不占位。 */
const detailMeta = computed(() => {
  const v = openedVod.value
  if (!v) return ''
  return [v.year, v.area, v.remarks].filter(Boolean).join(' · ')
})

/** 一部剧里"正在跑"的集（暂停不算：它已经不在跑，再点暂停没有意义）。 */
function runningEps(v: CachedVod) {
  return v.eps.filter((e) => e.state === 'running')
}

function epStateText(e: CachedEpisode): string {
  if (e.state === 'running') return `下载中 ${e.percent || 0}%`
  if (e.state === 'paused') return `已暂停 ${e.percent || 0}%`
  if (e.state === 'failed') return '失败'
  if (e.state === 'canceled') return '已取消'
  if (e.state === 'done') return '已缓存'
  return '排队中'
}

function epStateClass(e: CachedEpisode): string {
  if (e.state === 'running') return 'text-accent'
  if (e.state === 'paused') return 'text-warn'
  if (e.state === 'failed') return 'text-hot'
  return 'text-ink-3'
}

function epTitle(e: CachedEpisode): string {
  return `第 ${e.ep || '?'} 集 · ${epStateText(e)}` + (e.playable ? ' · 点击播放' : '')
}

/**
 * 选集格子的点击语义：能播就播，不能播就只选中。
 *
 * ★ 不能"不能播就弹进度框"（旧行为）：那正是用户说的深层面板。
 *   现在改成选中 → 下方操作条出现「继续下载 / 暂停 / 取消 / 删除」。
 *   能播的集点下去也会先 @focus 把 selEp 设上，所以从播放页退回来时
 *   操作条仍停在刚才那一集，不用再找。
 */
function onEpClick(v: CachedVod, e: CachedEpisode) {
  selEp.value = e.id
  if (e.playable) playEpisode(v, e.id)
}

/** 暂停 / 取消 / 删除（单集或整剧）。 */
async function control(action: 'pause' | 'cancel' | 'delete', ids: string[], key: string) {
  if (!ids.length) return
  if (action === 'delete') {
    const n = ids.length
    if (!confirm(n > 1 ? `删除这 ${n} 集缓存？文件会从磁盘移除，不可恢复。` : '删除这一集缓存？文件会从磁盘移除，不可恢复。')) return
  }
  ctrlBusy.value = { ...ctrlBusy.value, [key]: true }
  try {
    await controlCache(action, ids)
    await refresh(true)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    const next = { ...ctrlBusy.value }
    delete next[key]
    ctrlBusy.value = next
  }
}

/** 整剧删除（详情层右上角的「删除整剧」）。 */
async function deleteVod(v: CachedVod) {
  await control('delete', v.eps.map((e) => e.id), v.site + '|' + v.vodId)
  closeDetail()
}

/** 删除单集（单集操作条）。 */
async function deleteEp(e: CachedEpisode) {
  await control('delete', [e.id], e.id)
  if (selEp.value === e.id) selEp.value = ''
}

/** 暂停这部剧里所有正在跑的集。 */
async function pauseVod(v: CachedVod) {
  const ids = runningEps(v).map((e) => e.id)
  if (!ids.length) return
  await control('pause', ids, 'vod:' + v.site + '|' + v.vodId)
}

/**
 * 续传单集。
 *
 * ★ 走 resumeCacheTasks 而不是 control：失败任务要的是"从第一个缺失分片重跑"，
 *   那不是暂停/取消/删除三种控制语义之一。idle（批次排队占位）不能续传 ——
 *   会绕过整季 2 路队列直接开跑，所以按钮只在 failed 时出现。
 */
async function resumeEp(e: CachedEpisode) {
  resuming.value = e.id
  resumeMsg.value = ''
  try {
    const r = await resumeCacheTasks([e.id])
    if (r.failed.length) resumeMsg.value = r.failed[0]?.reason || '续传失败'
    else resumeMsg.value = `已恢复第 ${e.ep} 集`
    await refresh(true)
  } catch (err) {
    resumeMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    resuming.value = ''
  }
}

/** 一部剧"在动"的集数（running / paused），进度弹框用它决定显不显示。 */
function activeEps(v: CachedVod) {
  return v.eps.filter((e) => e.state === 'running' || e.state === 'paused')
}

/** 有下载活动的剧数量（决定「下载中 N 集」角标）。 */
const activeCount = computed(() =>
  shownVods.value.reduce((n, v) => n + activeEps(v).length, 0),
)

/**
 * 海报墙实际展示的剧：滤掉「一集没下完、没海报、也没在下载」的空组。
 *
 * 后端 `grouped()` 已经不再为这种任务建组（见 VideoCache.grouped 里的注释：
 * Jpys 失败任务曾让同一部剧出现两张卡）。但 PC/TV 的内置后端是随插件发布的
 * jar，插件没升级前仍会返回这种「0/1 集 · 无海报」的幽灵卡 ——
 * 前端再兜一层，用户不必等后端升级才能看到正常的海报墙。
 */
const shownVods = computed(() =>
  vods.value.filter(
    (v) =>
      v.doneEpisodes > 0 ||
      v.downloading > 0 ||
      !!v.posterLocal ||
      !!v.poster ||
      v.eps.some((e) => e.playable),
  ),
)

/**
 * 把这部剧"第一集可播的"存到 U 盘。
 *
 * <p>为什么不是"整部一次存"：SAF 写单个大文件很慢且没有整体进度回调，
 * 一次存 24 集会看起来像卡死。让用户按集点，每集都有明确完成反馈。
 */
function saveFirstPlayable(v: CachedVod) {
  const list = playableEps(v)
  if (!list.length) {
    saveMsg.value = '还没有下完的集可以存'
    return
  }
  const asTask = {
    id: list[0].id,
    state: 'done' as const,
    name: list[0].name || v.name,
    ep: list[0].ep,
  }
  void saveToDevice(asTask as CacheTask)
}

/**
 * 保存到本机 / U 盘。
 *
 * 三条路按运行环境分派，共同点是**缓存不再只留在后端**：
 * - TV：原生桥走 SAF 写 U 盘（content://），彻底脱离后端；
 * - PC：后端与客户端同机，直接让后端把合并好的文件写到指定目录，
 *   省一次"下载一遍再保存"的全量 IO；
 * - Web：交给浏览器下载（落系统下载目录，浏览器沙箱不允许指定任意路径）。
 *
 * 格式取决于后端有没有 ffmpeg：有则 mp4，无则单个 .ts。这里把实际格式回显出来，
 * 让"没装 ffmpeg"变成一个可见、可升级的状态，而不是静默降级。
 */
const saveMsg = ref('')
/** TV 已授权的 U 盘目录（原生侧读；空串=未授权） */
const tvDir = ref('')

interface TvSaveBridge {
  hasCacheSaver?: () => boolean
  cacheDirLabel?: () => string
  pickCacheDir?: () => boolean
  saveCache?: (url: string, name: string, ep: string) => string
  cacheState?: () => string
  savedCacheFiles?: () => string
  playSavedCache?: (uri: string, title: string) => boolean
}

/** TV 上已保存到 U 盘的文件（原生侧记录，供应用内直接播放） */
interface SavedFile {
  uri: string
  name: string
  bytes: number
  at: number
}
const savedFiles = ref<SavedFile[]>([])

function refreshSaved() {
  const b = tvBridge()
  if (!b || typeof b.savedCacheFiles !== 'function') return
  try {
    savedFiles.value = JSON.parse(b.savedCacheFiles() || '[]') as SavedFile[]
  } catch {
    savedFiles.value = []
  }
}

function playSaved(f: SavedFile) {
  const b = tvBridge()
  if (b && typeof b.playSavedCache === 'function') b.playSavedCache(f.uri, f.name)
}

function tvBridge(): TvSaveBridge | null {
  try {
    const b = (window as unknown as { meowTv?: TvSaveBridge }).meowTv
    return b && typeof b.hasCacheSaver === 'function' && b.hasCacheSaver() ? b : null
  } catch {
    return null
  }
}

const onTv = computed(() => !!tvBridge())

function refreshTvDir() {
  const b = tvBridge()
  tvDir.value = b && typeof b.cacheDirLabel === 'function' ? b.cacheDirLabel() : ''
}

function pickTvDir() {
  const b = tvBridge()
  if (!b || typeof b.pickCacheDir !== 'function') return
  const ok = b.pickCacheDir()
  if (!ok) saveMsg.value = '这台设备打不开系统文件选择器，无法授权 U 盘'
  // 选择器是异步的：稍后再读目录名（用户可能还在选）
  window.setTimeout(refreshTvDir, 1200)
  window.setTimeout(refreshTvDir, 4000)
}

/*
 * rememberDir / saveDir / ensureLocalLibrary / exportCacheToLocal 均已随
 * 「保存到本机」一起删除（2026-10-30）：PC 端后端与本机同盘，那套"导出到
 * 另一个目录再注册成片库"的流程用户实测反馈没有价值。TV 的 U 盘路径保留。
 */

/** TV 下载是原生的、异步的：轮询 cacheState 直到落定。 */function pollTvState(): Promise<void> {
  const b = tvBridge()
  if (!b || typeof b.cacheState !== 'function') return Promise.resolve()
  return new Promise((resolve) => {
    const tick = () => {
      let st: { state?: string; percent?: number; message?: string } = {}
      try {
        st = JSON.parse(b.cacheState?.() || '{}') as typeof st
      } catch {
        resolve()
        return
      }
      if (st.state === 'running') {
        saveMsg.value = `正在保存到 U 盘 ${st.percent || 0}%…`
        window.setTimeout(tick, 800)
        return
      }
      saveMsg.value = st.message || ''
      resolve()
    }
    tick()
  })
}

/**
 * 存到 U 盘（**仅 TV 壳**）。
 *
 * <p>为什么只留 TV：这个按钮的原意是"把缓存从后端搬到设备"。
 * 但 PC 端后端本来就在本机（"保存到本机"只是换个目录，没必要），
 * Web 端浏览器下载几百 MB 的分片合并在移动端极不稳定、
 * 且下载完仍要靠播放器打开另一个文件 —— 用户实测反馈"没什么用处"。
 * TV 的 U 盘路径不同：那是**脱离后端**的唯一手段（带着移动硬盘出门），
 * 所以保留。
 */
async function saveToDevice(t: CacheTask) {
  saveMsg.value = ''
  const bridge = tvBridge()
  if (!bridge || typeof bridge.saveCache !== 'function') return
  if (!tvDir.value) {
    saveMsg.value = '还没有授权保存目录，先点「设置U盘目录」'
    return
  }
  try {
    saveMsg.value = String(bridge.saveCache(cacheExportUrl(t.id), t.name || '', t.ep || ''))
    await pollTvState()
    refreshSaved()
  } catch (e) {
    saveMsg.value = 'TV 保存失败：' + (e instanceof Error ? e.message : String(e))
  }
}

/**
 * 继续下载。
 *
 * 续传粒度是**分片**：后端在下载每个分片前检查文件存在且非空就跳过，
 * 所以这里不需要告诉它"从第几片开始"。
 *
 * ★ 只提交 state=failed 的：`idle` 是批次里"还没轮到"的排队占位，
 *   对它调 resume 会走 `VideoCache.start` 新建线程直接开跑，
 *   绕过整季固定 2 路队列（20 集会瞬间变成 20 条连接打同一源站）。
 *   running 的提交上去也是原样返回，没必要。
 */
async function resumeAll() {
  const ids = pendingList.value.filter((t) => t.state === 'failed').map((t) => t.id)
  if (!ids.length) return
  resuming.value = '*'
  resumeMsg.value = ''
  try {
    const r = await resumeCacheTasks(ids)
    resumeMsg.value = `已恢复 ${r.resumed.length} 个任务` +
      (r.failed.length ? `，${r.failed.length} 个失败` : '')
    await refresh(true)
  } catch (e) {
    resumeMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    resuming.value = ''
  }
}

async function resumeOne(t: UnfinishedTask) {
  resuming.value = t.id
  resumeMsg.value = ''
  try {
    const r = await resumeCacheTasks([t.id])
    if (r.failed.length) {
      resumeMsg.value = r.failed[0]?.reason || '续传失败'
    } else {
      resumeMsg.value = `已恢复 ${t.ep || t.id}`
    }
    await refresh(true)
  } catch (e) {
    resumeMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    resuming.value = ''
  }
}

/**
 * 只重试某个批次里失败的集。
 *
 * 为什么按批次重试而不是整批重来：批次里的 done 集再点一次会被后端直接返回，
 * 但更重要的是 failed 的那几集是"地址还在、只是上次没拉下来"，
 * 重试它们才是用户想要的；把整季重新入队等于白打一遍已经下好的集。
 */
async function resumeBatchFailed(b: BatchStatus) {
  const ids = b.items.filter((it) => it.state === 'failed').map((it) => it.id)
  if (!ids.length) return
  resuming.value = b.batch
  resumeMsg.value = ''
  try {
    const r = await resumeCacheTasks(ids)
    resumeMsg.value = `批次 ${b.batch}：已重试 ${r.resumed.length} 集` +
      (r.failed.length ? `，${r.failed.length} 集失败` : '')
    await refresh(true)
  } catch (e) {
    resumeMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    resuming.value = ''
  }
}

/**
 * 详情层打开时接管 TV 返回键。
 *
 * <p>壳的 `onBackPressed` 先问 `window.__meowTvConsumeBack`（见 App.vue）；
 * 详情层是**页面内的状态切换、不改路由**，不接管的话返回键会直接退出页面
 * 甚至退出应用（TV 壳没有浏览器 history 可退）。
 *
 * <p>做法与 UpdateDialog 一致：打开时抢占、关闭时只还原自己挂的那个
 * （比对函数引用，别把别人刚挂的清掉）。刷新会换掉 openedVod 对象，
 * 所以要先判断"是不是已经是我们挂的"，否则 prevBackHandler 会存成自己、
 * 关掉后变成一个指向已卸载组件的野指针。
 */
let prevBackHandler: (() => boolean) | null = null
function detailBack(): boolean {
  closeDetail()
  return true
}

watch(openedVod, (v) => {
  const w = window as unknown as { __meowTvConsumeBack?: (() => boolean) | null }
  if (v) {
    if (w.__meowTvConsumeBack === detailBack) return
    prevBackHandler = w.__meowTvConsumeBack || null
    w.__meowTvConsumeBack = detailBack
    return
  }
  if (w.__meowTvConsumeBack === detailBack) {
    w.__meowTvConsumeBack = prevBackHandler
    prevBackHandler = null
  }
})

onMounted(() => {
  refreshTvDir()
  refreshSaved()
  void refresh()
})

onBeforeUnmount(() => {
  clearTimeout(pollTimer)
  pollTimer = undefined
  // 详情层开着时被切走（换页签/换路由）：把返回键还回去
  const w = window as unknown as { __meowTvConsumeBack?: (() => boolean) | null }
  if (w.__meowTvConsumeBack === detailBack) w.__meowTvConsumeBack = prevBackHandler
})
</script>

<template>
  <div class="w-full">
    <!-- ══════════ 缓存详情层：对齐本地片库的「海报 + 信息 + 选集」 ══════════
         为什么是页面内换层而不是弹框：TV 上弹框要跨两层挪焦点、退层还得
         先关弹框再关详情；本地片库详情已经是这个形状，用户认知一致。 -->
    <template v-if="openedVod">
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-md bg-card px-3 py-1.5 text-xs text-ink-2 transition hover:bg-card-hover"
          @click="closeDetail"
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回
        </button>
        <span class="min-w-0 truncate text-[11px] text-ink-3">
          我的缓存 / {{ openedVod.name || openedVod.vodId }}
        </span>
        <button
          class="ml-auto rounded-md bg-card px-3 py-1.5 text-xs transition hover:bg-card-hover"
          @click="refresh()"
        >
          刷新
        </button>
      </div>

      <div class="mt-2 flex flex-col gap-6 sm:flex-row">
        <div class="w-full shrink-0 sm:w-48">
          <div class="aspect-[2/3] overflow-hidden rounded-xl bg-elevated shadow-2xl">
            <!-- 海报优先用后端本地那份：离线时远端图床根本连不上 -->
            <img
              v-if="openedVod.posterLocal || openedVod.poster"
              :src="openedVod.posterLocal || openedVod.poster"
              :alt="openedVod.name"
              class="h-full w-full object-cover"
              @error="($event.target as HTMLImageElement).src = openedVod?.poster || ''"
            />
            <div v-else class="grid h-full place-items-center text-xs text-ink-3">无海报</div>
          </div>
        </div>
        <div class="min-w-0 flex-1">
          <h2 class="text-2xl font-semibold tracking-tight">
            {{ openedVod.name || openedVod.vodId }}
          </h2>
          <div class="mt-2 text-sm text-ink-3">{{ detailMeta }}</div>
          <p class="mt-3 text-[11px] leading-relaxed text-ink-3">
            来自源 <code class="rounded bg-field px-1">{{ openedVod.site }}</code> 的缓存，
            已下 {{ openedVod.doneEpisodes }}/{{ openedVod.episodes }} 集，
            共 {{ fmtSize(openedVod.totalBytes) }}。断网也能播；没下完的集在下面继续下载。
          </p>

          <div class="mt-5 flex flex-wrap items-center gap-3">
            <button
              class="flex items-center gap-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-dim disabled:opacity-40"
              :disabled="!playableEps(openedVod).length"
              :title="playableEps(openedVod).length ? '' : '还没有下完的集'"
              @click="playFirst(openedVod)"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              继续观看
            </button>
            <button
              v-if="runningEps(openedVod).length"
              class="rounded-lg bg-card px-4 py-2.5 text-sm text-ink-2 transition hover:bg-card-hover disabled:opacity-40"
              :disabled="!!ctrlBusy['vod:' + openedVod.site + '|' + openedVod.vodId]"
              @click="pauseVod(openedVod)"
            >
              暂停下载（{{ runningEps(openedVod).length }}）
            </button>
            <!-- 存到 U 盘只在 TV 出现：那是脱离后端的唯一手段 -->
            <button
              v-if="onTv"
              class="rounded-lg bg-card px-4 py-2.5 text-sm text-ink-2 transition hover:bg-accent/15 hover:text-accent"
              @click="saveFirstPlayable(openedVod)"
            >
              存到U盘
            </button>
            <button
              class="rounded-lg px-4 py-2.5 text-sm text-ink-3 transition hover:bg-hot/15 hover:text-hot disabled:opacity-40"
              :disabled="!!ctrlBusy[openedVod.site + '|' + openedVod.vodId]"
              @click="deleteVod(openedVod)"
            >
              删除整剧
            </button>
          </div>
          <p v-if="saveMsg" class="mt-2 text-[11px] text-ink-3">{{ saveMsg }}</p>
          <p v-if="resumeMsg" class="mt-2 text-[11px] text-ink-3">{{ resumeMsg }}</p>

          <!-- 正在下载的集：进度内联在信息区，不再弹「下载进度」框 -->
          <div v-if="activeEps(openedVod).length" class="mt-4 space-y-1.5">
            <div v-for="e in activeEps(openedVod)" :key="e.id">
              <div class="flex items-center gap-2 text-[11px]">
                <span class="w-12 shrink-0 tabular-nums text-ink-2">第{{ e.ep }}集</span>
                <span class="shrink-0" :class="e.state === 'paused' ? 'text-warn' : 'text-accent'">
                  {{ e.state === 'paused' ? '已暂停' : (e.percent || 0) + '%' }}
                </span>
                <span class="ml-auto shrink-0 text-ink-3">{{ fmtSize(e.bytes) }}</span>
              </div>
              <div class="mt-1 h-1 overflow-hidden rounded-full bg-card-hover">
                <div
                  class="h-full bg-accent transition-[width]"
                  :style="{ width: (e.percent || 0) + '%' }"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-8 flex flex-wrap items-center gap-3">
        <h2 class="text-sm font-medium text-ink-2">选集</h2>
        <span class="text-[11px] text-ink-3">
          共 {{ openedVod.eps.length }} 集 · 已下 {{ openedVod.doneEpisodes }} 集
        </span>
      </div>
      <div class="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10">
        <button
          v-for="e in openedVod.eps"
          :key="e.id"
          class="relative rounded-md py-2 text-center text-[13px] transition"
          :class="
            e.playable
              ? 'bg-card text-ink-2 hover:bg-accent/20 hover:text-accent'
              : 'bg-field text-ink-3 hover:bg-card-hover'
          "
          :title="epTitle(e)"
          @click="onEpClick(openedVod, e)"
          @focus="selEp = e.id"
        >
          {{ e.ep || '?' }}
          <span
            v-if="e.state !== 'done'"
            class="mt-0.5 block truncate text-[10px]"
            :class="epStateClass(e)"
          >
            {{ epStateText(e) }}
          </span>
          <span
            v-if="e.state === 'running'"
            class="absolute inset-x-1 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-accent/25"
          >
            <span class="block h-full bg-accent" :style="{ width: (e.percent || 0) + '%' }" />
          </span>
        </button>
      </div>

      <!--
        单集操作条：作用于刚点/刚聚焦的那一集。
        为什么把按钮集中在这里而不是塞进每个格子：TV 上格子会变成一堆小目标，
        方向键每格都要多按两下；集中一条也更容易看清"现在操作的是哪一集"。
      -->
      <div
        v-if="selEpObj"
        class="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-3 py-2"
      >
        <span class="text-xs text-ink-2">第 {{ selEpObj.ep || '?' }} 集</span>
        <span class="text-[11px]" :class="epStateClass(selEpObj)">{{ epStateText(selEpObj) }}</span>
        <span class="min-w-0 flex-1" />
        <button
          v-if="selEpObj.state === 'failed'"
          class="rounded-md bg-card-hover px-2.5 py-1 text-[11px] transition hover:bg-accent/15 hover:text-accent disabled:opacity-40"
          :disabled="!!resuming"
          @click="resumeEp(selEpObj)"
        >
          {{ resuming === selEpObj.id ? '提交中…' : '继续下载' }}
        </button>
        <button
          v-if="selEpObj.state === 'running' || selEpObj.state === 'paused'"
          class="rounded-md bg-card-hover px-2.5 py-1 text-[11px] transition hover:bg-card-hover hover:text-ink disabled:opacity-40"
          :disabled="!!ctrlBusy[selEpObj.id]"
          @click="control('pause', [selEpObj.id], selEpObj.id)"
        >
          暂停
        </button>
        <button
          v-if="selEpObj.state === 'running' || selEpObj.state === 'paused'"
          class="rounded-md px-2.5 py-1 text-[11px] text-ink-3 transition hover:bg-card-hover hover:text-ink disabled:opacity-40"
          :disabled="!!ctrlBusy[selEpObj.id]"
          @click="control('cancel', [selEpObj.id], selEpObj.id)"
        >
          取消
        </button>
        <button
          class="rounded-md px-2.5 py-1 text-[11px] text-hot transition hover:bg-hot/15 disabled:opacity-40"
          :disabled="!!ctrlBusy[selEpObj.id]"
          @click="deleteEp(selEpObj)"
        >
          删除本集
        </button>
      </div>
      <p v-if="!playableEps(openedVod).length" class="mt-3 text-[11px] text-ink-3">
        还没有下完的集。等下载完成，或在上面的选集里点某一集查看它的进度。
      </p>
    </template>

    <!-- ══════════ 海报墙层 ══════════ -->
    <template v-else>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <component :is="compact ? 'h2' : 'h1'" class="text-lg font-medium">{{ compact ? '我的缓存' : '离线缓存' }}</component>
      <span v-if="totalBytes" class="text-xs text-ink-3">
        共 {{ fmtSize(totalBytes) }}<template v-if="quotaBytes"> / {{ fmtSize(quotaBytes) }}</template>
      </span>
      <!-- 有集在跑时给个总数：否则用户要一张张卡点进去才知道有没有在下 -->
      <span
        v-if="activeCount"
        class="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-accent"
      >
        下载中 {{ activeCount }} 集
      </span>
      <span
        v-if="quotaBytes && totalBytes > quotaBytes * 0.9"
        class="rounded-full bg-hot/15 px-2 py-0.5 text-[11px] text-hot"
        :title="evictMode === 'lru' ? '超出后会删除最久没看的缓存' : '只提示，不自动删除'"
      >
        接近上限
      </span>
      <button
        class="ml-auto rounded-md bg-card px-3 py-1.5 text-xs transition hover:bg-card-hover"
        @click="refresh()"
      >
        刷新
      </button>
    </div>

    <p class="mb-4 text-[11px] leading-relaxed text-ink-3">
      缓存在后端的数据目录里。PC 端后端就在本机，断网仍可播放；Web 部署时缓存落在服务器上，
      手机断网后访问不到——要真离线请用 PC 端或把后端跑在本机。
      <template v-if="cacheDir"><br />实际目录：<code class="text-ink-2">{{ cacheDir }}</code></template>
    </p>

    <p v-if="loading" class="py-10 text-center text-sm text-ink-3">正在读取…</p>

    <div v-else-if="error" class="rounded-xl border border-line bg-card p-6 text-center">
      <p class="text-sm text-ink-2">{{ error }}</p>
      <button class="mt-3 rounded-md bg-card-hover px-4 py-2 text-xs" @click="refresh()">重试</button>
    </div>

    <template v-else>
      <!-- TV：U 盘目录（SAF 授权，一次授权长期有效） -->
      <div v-if="onTv" class="mb-3 flex flex-wrap items-center gap-2">
        <span class="text-[11px] text-ink-3">
          U盘目录：{{ tvDir || '未授权' }}
        </span>
        <button
          class="rounded-md bg-card px-2.5 py-1 text-[11px] text-ink-2 transition hover:bg-card-hover"
          @click="pickTvDir"
        >
          设置U盘目录
        </button>
      </div>
      <!--
        「本机保存目录」输入区已删除（2026-10-30）：
        PC 上后端本来就在本机，这个目录只是把文件从 cache 目录搬到另一个目录，
        用户实测反馈"没什么用处"。真正需要"离开后端"的是 TV，走 U 盘那条路。
      -->
      <p v-if="saveMsg" class="mb-3 rounded-md bg-field px-2.5 py-1.5 text-[11px] text-ink-2">
        {{ saveMsg }}
      </p>

      <!-- TV：已保存到 U 盘的文件。放这里是因为片库页读的是后端列表，
           看不到 U 盘上的文件；这份清单来自原生侧记录，点一下直接交给 ExoPlayer。 -->
      <div v-if="onTv && savedFiles.length" class="mb-5">
        <div class="mb-2 text-xs text-ink-3">已保存到U盘（{{ savedFiles.length }}）</div>
        <div class="space-y-1">
          <div
            v-for="f in savedFiles"
            :key="f.uri"
            class="flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2"
          >
            <span class="min-w-0 flex-1 truncate text-[12px]">{{ f.name }}</span>
            <span class="shrink-0 text-[11px] text-ink-3">{{ fmtSize(f.bytes || 0) }}</span>
            <button
              class="shrink-0 rounded-md bg-card-hover px-2.5 py-1 text-[11px] transition hover:bg-accent/20 hover:text-accent"
              @click="playSaved(f)"
            >
              播放
            </button>
          </div>
        </div>
      </div>

      <!-- 续传/重试的结果放在批次与未完成两段之上：两段都会写这条，
           只挂在其中一段里时另一段操作完看不到反馈 -->
      <p v-if="resumeMsg" class="mb-3 rounded-md bg-field px-2.5 py-1.5 text-[11px] text-ink-2">
        {{ resumeMsg }}
      </p>

      <!-- 整季批次：每集一行，3 秒一次轮询（跑完自动停） -->
      <div v-if="batches.length" class="mb-5">
        <div class="mb-2 text-xs text-ink-3">整季下载（{{ batches.length }}）</div>
        <div class="space-y-2">
          <div
            v-for="b in batches"
            :key="b.batch"
            class="rounded-lg border border-line bg-card px-4 py-3"
          >
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="min-w-0 flex-1 truncate">
                {{ b.vodId || b.batch }}
                <span v-if="b.site" class="ml-1 text-[11px] text-ink-3">· {{ b.site }}</span>
              </span>
              <span class="rounded-full px-2 py-0.5 text-[11px]" :class="batchStateClass(b)">
                {{ batchStateText(b) }}
              </span>
              <span v-if="b.bytes" class="text-[11px] text-ink-3">{{ fmtSize(b.bytes) }}</span>
              <!-- 失败集单独给一个重试入口：整批重来会把已下好的集也重下一遍 -->
              <button
                v-if="b.failed > 0"
                class="shrink-0 rounded-md bg-card-hover px-2 py-0.5 text-[11px] transition hover:bg-accent/20 hover:text-accent disabled:opacity-40"
                :disabled="!!resuming"
                @click="resumeBatchFailed(b)"
              >
                {{ resuming === b.batch ? '提交中…' : `重试失败 ${b.failed} 集` }}
              </button>
            </div>
            <div class="mt-2 h-1 overflow-hidden rounded-full bg-card-hover">
              <div class="h-full bg-accent transition-[width]" :style="{ width: (b.percent || 0) + '%' }" />
            </div>
            <ul class="mt-2 space-y-1">
              <li
                v-for="it in b.items"
                :key="it.id"
                class="flex items-center gap-2 text-[11px]"
              >
                <span class="w-24 shrink-0 truncate" :title="it.ep">{{ it.ep || it.id }}</span>
                <span class="min-w-0 flex-1 truncate" :class="itemStateClass(it)" :title="it.error">
                  {{ itemStateText(it) }}
                </span>
                <span class="shrink-0 text-ink-3">
                  <template v-if="it.total">{{ it.done }}/{{ it.total }} 片</template>
                </span>
                <span v-if="it.bytes" class="shrink-0 text-ink-3">{{ fmtSize(it.bytes) }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- 未完成任务：重启前被打断的都在这，续传按分片跳过已下部分 -->
      <div v-if="pendingList.length" class="mb-5 rounded-lg border border-line bg-card px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm">未下完（{{ pendingList.length }}）</span>
          <span class="text-[11px] text-ink-3">从第一个缺失分片继续，已下的不会重下</span>
          <button
            class="ml-auto rounded-md bg-accent px-3 py-1 text-[11px] font-medium text-on-accent transition hover:bg-accent-dim disabled:opacity-40"
            :disabled="!!resuming || !resumableCount"
            :title="resumableCount ? '' : '没有失败的任务可续传；排队中的会自动轮到'"
            @click="resumeAll"
          >
            {{ resuming === '*' ? '提交中…' : `全部继续下载${resumableCount ? `（${resumableCount}）` : ''}` }}
          </button>
        </div>
        <ul class="mt-2 space-y-1">
          <li
            v-for="t in pendingList"
            :key="t.id"
            class="flex flex-wrap items-center gap-2 border-t border-line py-1.5 text-[12px] first:border-0"
          >
            <span class="min-w-0 flex-1 truncate">
              {{ t.name || t.vodId || t.id }}<template v-if="t.ep"> · {{ t.ep }}</template>
            </span>
            <span
              class="shrink-0 text-[11px]"
              :class="
                t.state === 'failed' ? 'text-warn' : t.state === 'idle' ? 'text-ink-3' : 'text-accent'
              "
            >
              {{
                t.state === 'failed'
                  ? t.error || '失败'
                  : t.state === 'idle'
                    ? '排队中'
                    : `下载中 ${t.percent || 0}%`
              }}
            </span>
            <span v-if="t.hasSegments" class="shrink-0 text-[11px] text-ink-3">
              已有 {{ t.done || 0 }} 片可复用
            </span>
            <!--
              idle 是批次里"还没轮到"的排队占位，不能对它调 resume：
              那会新建线程直接开跑、绕过整季 2 路队列。让它自己排到就行。
            -->
            <button
              v-if="t.state !== 'idle'"
              class="shrink-0 rounded-md bg-card-hover px-2.5 py-1 text-[11px] transition hover:bg-accent/20 hover:text-accent disabled:opacity-40"
              :disabled="!!resuming || t.state === 'running'"
              @click="resumeOne(t)"
            >
              {{ resuming === t.id ? '提交中…' : '继续下载' }}
            </button>
          </li>
        </ul>
      </div>

      <!--
        单集进度不在这里铺开：点开某部剧后，进度、暂停/取消/删除都在详情层
        （见上方 v-if="openedVod" 那一段）。主视图只留海报墙，
        避免下载中的集把整页顶下去。
      -->

      <div
        v-if="!shownVods.length"
        class="rounded-xl border border-line bg-card p-10 text-center"
      >
        <p class="text-sm text-ink-2">还没有缓存任何片子。</p>
        <p class="mt-2 text-xs text-ink-3">
          在播放页点底栏「更多」→「缓存本集」，或在详情页点「缓存整季」，下完后会出现在这里。
          缓存会把**视频分片、海报、剧名**一起存到后端数据目录，断网也能看。
        </p>
      </div>

      <!--
        ★ 一剧一张海报卡片，整卡可点进详情（2026-10-30 第二次改版）。

        用户要求：「卡片不要播放、删除按钮，点海报跳详情页做管理」。
        除了观感，TV 上每张卡少两个可聚焦元素就少按两次方向键；
        而"删除"这种不可逆操作紧贴海报，误按代价很大。
      -->
      <div v-else class="poster-grid" :style="colsStyle(cols)">
        <button
          v-for="v in shownVods"
          :key="v.site + '|' + v.vodId"
          class="group block w-full text-left"
          @click="openDetail(v)"
        >
          <div class="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-elevated">
            <!--
              海报优先用后端本地那份（/api/cache/poster）：离线时远端图床
              根本连不上，只用远端地址会让整页变成灰块 —— 那正是这个页面
              在火车/飞机上最不该出现的样子。onerror 才退回远端。
            -->
            <img
              v-if="v.posterLocal || v.poster"
              :src="v.posterLocal || v.poster"
              :alt="v.name"
              class="h-full w-full object-cover transition duration-300 group-hover:brightness-110"
              loading="lazy"
              @error="($event.target as HTMLImageElement).src = v.poster || ''"
            />
            <div v-else class="grid h-full w-full place-items-center bg-field text-ink-3">
              <svg class="h-8 w-8 opacity-40" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
              </svg>
            </div>
            <!-- 集数角标：一眼看出下到第几集 -->
            <span
              class="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white tabular-nums"
            >
              {{ v.doneEpisodes }}/{{ v.episodes }} 集
            </span>
            <span
              v-if="v.downloading"
              class="absolute left-1.5 top-1.5 rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-on-accent"
            >
              下载中 {{ v.downloading }}
            </span>
          </div>
          <div class="mt-2 px-0.5">
            <div class="poster-title truncate font-medium text-ink group-hover:text-accent" :title="v.name">
              {{ v.name || v.vodId }}
            </div>
            <div class="mt-0.5 truncate text-[11px] text-ink-3">
              <template v-if="v.year || v.area">{{ [v.year, v.area].filter(Boolean).join(' · ') }} · </template>
              {{ fmtSize(v.totalBytes) }}
            </div>
          </div>
        </button>
      </div>
    </template>

    </template>
  </div>
</template>
