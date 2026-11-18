<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fetchCategory, fetchDetail, fetchHome, proxyImage } from '@/api'
import { networkErrorText, nextRetryDelay } from '@/api/networkRetry'
import type { HomeClass, HomeResult, VodItem } from '@/api/types'
import PosterCard from '@/components/common/PosterCard.vue'
import PosterImage from '@/components/common/PosterImage.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { colsStyle, useCardCols } from '@/composables/useCardCols'
import { useAppStore } from '@/stores/app'
import { pushHistory, listHistory, type HistoryItem } from '@/stores/history'
import { getPrefs } from '@/stores/prefs'
import { useReturnRestore } from '@/composables/useReturnRestore'
import { cleanIntro } from '@/utils/introText'

// 返回上一页时恢复滚动位置与焦点（TV 上从详情返回不该跳回顶部）
useReturnRestore('home')

const store = useAppStore()

const home = ref<HomeResult | null>(null)
const classes = ref<HomeClass[]>([])
const activeTid = ref('')
const list = ref<VodItem[]>([])
const page = ref(1)
const pagecount = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')

/** 提前多少像素触底就预加载（越大越早） */
const PRELOAD_PX = 900

const site = computed(() => store.current)
const router = useRouter()

/**
 * 首页首屏（2026-11-18 第二轮）。
 *
 * ★ 原来放的是「当前列表第一条」——既和网格第一张重复，又跟用户无关：
 *   用户看不到自己在追的剧，只看到源站推的第一部。
 *   现在只放**续播**：真有看到一半的片才占这块，没有就整块不渲染，
 *   首页直接从分类胶囊 + 网格开始（首屏多出两行卡片）。
 */

/** 看到 30 秒以上、且离结尾还剩 1 分钟以上，才算「值得续播」 */
const RESUME_MIN_POS = 30
const RESUME_TAIL = 60
/**
 * 续播卡只认「前一天」内的记录（2026-11-18 用户口径）：
 * 24 小时内有观看才上首屏，久远的进度不再占位 —— 首页首屏是"现在在追什么"，
 * 不是历史列表。窗口按 `ep_at`（真正播过的时刻）算，只点过封面不算。
 */
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000

/** 按进度时间排序的候选；取最近一条做主卡 */
const resumeAll = ref<HistoryItem[]>([])

function refreshResume(): void {
  const since = Date.now() - RESUME_WINDOW_MS
  resumeAll.value = listHistory()
    .filter((h) => (h.ep_at || h.at || 0) >= since)
    .filter((h) => typeof h.pos === 'number' && h.pos > RESUME_MIN_POS)
    .filter((h) => !h.dur || h.dur - (h.pos || 0) > RESUME_TAIL)
    // ep_at 才是进度时间；只点过封面（at 变了、ep_at 没变）的老片不该顶上来
    .sort((a, b) => (b.ep_at || b.at) - (a.ep_at || a.at))
    .slice(0, 1)
}

const resume = computed(() => resumeAll.value[0] || null)

/**
 * 设置页「外观 → 首页续播卡」的总开关。
 *
 * 设置页只在同一个 SPA 里切换，savePrefs 会派发 `meow:prefs`；
 * 这里监听它而不是读一次了事，否则关掉开关回到首页要刷新才生效。
 */
const heroEnabled = ref(getPrefs().homeHero !== false)

function onPrefsChanged(e: Event): void {
  const d = (e as CustomEvent<{ homeHero?: boolean }>).detail
  heroEnabled.value = typeof d?.homeHero === 'boolean' ? d.homeHero : getPrefs().homeHero !== false
}

/**
 * 续播片的元数据（简介/年份/地区/主演…）。
 *
 * ★ 历史记录里只有片名和海报，没有简介；右侧那块要填「这部片讲什么」，
 *   只能补一次 detail。按 site|vod_id 缓存，切分类/回首页不会重复打。
 */
const resumeDetail = ref<VodItem | null>(null)
const detailCache = new Map<string, VodItem | null>()
let detailSeq = 0

watch(
  () => (resume.value ? `${resume.value.site}|${resume.value.vod_id}` : ''),
  async (key) => {
    if (!key) {
      resumeDetail.value = null
      return
    }
    if (detailCache.has(key)) {
      resumeDetail.value = detailCache.get(key) || null
      return
    }
    const it = resume.value
    if (!it) return
    const seq = ++detailSeq
    try {
      const r = await fetchDetail(it.site, it.vod_id)
      const hit = r.list?.[0] || null
      detailCache.set(key, hit)
      // 期间又换了续播片就不再覆盖
      if (seq === detailSeq) resumeDetail.value = hit
    } catch {
      if (seq === detailSeq) resumeDetail.value = null
    }
  },
  { immediate: true },
)

/**
 * 详情回来后把「只有 id」的占位历史补成真名/真封面。
 *
 * 只补元信息，进度字段由 mergeInto 原样保留；补完写回 localStorage，
 * 历史页和下次冷启动都不用再猜。detail 已按 site|vod_id 缓存，不会重复打。
 */
watch(resumeDetail, (d) => {
  const it = resume.value
  if (!d || !it) return
  const needName = placeholderEntry.value
  const needPic = !it.vod_pic
  if (!needName && !needPic) return
  const name = needName ? d.vod_name || '' : it.vod_name
  if (!name) return
  pushHistory({
    site: it.site,
    vod_id: it.vod_id,
    vod_name: name,
    vod_pic: it.vod_pic || d.vod_pic || '',
    vod_remarks: it.vod_remarks || d.vod_remarks,
  })
})

/** 简介：豆瓣/源站常带「\n」和多余空白，统一走详情页那个清洗函数 */
const resumeIntro = computed(() => cleanIntro(resumeDetail.value?.vod_content || ''))

/** 年份/地区/状态做成胶囊；导演/主演单独两行文字（表格式的 dl 在深色底上很硬） */
const resumeChips = computed(() => {
  const d = resumeDetail.value
  if (!d) return [] as string[]
  return [d.vod_year, d.vod_area, d.vod_remarks].filter(Boolean) as string[]
})

/**
 * 评分只有列表/详情里才带，而且**不是每个源都给**（AppDrama2 的 detail 就没有）。
 * 取值顺序：detail 自带 → 当前分类列表里同 id → 同站同名。
 * 都没有就返回空串，右上角不占位。
 */
const resumeScore = computed(() => {
  const fromDetail = resumeDetail.value?.vod_score
  if (fromDetail) return fromDetail
  const it = resume.value
  if (!it) return ''
  const sameSite = (x: VodItem) => x.vod_id === it.vod_id
  const sameName = (x: VodItem) => x.vod_name === it.vod_name
  const hit = list.value.find(sameSite) || (it.site === site.value ? list.value.find(sameName) : undefined)
  return hit?.vod_score || ''
})

const resumeStaff = computed(() => {
  const d = resumeDetail.value
  if (!d) return [] as Array<{ k: string; v: string }>
  const rows: Array<{ k: string; v: string }> = []
  if (d.vod_director) rows.push({ k: '导演', v: d.vod_director })
  if (d.vod_actor) rows.push({ k: '主演', v: d.vod_actor })
  return rows
})

/**
 * 续播卡的显示名与海报。
 *
 * ★ 2026-11-18 真问题：后端进度通道（/api/state/progress）只存 8 个字段，
 *   **没有片名和封面**；别的设备看过、本机没有的片子，历史里会被补成
 *   `vod_name = vod_id`、`vod_pic = ''`（见 history.ts 的 applyRemoteHistory）。
 *   结果首页续播卡显示一串数字 + 破图。
 *   这里用 detail 拉回来的元信息补齐：本地名是 id 或是空图时以 detail 为准。
 */
const placeholderEntry = computed(() => {
  const it = resume.value
  return !!it && (!it.vod_name || it.vod_name === it.vod_id)
})

const resumeTitle = computed(() => {
  const it = resume.value
  if (!it) return ''
  if (!placeholderEntry.value) return it.vod_name
  return resumeDetail.value?.vod_name || it.vod_name
})

/** 续播海报也抬到 l_：s_ 只有 17KB，做模糊背景会糊成色块 */
const resumePic = computed(() => {
  const it = resume.value
  const raw = (it?.vod_pic || '').trim() || resumeDetail.value?.vod_pic || ''
  return raw
    .replace('/s_ratio_poster/', '/l_ratio_poster/')
    .replace('/m_ratio_poster/', '/l_ratio_poster/')
})

/** 进度百分比；时长未知时返回 0，不画进度条 */
const resumePct = computed(() => {
  const it = resume.value
  if (!it?.dur || !it.pos) return 0
  return Math.min(100, Math.max(0, (it.pos / it.dur) * 100))
})

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const resumeLeft = computed(() => {
  const it = resume.value
  if (!it?.dur || !it.pos) return ''
  return `还剩 ${fmtClock(Math.max(0, it.dur - it.pos))}`
})

const resumeMeta = computed(() => {
  const it = resume.value
  if (!it) return ''
  return [it.ep, it.siteName].filter(Boolean).join(' · ')
})

/** 有集地址就直达播放页续播，否则回详情页重新挑线路（与历史页同一套判定） */
function playHistoryItem(it: HistoryItem): void {
  if (it.ep_url && it.flag) {
    void router.push({
      name: 'play',
      params: { site: it.site },
      query: {
        flag: it.flag,
        id: it.ep_url,
        name: it.vod_name,
        ep: it.ep || '',
        // 不带 list：整条线路的剧集 JSON 太大，播放页会用 vod 拉 detail 补回来
        vod: it.vod_id,
      },
    })
    return
  }
  openHistoryDetail(it)
}

function openHistoryDetail(it: HistoryItem): void {
  void router.push({
    name: 'detail',
    params: { site: it.site, id: it.vod_id },
    query: it.vod_name ? { name: it.vod_name } : undefined,
  })
}

function openResume(): void {
  const it = resume.value
  if (it) playHistoryItem(it)
}

function openResumeDetail(): void {
  const it = resume.value
  if (it) openHistoryDetail(it)
}

/**
 * 进度落盘有 5 秒节流且默认不派发事件，所以除了 `meow:history-changed`，
 * 还要在窗口重新获得焦点 / 页面回到可见时重读一次（播放页返回首页时命中）。
 */
function onResumeVisible(): void {
  if (document.visibilityState === 'visible') refreshResume()
}

onMounted(() => {
  refreshResume()
  window.addEventListener('focus', refreshResume)
  window.addEventListener('meow:history-changed', refreshResume)
  window.addEventListener('meow:prefs', onPrefsChanged)
  document.addEventListener('visibilitychange', onResumeVisible)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', refreshResume)
  window.removeEventListener('meow:history-changed', refreshResume)
  window.removeEventListener('meow:prefs', onPrefsChanged)
  document.removeEventListener('visibilitychange', onResumeVisible)
})

/**
 * Shift+滚轮 / 触控板横滑 → 横向滚动分类胶囊（B8）。
 * 普通纵向滚轮不劫持：页面还要能正常往下滚。
 */
function onChipsWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement | null
  if (!el || el.scrollWidth <= el.clientWidth) return
  if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
  e.preventDefault()
  el.scrollLeft += e.shiftKey ? e.deltaY : e.deltaX
}

/**
 * 列数按可用宽度算，设置页的 homeCols 只是上限（见 useCardCols）。
 * 手机竖屏 3 列、电视 8 列都由同一套规则得出，不再靠视口断点切档。
 *
 * ★ 2026-11-18 用户口径：电视横屏**初始就是 6 列**（有/无续播卡都一样），
 *   不要为了塞两行去加列 —— 列数变化会让片墙密度忽大忽小。
 *   无续播时"尽可能"多露第二行：只能靠压缩首屏 chrome，
 *   16:9 + 2:3 海报下两整行本来放不下（6 列时两行 ≈ 646px > 可用 488px）。
 */
const { cols, compact } = useCardCols()
/** 矮屏（手机横屏）只铺 2 行，否则首屏取太多数据用不上 */
const firstRows = computed(() => (compact.value ? 2 : 3))

const hasMore = computed(() => pagecount.value === 0 || page.value < pagecount.value)
/** 首屏是否已铺满 */
const enough = computed(() => list.value.length >= firstRows.value * cols.value)

function reset() {
  home.value = null
  classes.value = []
  activeTid.value = ''
  list.value = []
  page.value = 1
  pagecount.value = 0
  error.value = ''
}

/**
 * 首屏是不是还没跑完（只有它能给"冷启动后端未就绪"重试）。
 *
 * 踩过（2026-11-16，.77 装完包第一次打开）：页面比端内网关（127.0.0.1:9978）
 * 先就绪，`/home` 直接 reject —— 旧代码把英文 `Failed to fetch` 贴成一整屏错误、
 * 且不重试。正常重启不会遇到（后端早就绪），但"装完就打开"这个真实场景会。
 */
let firstLoad = true
/** 首屏请求序号：重试与换站点都换号，旧的那次不许再收尾（同 SearchView 的 runSeq） */
let homeSeq = 0
/** 退避用（仓库没有公共 sleep 工具） */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * @param retry 内部用：本页首屏已经自动重试过几次（见 catch 里的退避）
 */
async function loadHome(retry = 0) {
  if (!site.value) return
  const seq = ++homeSeq
  const siteAtStart = site.value
  loading.value = true
  error.value = ''
  try {
    const h = await fetchHome(siteAtStart)
    if (seq !== homeSeq) return
    home.value = h
    classes.value = h.class || []
    if (classes.value.length) {
      activeTid.value = classes.value[0].type_id
      await fillFirstScreen()
    } else if (h.list?.length) {
      list.value = h.list
    } else {
      error.value = '该站点返回空数据（源可能已失效）'
    }
  } catch (e: any) {
    if (seq !== homeSeq) return
    /*
     * 冷启动竞态：保持 loading（界面是骨架屏而不是错误页），退避后再来一次。
     * 给用户的观感是"首屏慢了一点"，而不是先甩一整页 Failed to fetch。
     */
    const delay = nextRetryDelay({
      firstRun: firstLoad,
      retry,
      error: e,
      sameKeyword: site.value === siteAtStart,
    })
    if (delay !== null) {
      await sleep(delay)
      // 等待期间换了站点/又刷新了一次：这次重试作废，交给新的那次
      if (seq !== homeSeq || site.value !== siteAtStart) return
      return loadHome(retry + 1)
    }
    error.value = networkErrorText(e, '刷新')
  } finally {
    if (seq === homeSeq) {
      loading.value = false
      // 重试时外层这一次会被 seq 变化跳过，由最后一次收尾
      firstLoad = false
    }
  }
}

/**
 * 拉第一页；若不足 18 个（有些源每页只给 10 条），继续拉下一页直到铺满或没有更多。
 */
async function fillFirstScreen() {
  loading.value = true
  list.value = []
  page.value = 0
  error.value = ''
  try {
    while (!enough.value && hasMore.value) {
      const next = page.value + 1
      const r = await fetchCategory(site.value, activeTid.value, next)
      const got = r.list || []
      list.value = [...list.value, ...got]
      page.value = Number(r.page || next)
      pagecount.value = Number(r.pagecount || 0)
      if (!got.length) break
      // 源不返回 pagecount 时，避免无限循环
      if (pagecount.value === 0 && got.length === 0) break
      if (page.value >= 20) break
    }
    if (!list.value.length) error.value = '该分类暂无数据'
  } catch (e: any) {
    error.value = networkErrorText(e, '刷新')
  } finally {
    loading.value = false
  }
}

async function loadCategory(p: number) {
  if (!site.value || !activeTid.value) return
  if (p === 1) return fillFirstScreen()
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const r = await fetchCategory(site.value, activeTid.value, p)
    const got = r.list || []
    // 去重：部分源翻页会重复返回上一页内容
    const seen = new Set(list.value.map((x) => x.vod_id))
    list.value = [...list.value, ...got.filter((x) => !seen.has(x.vod_id))]
    page.value = Number(r.page || p)
    pagecount.value = Number(r.pagecount || 0)
    error.value = ''
  } catch (e: any) {
    error.value = networkErrorText(e, '重试')
  } finally {
    loadingMore.value = false
    // 内容不足一屏时继续补，否则用户看不到滚动条也就触发不了下次加载
    await nextTick()
    if (needsMoreFill()) loadMore()
  }
}

function needsMoreFill() {
  return document.documentElement.scrollHeight <= window.innerHeight + PRELOAD_PX
}

function switchClass(tid: string) {
  if (tid === activeTid.value) return
  activeTid.value = tid
  list.value = []
  error.value = ''
  window.scrollTo({ top: 0 })
  fillFirstScreen()
}

// ---------------------------------------------------------------- 分类胶囊跟随

/** 分类胶囊横条：TV 聚焦到右侧胶囊时把它滚进可视区并居中 */
const chipsEl = ref<HTMLElement | null>(null)

/**
 * 胶囊条的横向渐隐（2026-11-18）。
 *
 * 只虚"真的有内容"的那一侧：滚到最左不虚左边、滚到最右不虚右边。
 * 用 data-fade + CSS mask 而不是叠渐变 div —— 胶囊本身是手机端的
 * sticky 玻璃横带，外层套 wrapper 会把 sticky 的边界缩到 wrapper 高度。
 * 手机端在 CSS 里直接关掉（贴顶横带虚边会切断蒙层）。
 */
const chipsFade = ref({ left: false, right: false })

const chipsFadeAttr = computed(() => {
  const { left, right } = chipsFade.value
  if (left && right) return 'both'
  if (left) return 'left'
  if (right) return 'right'
  return undefined
})

function updateChipsFade(): void {
  const el = chipsEl.value
  if (!el) return
  const max = el.scrollWidth - el.clientWidth
  const next = { left: el.scrollLeft > 2, right: max > 2 && el.scrollLeft < max - 2 }
  if (next.left !== chipsFade.value.left || next.right !== chipsFade.value.right) {
    chipsFade.value = next
  }
}

// 分类换站后数量会变；等 DOM 更新完再量一次
watch(classes, () => void nextTick(updateChipsFade))
onMounted(() => {
  window.addEventListener('resize', updateChipsFade)
  void nextTick(updateChipsFade)
})
onBeforeUnmount(() => window.removeEventListener('resize', updateChipsFade))

/**
 * 聚焦的胶囊居中（2026-11-06 用户报：右键后靠右的胶囊聚焦会出界）。
 *
 * <p>★ 两条触发路径，缺一不可：
 * <ol>
 *   <li>鼠标/键盘 focusin —— 浏览器原生焦点；</li>
 *   <li>tv-nav 的 `meow:tv-focus` —— 遥控器移焦是**只加 class 不调 focus()**
 *       （焦点框是 box-shadow，不抢 DOM 焦点），所以 focusin 根本不会触发。
 *       2026-11-10 用户报「欧美剧胶囊右键聚焦出界、看不见所选」就是这条：
 *       胶囊 index 一直往右走，元素坐标跑到视口外，行却不滚。</li>
 * </ol>
 *
 * <p>和设置页分区胶囊（SettingsView 的 chipsEl watch）同一个手法：
 * scrollLeft 把目标项居中，**不用 scrollIntoView** —— 部分内核会连带
 * 滚竖向容器把页面拽回去（docs/27 §5.9）。
 */
function centerChip(el: HTMLElement | null, behavior: ScrollBehavior = 'smooth') {
  const box = chipsEl.value
  if (!box || !box.clientWidth || !el) return
  const target = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2
  box.scrollTo({ left: Math.max(0, target), behavior })
}

function onChipFocus(e: FocusEvent) {
  centerChip(e.target as HTMLElement | null)
}

/** tv-nav 遥控器移焦：从全局高亮元素里挑出当前分类胶囊再居中 */
function onTvFocus() {
  const el = document.querySelector('.cat-chips .meow-tv-focus')
  // 遥控器用 auto：tv-nav 刚做过一次"最小必要横向滚动"，再用 smooth 会
  // 先跳一下再缓动；同一帧内直接居中，画面不会闪。
  if (el instanceof HTMLElement) centerChip(el, 'auto')
}

function loadMore() {
  if (loadingMore.value || loading.value || !hasMore.value) return
  // 重试前清掉上次的失败文案，否则点了没变化像是按钮坏了
  error.value = ''
  loadCategory(page.value + 1)
}

function onScroll() {
  const remain =
    document.documentElement.scrollHeight - window.scrollY - window.innerHeight
  if (remain < PRELOAD_PX) loadMore()
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  // 遥控器移焦不走 focusin（tv-nav 只加 class），必须单独听它的事件
  window.addEventListener('meow:tv-focus', onTvFocus)
  // 顶栏「…」→「刷新首页」（见 AppHeader）：手机上滚到半截够不到下拉
  window.addEventListener('meow:refresh-home', onRefreshHome)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('meow:tv-focus', onTvFocus)
  window.removeEventListener('meow:refresh-home', onRefreshHome)
})

function onRefreshHome() {
  void loadHome()
}

/** 打开顶栏的站点下拉（错误态「换个站点」用，下拉状态归 AppHeader 管） */
function openSitePicker() {
  window.dispatchEvent(new Event('meow:open-sites'))
}

// ---------------------------------------------------------------- 下拉刷新（手机）
/**
 * 手机下拉刷新（2026-11-12）。
 *
 * <p>为什么要有：首页正常态**没有任何刷新入口** —— 只有错误态那个「刷新」
 * 按钮；底部「首页」重复点又是空导航。内容停在旧状态时只能杀进程。
 *
 * <p>★ 只在页面已经在顶部（scrollY <= 0）时接管：一开始下拉就 preventDefault，
 * 否则 WebView 的过滚动/下拉链会先吃掉手势。
 * ★ 阈值 56px + 0.5 阻尼：太浅容易误触，太深单手拉不到。
 */
const PULL_TRIGGER = 56
const pull = ref(0)
let pullStart = 0
let pullActive = false

function onPullStart(e: TouchEvent) {
  if (!window.matchMedia('(max-width: 639px)').matches) return
  if (window.scrollY > 0 || loading.value) return
  pullStart = e.touches[0]?.clientY ?? 0
  pullActive = pullStart > 0
}

function onPullMove(e: TouchEvent) {
  if (!pullActive) return
  const dy = (e.touches[0]?.clientY ?? 0) - pullStart
  if (dy <= 0) {
    pull.value = 0
    return
  }
  pull.value = Math.min(84, dy * 0.5)
  if (pull.value > 6) e.preventDefault()
}

function onPullEnd() {
  if (!pullActive) return
  pullActive = false
  const go = pull.value >= PULL_TRIGGER
  pull.value = 0
  if (go) void loadHome()
}

/** 记住点过的影片，供历史页使用 */
function remember(item: VodItem) {
  pushHistory({
    site: site.value,
    siteName: store.currentSite?.name || site.value,
    vod_id: item.vod_id,
    vod_name: item.vod_name,
    vod_pic: item.vod_pic || '',
    vod_remarks: item.vod_remarks || '',
    at: Date.now(),
  })
}

watch(
  () => store.current,
  () => {
    reset()
    loadHome()
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="mx-auto max-w-[1600px] px-6 py-6 max-sm:px-3 max-sm:py-4"
    @touchstart="onPullStart"
    @touchmove="onPullMove"
    @touchend="onPullEnd"
    @touchcancel="onPullEnd"
  >
    <!-- 下拉刷新指示：手指往下拉时撑开的高度就是进度，过半即"松开刷新" -->
    <div
      v-if="pull > 0"
      class="flex items-start justify-center overflow-hidden text-[11px] text-ink-3"
      :style="{ height: pull + 'px' }"
    >
      {{ pull >= PULL_TRIGGER ? '松开刷新首页' : '下拉刷新' }}
    </div>
    <!-- 第一行：源站返回的分类 -->
    <!--
      手机：分类胶囊吸顶（2026-11-05 用户要求，和设置页的分区胶囊同一套）。

      ★ 只给 <640：TV 上 tv-nav 把**任何 position:sticky 祖先**当"钉住层"，
        左右键会进不去内容区（见 SearchView 的 tv-unstick 注释）——
        电视必须保持 static。PC 也不吸（桌面高度富裕，吸顶反而多一条横带）。
      ★ 吸顶时底色用 --color-strip-veil + 背景模糊（并补 180% 饱和），紧贴顶栏
        下沿成一条连续面板；它和底部标签栏是同一套玻璃，只是蒙层比标签栏再实
        一点点（用户口径「对齐 tabbar 透明度，略低一点点」）。
        `-my-3` 是给横向滚动条留白的负边距，吸顶后要归零，否则 top 会差 12px。
    -->
    <div
      v-if="classes.length"
      ref="chipsEl"
      :data-fade="chipsFadeAttr"
      class="cat-chips no-scrollbar -mx-6 mb-3 flex gap-1.5 overflow-x-auto overflow-y-hidden px-6 py-3 -my-3 max-sm:sticky max-sm:top-[var(--header-h)] max-sm:z-20 max-sm:-mx-3 max-sm:my-0 max-sm:mb-2 max-sm:border-b max-sm:border-line/60 max-sm:bg-[var(--color-strip-veil)] max-sm:px-3 max-sm:py-2.5 max-sm:backdrop-blur-xl max-sm:backdrop-saturate-[180%]"
      @focusin="onChipFocus"
      @scroll="updateChipsFade"
      @wheel="onChipsWheel"
    >
      <button
        v-for="c in classes"
        :key="c.type_id"
        class="shrink-0 rounded-full px-4 py-1.5 text-sm transition"
        :class="
          c.type_id === activeTid
            ? 'bg-accent font-medium text-on-accent'
            : 'bg-card text-ink hover:bg-card-hover'
        "
        @click="switchClass(c.type_id)"
      >
        {{ c.type_name }}
      </button>
    </div>
    <!-- 加载骨架：和真实网格同列数，避免加载完从 24 格缩成 12 格跳一下 -->
    <div v-if="loading" class="poster-grid" :style="colsStyle(cols)">
      <div v-for="i in firstRows * cols" :key="i">
        <div class="skeleton aspect-[2/3] rounded-lg" />
        <div class="skeleton mt-2 h-3.5 w-4/5 rounded" />
        <div class="skeleton mt-1.5 h-3 w-1/2 rounded" />
      </div>
    </div>

    <!-- 错误 -->
    <EmptyState
      v-else-if="error && !list?.length"
      icon="📭"
      :title="error"
      hint="可以换个站点试试"
    >
      <button class="rounded-md bg-card px-4 py-2.5 text-sm hover:bg-card-hover" @click="loadHome()">
        刷新
      </button>
      <button
        class="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-on-accent hover:bg-accent-dim"
        @click="openSitePicker"
      >
        换个站点
      </button>
    </EmptyState>

    <!-- 网格 -->
    <template v-else>
      <!--
        续播卡（只在真有一部片看到一半时出现）。
        ★ 不做「列表第一条」大图：那和网格第一张重复，也和用户无关。
      -->
      <div
        v-if="heroEnabled && resume"
        data-tv-col="hero"
        class="surface-1 hero-card group relative mb-5 overflow-hidden rounded-panel"
      >
        <!-- 背景：同一张海报放大 + 模糊，只做氛围；TV/老内核由 CSS 关掉 filter -->
        <div
          class="hero-bg pointer-events-none absolute inset-0"
          :style="{ backgroundImage: `url(${proxyImage(resumePic)})` }"
          aria-hidden="true"
        />
        <div class="hero-scrim pointer-events-none absolute inset-0" />
        <div class="hero-body relative flex items-center gap-4 p-4 sm:gap-6 sm:p-5">
          <button
            type="button"
            data-tv-skip
            class="hero-poster aspect-[2/3] w-20 shrink-0 overflow-hidden rounded-lg sm:w-28"
            :aria-label="`继续观看 ${resume.vod_name}`"
            @click="openResume"
          >
            <PosterImage :src="resumePic" :alt="resume.vod_name" />
          </button>
          <div class="relative min-w-0 flex-1 lg:max-w-[30rem]">
            <!-- 评分放左栏右上角（用户指定位置）：只有 detail 带分才显示 -->
            <div
              v-if="resumeScore"
              class="absolute right-0 top-0 flex items-center gap-1"
              :title="`评分 ${resumeScore}`"
            >
              <svg class="hero-star h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2.6l2.9 6 6.6.9-4.8 4.7 1.2 6.5L12 17.6 6.1 20.7l1.2-6.5L2.5 9.5l6.6-.9z" />
              </svg>
              <span class="hero-ink text-[15px] font-semibold tabular-nums">{{ resumeScore }}</span>
            </div>
            <p class="hero-ink-3 text-xs font-medium tracking-wide">继续观看</p>
            <button
              type="button"
              tabindex="-1"
              data-tv-skip
              class="hero-title-btn mt-1 inline-block max-w-full truncate text-left"
              @click="openResume"
            >
              <span class="detail-title hero-ink font-semibold">{{ resume.vod_name }}</span>
            </button>
            <div
              v-if="resumeMeta || resumeChips.length"
              class="hero-facts mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span v-if="resumeMeta" class="hero-ink-2 truncate text-sm">{{ resumeMeta }}</span>
              <span
                v-for="c in resumeChips"
                :key="c"
                class="hero-chip max-w-[9rem] truncate rounded-full px-2 py-0.5 text-[11px]"
              >
                {{ c }}
              </span>
            </div>

            <div v-if="resumePct" class="mt-3 max-w-[26rem]">
              <div class="hero-track h-1 overflow-hidden rounded-full">
                <div class="h-full rounded-full bg-accent" :style="{ width: `${resumePct}%` }" />
              </div>
              <p class="hero-ink-3 hero-progress-text mt-1.5 text-xs tabular-nums">
                {{ fmtClock(resume.pos || 0) }}
                <span v-if="resume.dur">/ {{ fmtClock(resume.dur) }}</span>
                <span v-if="resumeLeft" class="ml-2 opacity-80">{{ resumeLeft }}</span>
              </p>
            </div>

            <div class="hero-actions mt-3 flex items-center gap-2">
              <button
                type="button"
                class="btn-primary-gradient inline-flex rounded-full px-4 py-1.5 text-sm font-medium text-on-accent"
                @click="openResume"
              >
                继续播放
              </button>
              <button
                type="button"
                class="hero-ink-2 hero-divider rounded-full border px-3.5 py-1.5 text-sm transition hover:opacity-80"
                @click="openResumeDetail"
              >
                详情
              </button>
            </div>
          </div>

          <!--
            右侧：这部片的简介 + 元数据。
            ★ 原来这里是「接下来」两条备选，用户反馈不如直接看简介有意义。
            ★★ 不用 ml-auto：那会把它甩到卡片最右边，和左边正文之间空出半张卡；
               改成紧跟左栏（左栏 lg 上限 30rem），整组内容靠左成块。
            <lg 隐藏（平板/手机上宽度不够，硬塞会把标题压成省略号）。
          -->
          <div
            v-if="resumeIntro || resumeChips.length || resumeStaff.length"
            class="hero-side hero-divider hidden w-[26rem] shrink-0 flex-col border-l pl-5 lg:flex"
          >
            <p class="hero-ink-3 text-[11px] font-medium tracking-[0.08em]">剧情简介</p>
            <p
              v-if="resumeIntro"
              class="hero-ink-2 hero-intro mt-2 overflow-hidden text-[13px] leading-[1.75] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4]"
            >
              {{ resumeIntro }}
            </p>
            <p
              v-for="f in resumeStaff"
              :key="f.k"
              class="hero-staff mt-2 flex gap-2 text-[12px] leading-tight"
            >
              <span class="hero-ink-3 shrink-0">{{ f.k }}</span>
              <span class="hero-ink-2 min-w-0 flex-1 truncate">{{ f.v }}</span>
            </p>
          </div>
        </div>
      </div>

      <div class="poster-grid" :style="colsStyle(cols)">
        <div v-for="item in list" :key="item.vod_id" class="fade-up">
          <PosterCard :item="item" :site="site" @open="remember" />
        </div>
      </div>

      <!--
        翻页状态就在网格末尾（用户滚到底才需要它）。
        ★ 翻页失败原来只写 error，而 error 的展示条件带 `!list.length`——
          已经有内容时这条错误**完全不显示**，表现是"滚到底不动了，
          也不知道为什么"。所以这里单独给一条带重试的行。
      -->
      <div class="mt-10 flex h-8 items-center justify-center">
        <span v-if="loadingMore" class="flex items-center gap-2 text-xs text-ink-3">
          <span class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-hover border-t-accent" />
          正在加载…
        </span>
        <button
          v-else-if="error && list?.length"
          class="rounded-md bg-card px-3 py-1 text-xs text-hot transition hover:bg-card-hover"
          :title="error"
          @click="loadMore"
        >
          下一页加载失败，点此重试
        </button>
        <span v-else-if="!hasMore && list?.length" class="text-xs text-ink-3">
          已经到底了
        </span>
      </div>
    </template>
  </div>
</template>
