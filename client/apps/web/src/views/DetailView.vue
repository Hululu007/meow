<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchDetail, fetchPlay, parsePlayLines, prefetchDanmaku } from '@/api'
import { startBatchCache } from '@/api/library'
import type { VodItem } from '@/api/types'
import { isFavorite, toggleFavorite } from '@/stores/favorites'
import {
  consumeNewEpisodes,
  recordUpdateHit,
  sessionNewEpisodes,
  type NewEpisodesRange,
} from '@/stores/favUpdates'
import { getProgress, listHistory, pushHistory } from '@/stores/history'
import { getLinePref } from '@/stores/linePref'
import { useAppStore } from '@/stores/app'
import PosterImage from '@/components/common/PosterImage.vue'
import { cleanIntro, cleanLine } from '@/utils/introText'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const site = route.params.site as string
const id = route.params.id as string

const item = ref<VodItem | null>(null)
const lines = ref<Array<{ name: string; episodes: Array<{ name: string; url: string }> }>>([])
const activeLine = ref(0)
const loading = ref(true)
const error = ref('')
/** 拿不到详情时，用入口带来的片名转去搜索页（见 load()） */
const fallbackTitle = ref('')

/**
 * 这个条目来自哪个源（显示名，如「金牌」）。
 *
 * <p>为什么要显示：搜索是聚合的，同一部片可能有十几个源；点进详情后
 * 「播放源」列的是**这个源自己的线路名**（4K / 腾音-4K-限 / CO-4K-限…），
 * 看不出是哪家。用户在两部同名片之间对比时，没有源名就分不清自己在哪。
 *
 * <p>取不到显示名时返回空串（不显示）——宁可没有，也不要甩一个内部 key
 * （Jpys）给用户看。
 */
const siteLabel = computed(() => {
  const s = store.sites.find((x) => x.key === site)
  return s?.name || ''
})

// ---------------------------------------------------------------- 简介展开

/** 简介默认折叠 4 行；真的放不下时才给「展开简介」 */
const descExpanded = ref(false)
const descEl = ref<HTMLElement | null>(null)
/** 这段简介是否**真的**被折叠了（短简介不该出现按钮） */
const descClamped = ref(false)
// 源站简介里混着标签/BBcode/JSON（实测 B 站源首行就是 {"id":…}），渲染前统一净化
const descText = computed(() => cleanIntro(item.value?.vod_content))

/**
 * 判断简介有没有被 4 行截断。
 *
 * <p>`scrollHeight > clientHeight` 在 `-webkit-line-clamp` 下是可靠的
 * （MuMu 实测：110 字 → 137 > 91）。老内核万一量不出来，用字数兜底：
 * 左栏固定 30rem、4 行约 120 个汉字，超过 150 字一定放不下——
 * 宁可多给一个点了没变化的按钮，也不要让长简介在投影仪上永远被截断。
 */
function measureDesc() {
  if (descExpanded.value) return
  const el = descEl.value
  if (!el) return
  descClamped.value = el.scrollHeight > el.clientHeight + 2 || descText.value.length > 150
}

function onDescResize() {
  void nextTick(measureDesc)
}

watch(descText, () => {
  descExpanded.value = false
  void nextTick(measureDesc)
})

/** 收藏状态：以 localStorage 为准，详情页加载完才知道 site/vod_id */
const favorited = ref(false)

function syncFavorite() {
  favorited.value = isFavorite(site, id)
}

function onToggleFavorite() {
  const v = item.value
  if (!v) return
  favorited.value = toggleFavorite({
    site,
    vod_id: v.vod_id || id,
    vod_name: v.vod_name || '',
    vod_pic: v.vod_pic || '',
    vod_remarks: v.vod_remarks || '',
  })
}

async function load() {
  loading.value = true
  error.value = ''
  fallbackTitle.value = ''
  try {
    const r = await fetchDetail(site, id)
    const v = r.list?.[0]
    if (!v) {
      /*
       * 该源拿不到详情 → 直接转去搜索页搜片名（2026-11-03 用户要求）。
       *
       * <p><b>为什么是"转走"而不是"停在空页面"</b>：实测这类情况集中在豆瓣源——
       * 它的 `/detail` 返回空 list（列表页有海报和片名，但详情接口不给数据）。
       * 用户在首页/榜单点进海报，看到的是一整屏空白 +「未获取到详情」，
       * 唯一的出路是手动按返回再去搜。而"这个片名"恰好在进页面前就有了。
       *
       * <p>片名来源依次退：路由 query 的 `name`（入口带上来的）→ 上一次
       * 列表里记住的 → 没有就不跳（空关键词搜索页毫无意义）。
       * 跳转用 replace：详情页本身已经是死路，留在返回栈里只会让用户
       * 按返回时又回到空白页。
       */
      const t = String(route.query.name || '').trim()
      if (t) {
        fallbackTitle.value = t
        void router.replace({ name: 'search', query: { wd: t } })
        return
      }
      error.value = '未获取到详情'
      return
    }
    item.value = v
    lines.value = parsePlayLines(v.vod_play_from || '', v.vod_play_url || '')
    if (!lines.value.length) error.value = '该片暂无播放源'
    computeNewEpisodes(v)
    // 优先落到用户上次在这部片上选的线路（源站改过名字就退回第一条）
    if (lines.value.length > 1) {
      const want = getLinePref(site, v.vod_id || id)
      const i = lines.value.findIndex((l) => l.name === want)
      if (i >= 0) activeLine.value = i
    }
    // 点开详情页就记一笔历史：用户可能只是想看看简介，
    // 但它确实是"最近关注过的片"，历史页该能找回。不带进度字段，
    // mergeInto 会沿用已有进度，不会把之前的续播点抹掉。
    pushHistory(
      {
        site,
        siteName: store.currentSite?.name || site,
        vod_id: v.vod_id || id,
        vod_name: v.vod_name || '',
        vod_pic: v.vod_pic || '',
        vod_remarks: v.vod_remarks || '',
        at: Date.now(),
      },
      { notify: false },
    )
    syncFavorite()
    maybePrefetchFirstDanmaku(v.vod_name || '')
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

// ---------------------------------------------------------------- 自上次看的新集数
//
// 追剧用户的回访路径是"详情页 → 播放页"，不是收藏页。所以"有没有更新"
// 在这里判：本次 detail 响应里 remarks / 剧集表都是现成的，对比是纯本地
// 操作（读一次快照 + 写回），**零额外请求**。
//
// 基线 = favUpdates 的 seen（上次打开详情页/收藏那一刻的 remarks）。

/** 自上次看新增的集数范围（null = 没有可比基准或没有新增） */
const newEps = ref<NewEpisodesRange | null>(null)

function computeNewEpisodes(v: VodItem) {
  const vid = v.vod_id || id
  // 各线路集数可能不同（有的源线路二少几集），按最长的算 —— 标新时
  // 每条线路按自己的格子数截断，短线路自动少标
  const total = lines.value.reduce((m, l) => Math.max(m, l.episodes.length), 0)
  // 会话内已经算过（详情 → 播放 → 返回详情）就直接用，别把基线再推一遍
  newEps.value = sessionNewEpisodes(site, vid) || consumeNewEpisodes(site, vid, v.vod_remarks || '', total)
  if (newEps.value && isFavorite(site, vid)) {
    // 只给收藏中的剧挂未读提醒：顶栏红点数的是 hits 总数，
    // 非收藏的剧挂进去会让红点数字和收藏页对不上
    recordUpdateHit(site, vid, v.vod_remarks || '')
  }
}

/** 集数序号（0 起）是不是"上次看之后新出的" */
function isNewEp(index: number): boolean {
  const r = newEps.value
  return !!r && index >= r.from - 1
}

/**
 * 详情页预取第一集弹幕。
 *
 * <p><b>为什么是详情页</b>：播放页的「下集预取」只覆盖第 2 集往后，
 * **第 1 集永远是冷启动** —— 而这恰恰最常被点（新剧、试看）。
 * 用户在详情页挑线路、看简介通常停留 3–10 秒，正好够 danmu_api 跑完
 * （实测 5–14 秒，多数落在 8 秒内）；等他点播放时缓存已经热了。
 *
 * <p><b>只对「没看过」的片预取</b>（2026-11-02 用户口径：历史页进详情页没必要，
 * 正常搜索/首页进详情页才该预取）：
 * 有观看进度的片，用户要么点「继续观看」（直接跳播放页，跳过本页逻辑），
 * 要么进详情页后自己挑已看过的那一集 —— 两种都不会点第 1 集。
 * 给这样的片预取第 1 集纯属浪费一次聚合请求（还可能占上游限流额度）。
 *
 * <p>失败一律沉默：预取是纯优化，不该在详情页弹任何错误。
 * 后端自己判定（开关关闭回 disabled，已缓存回 cached）。
 */
function maybePrefetchFirstDanmaku(name: string) {
  if (!name) return
  // 看过这部片（哪怕只看到 1 分钟）→ 不预取第 1 集
  if (getProgress({ site, vod_id: item.value?.vod_id || id })) return
  const line = lines.value[activeLine.value]
  const first = line?.episodes?.[0]
  if (!first?.name) return
  prefetchDanmaku(name, first.name)
}

function play(ep: { name: string; url: string }) {
  const line = lines.value[activeLine.value]
  router.push({
    name: 'play',
    params: { site },
    query: {
      flag: line?.name || '',
      // vue-router 会自己做一次编码，这里不要再手动 encode
      id: ep.url,
      name: item.value?.vod_name || '',
      ep: ep.name,
      // 影片 id：播放页用它补剧集表、记录续播进度
      vod: item.value?.vod_id || '',
      // 把整条线路的剧集带过去，播放页据此自动连播
      list: JSON.stringify(line?.episodes || []),
    },
  })
}

/** 找到第一集，用于"立即播放" */
function playFirst() {
  const line = lines.value[activeLine.value]
  const ep = line?.episodes?.[0]
  if (ep) play(ep)
}

/**
 * 详情有、线路为空时，"去其它源搜索"用的片名。
 *
 * <p><b>为什么现在必须有这个出口</b>（2026-11-05 用户报）：豆瓣原生源的
 * `vod_play_from` **恒空** —— 它的详情页只有简介/演员/评分，本来就不提供
 * 播放地址。于是"有详情、无线路"从边缘情况变成了豆瓣的**主路径**：
 * 每张豆瓣海报点进来都是死路，「立即播放」灰着，只能自己返回再手打片名。
 *
 * <p>片名取值：详情里的 `vod_name` 优先（最准），其次路由 query 的 `name`
 * （列表入口带上来的）。
 */
const searchTitle = computed(() =>
  String(item.value?.vod_name || route.query.name || '').trim(),
)

/**
 * 去聚合搜索页搜同名片。
 *
 * <p>用 `push` 而不是 `replace`：详情页本身是有内容的（简介/演员），
 * 用户可能只是想先看看资料，再决定去哪个源 —— 返回键该能回到这一页。
 * 只有"详情都拿不到"（整页空白）那条路径才用 replace。
 */
function searchOtherSources() {
  const t = searchTitle.value
  if (!t) return
  void router.push({ name: 'search', query: { wd: t } })
}

/**
 * 上次看到哪一集。
 *
 * 直接读历史条目而不是 `getProgress()`：后者只返回秒数，
 * 续播还需要知道"是哪一集"，而这信息在条目上是 `ep` / `ep_url`。
 *
 * 按集名在当前线路里找而不是按 url——用户可能换过线路，
 * url 必然变了，但集名（「第03集」）在各线路间通常一致。
 * 名字对不上就放弃续播：宁可从第一集开始，也不要跳到一个不存在的集。
 */
const lastWatched = computed(() => {
  const v = item.value
  if (!v) return null
  const it = listHistory().find((x) => x.site === site && x.vod_id === (v.vod_id || id))
  if (!it || typeof it.pos !== 'number' || it.pos < 1 || !it.ep_at) return null
  const eps = lines.value[activeLine.value]?.episodes || []
  const ep = (it.ep ? eps.find((e) => e.name === it.ep) : null) ||
    eps.find((e) => e.url === it.ep_url)
  if (!ep) return null
  return { ep, pos: it.pos, label: it.ep || ep.name, flag: it.flag || '' }
})

/** 继续上次那一集 */
function playResume() {
  const r = lastWatched.value
  if (r) play(r.ep)
}

// ---------------------------------------------------------------- 缓存整季

/**
 * 整季缓存的进行态。
 *
 * <p>必须先逐集走一次 `play` 拿真实媒体地址：详情页给的是**播放页地址**，
 * 而缓存是按 URL 抓分片的。拿当前集地址套到每一集会下出同一个文件
 * （源站给的是带签名的独立地址）。
 *
 * <p>需要解析器的集跳过而不是硬塞：解析出的地址通常带时效，
 * 存下来的分片过几小时就播不了。这条与 PlayView 的 downloadAll 口径一致。
 */
const cacheBusy = ref(false)
const cacheMsg = ref('')
const cacheBatchId = ref('')

const epCount = computed(() => lines.value[activeLine.value]?.episodes?.length || 0)

/**
 * 选集分段（2026-11-04 用户要求：集数过多时按 100 集分段）。
 *
 * <p>为什么必须分段 + 内部滚动：短剧/长剧动辄 100~300 集，整季一次性铺开
 * 会把整页撑到几千像素高 —— 用户想点第 200 集得先滚过 199 个按钮，
 * 而 TV 上遥控器还要一格一格移焦点。
 *
 * <p>分段后每屏最多 100 格（约 10 行），选集区自己滚，页面不动。
 */
const EP_PAGE_SIZE = 100
/** 当前选集分段下标（0 = 第 1-100 集） */
const epPage = ref(0)
/** 选集滚动容器：切换分段后要滚回顶部、TV 上还要把焦点交给首集 */
const epScrollEl = ref<HTMLElement | null>(null)
const epPages = computed(() => Math.max(1, Math.ceil(epCount.value / EP_PAGE_SIZE)))
/** 当前分段的集数区间（下标） */
const epRange = computed(() => {
  const start = epPage.value * EP_PAGE_SIZE
  return { start, end: Math.min(start + EP_PAGE_SIZE, epCount.value) }
})
/** 当前分段里的剧集 */
const epSlice = computed(() => {
  const all = lines.value[activeLine.value]?.episodes || []
  return all.slice(epRange.value.start, epRange.value.end)
})

/** 换线路后回到第一段（否则会停在"第 3 段"但新线路只有 20 集，列表空着） */
function selectLine(i: number) {
  activeLine.value = i
  epPage.value = 0
}

/**
 * 切换选集分段。
 *
 * 两个动作缺一不可（2026-11-04 用户报）：
 *   ① 滚回顶部 —— 否则从第 2 段切回第 1 段，看到的是第 90 多集附近
 *   ② TV 上把焦点交给该段第一集 —— 用户确认胶囊后本来就想选片，
 *      停在胶囊上还得再按一次下键才进列表
 */
async function selectEpPage(p: number) {
  epPage.value = p
  await nextTick()
  const box = epScrollEl.value
  if (box) box.scrollTop = 0
  const first = box?.querySelector('button')
  const focus = (window as unknown as {
    __meowTvFocus?: (el: Element, pin?: boolean) => void
  }).__meowTvFocus
  // 只在 TV 壳里移动焦点（web/PC 没有这个全局函数，鼠标点击不该被抢焦点）
  if (first && typeof focus === 'function') focus(first, true)
}

async function cacheSeason() {
  const v = item.value
  const line = lines.value[activeLine.value]
  if (!v || !line || !line.episodes.length || cacheBusy.value) return
  cacheBusy.value = true
  cacheMsg.value = ''
  cacheBatchId.value = ''
  let needParse = 0
  try {
    const items: Array<{ ep: string; name: string; url: string }> = []
    const total = line.episodes.length
    let done = 0
    for (const ep of line.episodes) {
      try {
        const r = await fetchPlay(site, line.name, ep.url)
        const u = typeof r.url === 'string' ? r.url : ''
        // 要解析器（parse=1）的集也跳过：它给的是播放页地址而不是媒体清单，
        // 缓存下来后端会在「这不是 m3u8 清单」处失败，而解析出的真实地址带时效，
        // 存几小时后就播不了。宁可少下几集，也不要塞一批注定失败的任务。
        if (r.parse === 1 || !u || !/^https?:/i.test(u)) {
          needParse++
          continue
        }
        items.push({ ep: ep.name, name: v.vod_name || '', url: u })
      } catch {
        /* 单集取不到就跳过，不要把整季拖死 */
      } finally {
        done++
        cacheMsg.value = `正在获取地址 ${done}/${total}…`
      }
    }
    if (!items.length) {
      cacheMsg.value = '没有可直接下载的集（该线路需要解析器，解析出的地址带时效，存下来很快失效）'
      return
    }
    const r = await startBatchCache({ site, vodId: v.vod_id || id, items })
    if (!r.ok) {
      cacheMsg.value = r.msg || '后端没有接受任何一集'
      return
    }
    cacheBatchId.value = r.batch
    const parts = [`已加入 ${r.count} 集到下载队列`]
    if (r.skipped.length) parts.push(`后端跳过 ${r.skipped.length} 集（${r.skipped[0].reason}）`)
    if (needParse) parts.push(`${needParse} 集需解析器未加入`)
    cacheMsg.value = parts.join('，')
  } catch (e: any) {
    cacheMsg.value = `加入下载队列失败：${e?.message || String(e)}`
  } finally {
    cacheBusy.value = false
  }
}

function gotoOffline() {
  // 缓存列表已并入片库页（原「离线」页签取消），跳片库即可看到「我的缓存」分区
  void router.push({ name: 'library' })
}

function clock(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}

onMounted(() => {
  // 窗口/字体变化（TV 根字号随视口阶梯）会改变行宽，折叠判定要重量
  window.addEventListener('resize', onDescResize)
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onDescResize)
})
</script>

<template>
  <div class="mx-auto max-w-6xl px-6 py-6 max-sm:px-3 max-sm:py-4">
    <button
      class="mb-5 flex items-center gap-1.5 text-sm text-ink-2 transition hover:text-accent max-sm:mb-3 max-sm:text-[13px]"
      @click="router.back()"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m15 18-6-6 6-6" />
      </svg>
      返回
    </button>

    <div v-if="loading" class="flex gap-8 max-sm:gap-4">
      <div class="skeleton aspect-[2/3] w-56 shrink-0 rounded-xl max-sm:w-24" />
      <div class="flex-1 space-y-3">
        <div class="skeleton h-8 w-2/3 rounded" />
        <div class="skeleton h-4 w-1/3 rounded" />
        <div class="skeleton h-20 w-full rounded" />
      </div>
    </div>

    <div v-else-if="error && !item" class="py-20 text-center text-ink-2">
      {{ error }}
    </div>

    <template v-else-if="item">
      <!--
        大屏两栏：左海报+信息，右播放源+剧集。
        ★ 为什么这样分：大屏上"选片"和"选集"是两个连续动作，
          原来上下堆叠时选集要滚一屏才看到，用户以为没有选集入口。
          左栏回答"这是什么"，右栏回答"怎么看"，视线不用上下跑。
        窄屏（<lg）保持单列：手机一屏只放得下一栏。
      -->
      <div class="flex flex-col gap-8 max-sm:gap-6 lg:flex-row lg:items-start lg:gap-10">
      <!-- 左栏：海报 + 信息 + 主操作 -->
      <!--
        data-tv-col：TV 上下键**只在同一列里**找目标。
        踩过（2026-11-04 用户报）：简介展开后「收起简介」的 y 恰好落在
        集数第 3 行的水平带上，从 14 按上键会因为它的纵向距离更小（1px）
        而跳到左栏。列隔离后左侧上下不到右侧、右侧上下不到左侧，
        只在左/右键时才跨列。
      -->
      <div
        data-tv-col="left"
        class="block sm:flex sm:flex-row sm:gap-8 lg:w-[30rem] lg:shrink-0 lg:gap-5"
      >
        <!--
          ★ 大屏不能给海报整栏宽：2:3 比例下 368px 宽 = 552px 高，
            叠在 640 高的电视视口里会把片名/简介/按钮全推到屏幕外
            （实测 MuMu：h1 在 y=720，完全看不见）。
            所以 lg 起改成"海报固定 11rem + 信息在右"，左栏整体也就 300px 出头。
        -->
        <div class="w-full shrink-0 max-sm:float-left max-sm:mb-1 max-sm:mr-3.5 max-sm:w-24 sm:w-56 lg:w-44">
          <div class="aspect-[2/3] overflow-hidden rounded-xl bg-elevated shadow-2xl max-sm:rounded-lg">
            <PosterImage :src="item.vod_pic" :alt="item.vod_name" />
          </div>
        </div>

        <div class="min-w-0 flex-1">
          <h1 class="text-3xl font-semibold leading-tight tracking-tight max-sm:text-[22px] lg:text-2xl">{{ item.vod_name }}</h1>

          <!--
            自上次看的新增集数（2026-11-06 用户点单"详情页标新"）。
            只在真的算出新增时出现；基线是上次打开详情页/收藏那一刻的
            remarks，对比在本地完成，不花任何请求。
          -->
          <div
            v-if="newEps"
            class="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent/12 px-2.5 py-1 text-xs font-medium text-accent max-sm:text-[11px]"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-accent" />
            自上次看新增 {{ newEps.count }} 集
          </div>

          <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-3 max-sm:mt-2 max-sm:gap-x-2 max-sm:gap-y-1 max-sm:text-[13px]">
            <span v-if="item.vod_year">{{ item.vod_year }}</span>
            <span v-if="item.vod_area">{{ item.vod_area }}</span>
            <span v-if="item.vod_remarks" class="rounded bg-accent/15 px-1.5 py-0.5 text-accent">
              {{ item.vod_remarks }}
            </span>
            <!--
              来源：搜索是聚合的，同一部片可能来自十几个源；点进来后「播放源」
              列的是这个源自己的线路名（4K / 腾音-4K-限…），看不出是哪家。
              放在年份/地区这一排，不占新行、不参与焦点。
            -->
            <span v-if="siteLabel" class="rounded bg-white/8 px-1.5 py-0.5 text-ink-2">
              来源 {{ siteLabel }}
            </span>
          </div>

          <div v-if="item.vod_director" class="mt-2 text-sm text-ink-3 max-sm:mt-1.5 max-sm:text-[13px]">
            导演：<span class="text-ink-2">{{ cleanLine(item.vod_director) }}</span>
          </div>
          <div v-if="item.vod_actor" class="mt-1 line-clamp-2 text-sm text-ink-3 max-sm:text-[13px]">
            主演：<span class="text-ink-2">{{ cleanLine(item.vod_actor) }}</span>
          </div>

          <template v-if="descText">
            <p
              ref="descEl"
              class="mt-4 text-sm leading-relaxed text-ink-2 max-sm:mt-3 max-sm:text-[13px] max-sm:leading-6"
              :class="descExpanded ? '' : 'line-clamp-4'"
            >
              {{ descText }}
            </p>
            <!--
              只有真的被截断才出现（短简介不该多一个按钮）。
              按钮本身可聚焦：TV 上它是"看完整简介"的唯一入口，
              所以不能做成纯装饰的 span。
            -->
            <button
              v-if="descClamped || descExpanded"
              class="hit-44 mt-1.5 rounded px-2 py-1.5 text-xs text-accent transition hover:underline"
              @click="descExpanded = !descExpanded"
            >
              {{ descExpanded ? '收起简介' : '展开简介' }}
            </button>
          </template>

          <div class="mt-6 flex flex-wrap gap-3 max-sm:mt-4 max-sm:clear-both max-sm:gap-2">
            <!--
              有进度时主按钮变成"继续看第N集"，比"立即播放"更符合回来的意图。
              data-tv-first：遥控器进来就落在这儿。默认落点是 DOM 第一个可聚焦
              元素——也就是左上角的「返回」，用户要往下按两次才能播片。
            -->
            <button
              v-if="lastWatched"
              :data-tv-first="lines.length ? '' : undefined"
              class="flex items-center gap-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-dim disabled:opacity-40"
              :disabled="!lines.length"
              :title="`从 ${clock(lastWatched.pos)} 继续`"
              @click="playResume"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              继续看 {{ lastWatched.label }}
            </button>
            <button
              v-else
              :data-tv-first="lines.length ? '' : undefined"
              class="flex items-center gap-2 rounded-lg bg-accent px-6 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-dim disabled:opacity-40"
              :disabled="!lines.length"
              @click="playFirst"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              立即播放
            </button>
            <!-- 有进度时保留"从头看"的出口，否则用户只能删历史才能重看 -->
            <button
              v-if="lastWatched"
              class="flex items-center gap-2 rounded-lg bg-card px-5 py-2.5 text-sm font-medium text-ink-2 transition hover:bg-card-hover hover:text-ink disabled:opacity-40"
              :disabled="!lines.length"
              @click="playFirst"
            >
              从第 1 集看
            </button>

            <button
              class="flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition"
              :class="
                favorited
                  ? 'bg-accent/15 text-accent hover:bg-accent/25'
                  : 'bg-card text-ink-2 hover:bg-card-hover hover:text-ink'
              "
              :aria-pressed="favorited"
              :title="favorited ? '取消收藏' : '加入收藏'"
              @click="onToggleFavorite"
            >
              <svg
                class="h-4 w-4"
                viewBox="0 0 24 24"
                :fill="favorited ? 'currentColor' : 'none'"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
              </svg>
              {{ favorited ? '已收藏' : '收藏' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 右栏：播放源 + 剧集 -->
      <div data-tv-col="right" class="min-w-0 flex-1 max-sm:mt-0.5">
        <!-- 播放源 -->
        <section v-if="lines.length">
          <h2 class="text-sm font-medium text-ink-2">播放源</h2>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              v-for="(l, i) in lines"
              :key="l.name + i"
              class="rounded-full px-4 py-1.5 text-sm transition max-sm:px-3 max-sm:py-1 max-sm:text-[13px]"
              :class="
                i === activeLine
                  ? 'bg-accent font-medium text-on-accent'
                  : 'bg-card text-ink-2 hover:bg-card-hover hover:text-ink'
              "
              @click="selectLine(i)"
            >
              {{ l.name }}
              <span class="ml-1 text-[11px] opacity-60">{{ l.episodes.length }}</span>
            </button>
          </div>

          <div class="mt-8 flex flex-wrap items-center gap-3 max-sm:mt-6">
            <h2 class="text-sm font-medium text-ink-2">剧集</h2>
            <span class="text-[11px] text-ink-3">当前线路 {{ epCount }} 集</span>
            <button
              class="ml-auto rounded-md bg-card px-3 py-1.5 text-xs text-ink-2 transition hover:bg-card-hover hover:text-ink disabled:opacity-40"
              :disabled="cacheBusy || !epCount"
              :title="`把「${lines[activeLine]?.name || ''}」这条线路的全部 ${epCount} 集加入离线缓存队列`"
              @click="cacheSeason"
            >
              {{ cacheBusy ? '准备中…' : '缓存整季' }}
            </button>
          </div>
          <!-- 成功了要给"去哪看"的出口：缓存是后台任务，光说"已加入"用户不知道下一步 -->
          <div
            v-if="cacheMsg"
            class="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-field px-2.5 py-1.5 text-[11px] leading-relaxed text-ink-2"
          >
            <span class="min-w-0 flex-1">{{ cacheMsg }}</span>
            <button
              v-if="cacheBatchId"
              class="shrink-0 rounded bg-accent/15 px-2 py-0.5 text-accent transition hover:bg-accent/25"
              @click="gotoOffline"
            >
              去离线页查看进度
            </button>
          </div>
          <!--
            分段胶囊：每 100 集一段（2026-11-04）。
            只在真的超过 100 集时出现 —— 常见 24/40 集的剧不该多出一行按钮。
          -->
          <div v-if="epPages > 1" class="mt-3 flex flex-wrap items-center gap-1.5">
            <button
              v-for="p in epPages"
              :key="p"
              class="rounded-full px-3 py-1 text-xs transition max-sm:py-1.5"
              :class="
                p - 1 === epPage
                  ? 'bg-accent font-medium text-on-accent'
                  : 'bg-card text-ink-2 hover:bg-card-hover hover:text-ink'
              "
              @click="selectEpPage(p - 1)"
            >
              {{ (p - 1) * EP_PAGE_SIZE + 1 }}-{{ Math.min(p * EP_PAGE_SIZE, epCount) }}
            </button>
          </div>

          <!--
            选集区自己滚：max-h 用视口比例，TV 的 CSS 视口比 PC 小得多。
            ★ 不给 tabindex / data-tv-scroll（2026-11-04 修正）。
              加了它会成为**焦点停靠点**，而它的矩形包住所有集数按钮，
              几何上 primary=0+0.6 折扣，于是从第 1 集按下键先落到这个
              空容器上（画一根左竖条），再按才进第 3 行。
              滚动不需要它：tv-nav 的 scrollIntoViewWithin 会滚最近的
              可滚祖先，焦点移到视口外的集数时自然跟着滚。
          -->
          <div ref="epScrollEl" class="mt-3 -mx-2 max-h-[52vh] overflow-y-auto px-2 pb-2 pt-1">
            <div class="grid grid-cols-3 gap-2 max-sm:grid-cols-4 max-sm:gap-1.5 sm:grid-cols-5 md:grid-cols-8 lg:grid-cols-6 xl:grid-cols-8">
              <button
                v-for="(ep, epIdx) in epSlice"
                :key="ep.name + ep.url"
                class="relative truncate rounded-md bg-card px-2 py-2 text-center text-[13px] text-ink-2 transition hover:bg-accent/20 hover:text-accent max-sm:px-1 max-sm:py-2 max-sm:text-[12px]"
                :title="isNewEp(epRange.start + epIdx) ? `${ep.name} · 自上次看新增` : ep.name"
                @click="play(ep)"
              >
                {{ ep.name }}
                <!-- 新集数红点：格子小（一行 8 个），点比角标省地方 -->
                <span
                  v-if="isNewEp(epRange.start + epIdx)"
                  class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                />
              </button>
            </div>
          </div>
        </section>

        <!--
          线路为空：给一条真正能走的出路（2026-11-05）。

          豆瓣原生源恒无线路，这不是异常而是它的常态；停在"该片暂无播放源"
          等于让用户自己返回再手打片名。按钮带 data-tv-first：播放按钮此时
          是 disabled，tv-nav 会跳过它，没有这个标记焦点会落到「返回」上。
        -->
        <div
          v-else-if="error"
          class="rounded-lg border border-line bg-surface p-6 text-center text-sm text-ink-2"
        >
          <p>{{ error }}</p>
          <button
            v-if="searchTitle"
            data-tv-first
            class="mt-4 inline-flex max-w-full items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-dim"
            @click="searchOtherSources"
          >
            <span class="truncate">在其它源搜索「{{ searchTitle }}」</span>
          </button>
        </div>
      </div><!-- /右栏 -->
      </div><!-- /两栏容器 -->
    </template>
  </div>
</template>
