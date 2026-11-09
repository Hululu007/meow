<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  fetchCategory,
  fetchSearch,
  fetchSearchAll,
  fetchSearchSnapshot,
  startSearch,
} from '@/api'
import type { VodItem } from '@/api/types'
import { rankGroups } from '@/api/searchRank'
import { siteAffinity } from '@/api/searchAffinity'
import PosterCard from '@/components/common/PosterCard.vue'
import PosterImage from '@/components/common/PosterImage.vue'
import { colsStyle, useCardCols } from '@/composables/useCardCols'
import { useAppStore } from '@/stores/app'
import { getPrefs } from '@/stores/prefs'
import {
  addSearchHistory,
  listSearchHistory,
  removeSearchHistory,
  clearSearchHistory,
} from '@/stores/searchHistory'
import { hasNativeInput, nativeInputText, shouldUseNativeInput, beginInlineInput } from '@/api/nativeBridge'
import { useReturnRestore } from '@/composables/useReturnRestore'

// 返回上一页时恢复滚动位置与焦点（TV 上从详情返回不该跳回顶部）
useReturnRestore('search')

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const layout = getPrefs().searchLayout

const wd = computed(() => (route.query.wd as string) || '')
const scope = ref<'current' | 'all'>('all')
const keyword = ref(wd.value)
/** 搜索框（进页面自动聚焦，见 onMounted） */
const inputEl = ref<HTMLInputElement | null>(null)

const loading = ref(false)
/**
 * 搜索序号：防止旧请求的结果覆盖新搜索。
 *
 * 用户连按两次搜索、或第一批还没回来就改了关键词时，旧请求的 response
 * 仍会到达。没有这个序号的话新结果会被旧结果覆盖（实测表现为
 * "搜索框是新的词，列表是上一个词的结果"）。
 */
let runSeq = 0
/**
 * 搜索轮询周期（毫秒）。
 *
 * 实测定出来的：首批结果 0.3~1.0 秒回来，3 秒轮询会错过"边出边看"；
 * 300ms 请求量又多一半。500ms 时一次搜索约 6~8 个请求。
 */
const SEARCH_POLL_MS = 500
/**
 * 搜索进度（已返回源数 / 总源数）。
 *
 * 后端 SearchTask 一直在维护这两个数，但之前前端没读 —— 用户只看到结果数在长，
 * 不知道"还有多少源在跑"。显示出来之后"正在补齐"就有了具体含义。
 */
const searchProgress = ref({ returned: 0, total: 0 })
/**
 * 本轮被噪音词滤掉的条数。
 *
 * <p>必须显示：不显示的话用户看到结果变少会以为源站没有这部片，
 * 而实际上是自己配的词表滤掉了（改完设置忘了自己开过过滤很常见）。
 */
const noiseFiltered = ref(0)
/** 「仅排序降级」模式下被沉底的条数（与 noiseFiltered 互斥：模式决定哪个有值） */
const noiseDowngraded = ref(0)
/**
 * 本轮搜索是否已收尾。
 *
 * <p>为什么需要：命中结果缓存时后端返回的快照是 `returned=0, total=2`、
 * `count=35`（没有源真的被调用，total 是残留值）。按"returned<total"判断
 * 会在结果已经全部出来之后仍显示「（0/2 个源已返回）」，看着像还没搜完。
 * 收尾后直接不显示进度。
 */
const searchFinal = ref(false)
const error = ref('')
const list = ref<VodItem[]>([])
const groups = ref<
  Array<{ vod_name: string; vod_pic: string; vod_remarks?: string; sources: any[] }>
>([])

/** 最近搜索过的词 */
const history = ref<string[]>(listSearchHistory())
function refreshHistory() {
  history.value = listSearchHistory()
}
if (typeof window !== 'undefined') {
  window.addEventListener('meow:search-history', refreshHistory)
}

/** 按源筛选：null = 全部显示 */
const siteFilter = ref<string | null>(null)

/**
 * 把「按片名合并的分组」摊平成「每个源一张卡片」。
 *
 * 后端现在已经是每源一条，这里再摊一次是为了兼容旧缓存/旧后端返回的
 * 合并结构（sources 有多条）。摊平后每条只带自己那一个源，
 * 点进去看到的就是那个源的完整线路，不会被第一个源顶掉。
 */
type Hit = {
  key: string
  vod_name: string
  vod_pic: string
  vod_remarks: string
  site: string
  site_name: string
  vod_id: string
}

const hits = computed<Hit[]>(() => {
  const out: Hit[] = []
  for (const g of groups.value) {
    const srcs = g.sources || []
    if (!srcs.length) continue
    for (const s of srcs) {
      out.push({
        key: `${s.site}\u0000${g.vod_name}\u0000${s.vod_id}`,
        vod_name: g.vod_name,
        vod_pic: g.vod_pic,
        vod_remarks: s.remarks || g.vod_remarks || '',
        site: String(s.site),
        site_name: String(s.site_name || s.site),
        vod_id: String(s.vod_id),
      })
    }
  }
  return out
})

/** 出现在结果里的所有源（含各自命中数），按数量降序 */
const siteTabs = computed(() => {
  const m = new Map<string, { key: string; name: string; count: number }>()
  for (const h of hits.value) {
    const cur = m.get(h.site)
    if (cur) cur.count++
    else m.set(h.site, { key: h.site, name: h.site_name, count: 1 })
  }
  return [...m.values()].sort((a, b) => b.count - a.count)
})

/** 筛选后的结果：只留该源的卡片 */
const visibleHits = computed(() => {
  if (!siteFilter.value) return hits.value
  return hits.value.filter((h) => h.site === siteFilter.value)
})

/** 搜索页容器是 max-w-[1500px] px-6，比首页窄 100px */
function contentWidth(): number {
  return Math.min(document.documentElement.clientWidth || window.innerWidth, 1500) - 48
}

/**
 * 聚合结果左侧有 152px 源栏（仅 md 以上横排时占宽度），
 * 列数必须按扣掉源栏后的宽度算，否则手机上会算出"3 列 38px"。
 */
const { cols: groupCols } = useCardCols({
  width: () =>
    contentWidth() - (window.innerWidth >= 768 && siteTabs.value.length > 1 ? 172 : 0),
})
const { cols: listCols } = useCardCols({ width: contentWidth })

/**
 * @param force 强刷：绕过结果缓存，强制真跑全部源。
 *
 * 没有这个开关时，「重新搜索」和普通搜索完全一样 —— 后端有缓存，
 * 同词第二次是毫秒级返回同一份结果，用户点多少次都看不到新东西。
 */
async function run(force = false) {
  const k = wd.value.trim()
  if (!k) return
  addSearchHistory(k)
  refreshHistory()
  loading.value = true
  searchFinal.value = false
  error.value = ''
  list.value = []
  groups.value = []
  siteFilter.value = null
  const runId = ++runSeq
  searchProgress.value = { returned: 0, total: 0 }
  noiseFiltered.value = 0
  noiseDowngraded.value = 0
  try {
    if (scope.value === 'current' && store.current) {
      const r = await fetchSearch(store.current, k, 1)
      if (runId !== runSeq) return
      list.value = r.list || []
      if (!list.value.length) error.value = '该站点没有找到结果'
    } else {
      /*
       * 聚合搜索走「启动任务 → 轮询快照」：
       * 每 500ms 取一次已完成的部分结果，用户能边看边等。
       *
       * ★ 为什么不用 fetchSearchAll 等最终结果：后端一次同步搜索要占住
       *   一个请求线程 2~20 秒，而请求池只有 12 个线程 —— 实测 12 个并发
       *   搜索会让 /api/health 涨到 9.1 秒，整个应用像卡死。
       *
       * ★ 轮询周期 500ms 是实测定出来的：首批结果 0.3~1.0 秒就回来，
       *   3 秒轮询会错过"边出边看"的最佳时机；300ms 又多花一半请求量。
       */
      const task = await startSearch(k, getPrefs().searchThreads, force)
      if (runId !== runSeq) return
      let snapshot = await fetchSearchSnapshot(task.taskId)
      // 首屏：先把手上的结果渲染出来，加载态保持到第一次拿到内容或任务结束
      let lastError = ''
      let pollFailures = 0
      while (true) {
        if (runId !== runSeq) return
        const groupsNow = snapshot.groups || []
        searchProgress.value = { returned: snapshot.returned || 0, total: snapshot.total || 0 }
        noiseFiltered.value = snapshot.noiseFiltered || 0
        noiseDowngraded.value = snapshot.noiseDowngraded || 0
        if (groupsNow.length) {
          groups.value = groupsNow
          loading.value = false
        }
        if (snapshot.done) {
          /*
           * 收尾时按相关性排序（2026-11-02）。
           *
           * 后端只按"源返回顺序"给分组，实测《我不是大师》53 条里正剧排到
           * 第 25 位之后、前 6 条是"我不是酒神"和哔哩解说。
           * 只在 done 这一次重排：渐进过程保持"新条目追加在末尾"，
           * 否则卡片会在用户眼前反复跳（TV 上还会把焦点带跑）。
           */
          groups.value = rankGroups(groupsNow, k, await siteAffinity())
          lastError = snapshot.error || ''
          break
        }
        await new Promise((r) => setTimeout(r, SEARCH_POLL_MS))
        if (runId !== runSeq) return
        try {
          snapshot = await fetchSearchSnapshot(task.taskId)
          pollFailures = 0
        } catch (e: any) {
          /*
           * 轮询本身失败不该让整次搜索报错——手上的结果还有效，继续重试。
           * 连续 5 次（约 2.5 秒）都拿不到才放弃，避免死循环。
           */
          pollFailures++
          if (pollFailures >= 5) {
            lastError = e?.message || String(e)
            break
          }
        }
      }
      /*
       * 任务失败要给可读提示。
       *
       * 之前这里只判 `groups.length === 0` 就填"所有站点都没有找到结果"——
       * 但后台任务抛异常时（比如 spider 初始化失败），用户看到的也是这句话，
       * 把"后端出错"误报成"没搜到"。
       */
      if (lastError) {
        error.value = groups.value.length
          ? `部分结果已返回，但搜索任务出错：${lastError}`
          : `搜索失败：${lastError}`
      } else if (!groups.value.length) {
        error.value = '所有站点都没有找到结果'
      }
    }
  } catch (e: any) {
    if (runId === runSeq) error.value = e?.message || String(e)
  } finally {
    if (runId === runSeq) {
      loading.value = false
      searchFinal.value = true
    }
  }
}

/**
 * 空闲态：没有关键词（路由里没有 wd）。
 *
 * <p>用户要求（2026-11-04）：搜索页分两个状态 ——
 *   · 空闲态：左栏热播榜 + 右栏最近搜索；
 *   · 搜索态：左栏站点筛选 + 右栏结果。
 * 进页面 / 清空关键词 / 在搜索态按返回 都回到空闲态。
 */
const idle = computed(() => !wd.value.trim())

/**
 * 热播榜的三个分类（豆瓣固定 id）。
 *
 * ★ 「电影」原来写的是 hot_gaia，豆瓣已下线这个集合（实测 2026-11-04 返回
 *   404 traversal_error）—— 那一栏一直是空的。换 movie_hot（热门电影，30 条）。
 */
const HOT_TABS = [
  { id: 'tv_hot', label: '剧集' },
  { id: 'movie_hot', label: '电影' },
  { id: 'show_hot', label: '综艺' },
] as const
const hotTab = ref<string>(HOT_TABS[0].id)
const hotItems = ref<Array<{ vod_id: string; vod_name: string; vod_remarks?: string }>>([])
const hotLoading = ref(false)

/**
 * 拉热播榜。
 *
 * <p>走豆瓣源的 category 接口（后端缓存 10 分钟），失败就静默留空 ——
 * 空闲态没有热播榜也能用（右边还有最近搜索），不该弹错误。
 */
async function loadHot() {
  hotLoading.value = true
  try {
    const r = await fetchCategory('Douban', hotTab.value, 1)
    hotItems.value = (r.list || []).slice(0, 20)
  } catch {
    hotItems.value = []
  } finally {
    hotLoading.value = false
  }
}

watch(hotTab, () => void loadHot())

/** 点热播榜条目 = 用这个片名发起搜索（进搜索态，让用户自己挑源） */
function searchByName(name: string) {
  keyword.value = name
  submit()
}

function submit() {
  const k = keyword.value.trim()
  if (!k) return
  router.push({ name: 'search', query: { wd: k } })
}

/**
 * TV：遥控器 ok 落在搜索框上时的输入处理。
 *
 * 分两种（判据见 nativeBridge.shouldUseNativeInput）：
 *   · 输入框会被输入法遮住（页面下半部）→ 弹原生对话框
 *   · 不会被遮（这个搜索框在页面上方）→ 就地聚焦 + 弹系统输入法，
 *     打完字按搜索/回车直接提交，不多一步确认
 *
 * 为什么要在这里判断而不是交给 tv-nav：标了 `data-tv-input-owner` 的元素
 * 由页面全权处理（tv-nav 只 click）。搜索框需要"打完字立刻提交"，
 * 而提交逻辑在页面里，所以判断也必须在页面里，用同一个公共判据保证一致。
 */
function onSearchClick(ev: MouseEvent) {
  const tv =
    typeof document !== 'undefined' &&
    (document.documentElement.dataset.tv === '1' || /MeowTV/i.test(navigator.userAgent))
  if (!tv) return
  if (!hasNativeInput()) return
  const el = ev.currentTarget as HTMLElement | null
  if (!shouldUseNativeInput(el)) {
    beginInlineInput(el)
    return
  }
  const v = nativeInputText('搜索影片', keyword.value, false)
  if (v == null) return
  keyword.value = v
  if (v.trim()) submit()
}

function openHit(h: Hit) {
  router.push({
    name: 'detail',
    params: { site: h.site, id: h.vod_id },
    query: h.vod_name ? { name: h.vod_name } : undefined,
  })
}

/*
 * ★ 必须写成 `() => run()`，不能直接传 `run`。
 * watch 的回调签名是 (newVal, oldVal)，直接传会把**新的搜索词字符串**
 * 当成 force 参数 —— 字符串是 truthy，于是每次输入都走强刷，
 * 缓存完全失效，每次搜索都要 30 秒。
 */
watch(wd, () => run(), { immediate: true })

/**
 * TV 返回键：搜索态 → 回空闲态（清关键词），空闲态 → 放行给壳退出。
 *
 * <p>用户要求（2026-11-04）：「搜索态按返回键只退到空闲态，再按一次才退出
 * 搜索页」。原来一按返回就整页退掉，用户想改个词得重新进来。
 */
function handleTvBackHere(): boolean {
  if (!idle.value) {
    keyword.value = ''
    void router.replace({ name: 'search' })
    return true
  }
  return false
}

onMounted(() => {
  void loadHot()
  /*
   * 进页面自动聚焦搜索框（2026-11-04 用户要求）。
   * 等一帧：input 是 v-model 绑定的，首帧才有稳定几何；
   * TV 上还要显式画 tv-nav 的焦点环（focus() 只移动 DOM 焦点）。
   */
  void nextTick(() => {
    const el = inputEl.value
    if (!el) return
    try {
      el.focus({ preventScroll: true })
    } catch {
      /* 老内核不支持 focus 选项 */
    }
    if (document.documentElement.dataset.tv === '1') {
      const w = window as unknown as { __meowTvFocus?: (t: Element, pin?: boolean) => boolean }
      if (typeof w.__meowTvFocus === 'function') w.__meowTvFocus(el, true)
    }
  })
  ;(window as unknown as { __meowTvPageBack?: () => boolean }).__meowTvPageBack =
    handleTvBackHere
  // App 的 watch(route.path) 早于本组件 onMounted，必须回头通知它重算接管者
  window.dispatchEvent(new Event('meow:tv-pageback'))
})

onBeforeUnmount(() => {
  const w = window as unknown as { __meowTvPageBack?: () => boolean }
  if (w.__meowTvPageBack === handleTvBackHere) w.__meowTvPageBack = undefined
  window.dispatchEvent(new Event('meow:tv-pageback'))
})
</script>

<template>
  <!--
    ★ md 以上把页面撑成「视口 − 顶栏」的定高 flex 列（2026-11-04 用户要求：
      左右两栏各自滚动、互不牵连）。

    原来整页跟着 window 滚，右侧结果一长，左侧源栏就被一起推走；
    左栏虽然写了 md:sticky，但 tv-unstick 在 TV 上把它摘掉了（tv-nav 把
    sticky 祖先当钉住层，左右键进不去），于是 TV 上两侧完全同步滚动。

    定高 + flex-1 + min-h-0 之后：结果区吃掉剩余高度，两栏各滚各的，
    页面本身不再滚（body 高度 = 视口）。移动端保持原来的自然滚动。
  -->
  <div class="mx-auto max-w-[1500px] px-6 py-6 max-sm:px-3 max-sm:py-4 md:flex md:h-[calc(100vh-var(--header-h))] md:flex-col md:overflow-hidden">
    <!-- 搜索框 -->
    <!--
      手机：搜索框这一栏吸顶（与首页分类胶囊、设置页分区胶囊同一套）。

      ★ 只给 max-sm：TV 的 tv-nav 把 sticky 祖先当钉住层，左右键会进不去结果区。
      ★ 满宽用 `-mx-3` 抵消页面 `max-sm:px-3`；底色与顶栏同一层玻璃，
        滚动时读起来是"顶栏下面多了一条搜索条"。
    -->
    <form
      class="mx-auto flex max-w-2xl items-center gap-2 max-sm:sticky max-sm:top-[var(--header-h)] max-sm:z-20 max-sm:-mx-3 max-sm:max-w-none max-sm:border-b max-sm:border-line/60 max-sm:bg-[var(--color-header-veil)] max-sm:px-3 max-sm:py-2 max-sm:backdrop-blur-xl"
      @submit.prevent="submit"
    >
      <div class="relative flex-1">
        <svg
          class="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref="inputEl"
          v-model="keyword"
          type="search"
          placeholder="输入片名，回车搜索"
          data-tv-input-owner
          class="h-12 w-full rounded-full border border-line bg-surface pl-11 pr-4 text-[15px] outline-none transition placeholder:text-ink-3 focus:border-accent/50"
          @click="onSearchClick"
          @keyup.enter="submit"
        />
      </div>
      <button
        type="submit"
        class="h-12 shrink-0 rounded-full bg-accent px-7 text-sm font-semibold text-on-accent transition hover:bg-accent-dim"
      >
        搜索
      </button>
    </form>


    <!--
      空闲态（2026-11-04 用户要求）：左栏热播榜、右栏最近搜索。
      进页面 / 清空关键词 / 搜索态按返回 都会回到这里。
    -->
    <div v-if="idle" class="mt-5 flex min-h-0 flex-1 flex-col gap-5 max-sm:mt-4 md:flex-row">
      <!-- 左栏：热播榜（固定 240px，与搜索态的站点栏同宽） -->
      <!--
      手机：热播榜排在最近搜索**之后**（用户反馈「搜索历史沉底」）。
      原来是 flex-col 里热播榜带 flex-1，把右栏的最近搜索推到屏幕外；
      md 以上仍是左榜右历史，不受影响。
    -->
      <aside class="max-sm:order-last md:w-[15rem] md:shrink-0 md:min-h-0 md:flex md:flex-col">
        <div class="mb-2 flex shrink-0 items-center gap-1.5">
          <button
            v-for="t in HOT_TABS"
            :key="t.id"
            class="rounded-full px-3 py-1 text-xs transition"
            :class="
              hotTab === t.id
                ? 'bg-accent font-medium text-on-accent'
                : 'bg-card text-ink-2 hover:bg-card-hover hover:text-ink'
            "
            @click="hotTab = t.id"
          >
            {{ t.label }}
          </button>
          <span class="ml-auto text-[11px] text-ink-3">热播榜</span>
        </div>
        <!--
          ★ 不要再标 data-tv-scroll / tabindex（2026-11-04 用户报「热搜榜单聚焦
            有误，并显示不全」）：标了之后这个容器本身成了焦点停靠点，tv-nav
            给它画的是"可滚区域"那根左侧竖条，而不是某一行的焦点框 ——
            用户看到的是"整列被一根竖线框住，不知道选中了哪一部"，
            而且上下键在这里是滚容器、不是逐行移动。
          行本身就可聚焦，滚动交给 scrollIntoView 跟着焦点走即可。
          p-1 给焦点环留空间：环画在行外面，容器 overflow 会把它裁掉。
        -->
        <div class="no-scrollbar min-h-0 flex-1 overflow-y-auto rounded-lg p-1">
          <button
            v-for="(h, i) in hotItems"
            :key="h.vod_id"
            class="flex h-10 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-ink-2 transition hover:bg-card-hover hover:text-ink"
            :title="h.vod_name"
            @click="searchByName(h.vod_name)"
          >
            <span class="w-5 shrink-0 text-right font-mono text-[11px] text-ink-3">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1 truncate">{{ h.vod_name }}</span>
            <span class="shrink-0 text-[10px] text-ink-3">{{ h.vod_remarks || '' }}</span>
          </button>
          <p v-if="!hotItems.length" class="py-6 text-center text-xs text-ink-3">
            {{ hotLoading ? '加载中…' : '热播榜暂时拿不到' }}
          </p>
        </div>
      </aside>

      <!-- 右栏：最近搜索（大胶囊，最多 12 个） -->
      <div class="min-w-0 flex-1 max-sm:order-first md:min-h-0 md:overflow-y-auto">
        <div class="mb-2 flex items-center gap-2">
          <h2 class="text-sm font-medium text-ink-2">最近搜索</h2>
          <button
            v-if="history.length"
            class="ml-auto text-[11px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
            @click="clearSearchHistory(); refreshHistory()"
          >
            清空
          </button>
        </div>
        <div v-if="history.length" class="flex flex-wrap gap-2">
          <button
            v-for="h in history.slice(0, 12)"
            :key="h"
            class="group/chip flex items-center gap-1.5 rounded-full bg-card px-4 py-2.5 text-[15px] text-ink-2 transition hover:bg-card-hover hover:text-ink"
            @click="searchByName(h)"
          >
            {{ h }}
            <span
              class="text-[11px] opacity-0 transition group-hover/chip:opacity-60 hover:!opacity-100"
              @click.stop="removeSearchHistory(h); refreshHistory()"
            >
              ✕
            </span>
          </button>
        </div>
        <p v-else class="mt-6 max-w-md text-xs leading-relaxed text-ink-3">
          还没有搜索记录。输入片名开始搜索，或从热播榜里挑一个。
        </p>
      </div>
    </div>

    <!-- 搜索态：左栏站点筛选、右栏结果 -->
    <template v-else>
    <!-- 范围 -->
    <div class="mt-5 flex items-center justify-center gap-2 text-sm">
      <button
        class="rounded-full px-3.5 py-1.5 transition"
        :class="scope === 'all' ? 'bg-card-hover text-ink' : 'text-ink-3 hover:text-ink-2'"
        @click="scope = 'all'; run()"
      >
        全部站点
      </button>
      <button
        class="rounded-full px-3.5 py-1.5 transition"
        :class="scope === 'current' ? 'bg-card-hover text-ink' : 'text-ink-3 hover:text-ink-2'"
        @click="scope = 'current'; run()"
      >
        仅当前站点
      </button>
    </div>

    <!-- 状态 -->
    <div v-if="loading" class="mt-12 text-center text-sm text-ink-3">
      搜索中…
      <span v-if="searchProgress.total" class="ml-1 tabular-nums text-ink-3">
        {{ searchProgress.returned }}/{{ searchProgress.total }} 个源
      </span>
    </div>

    <div v-else-if="error && !list.length && !groups.length" class="mt-16 text-center">
      <div class="text-3xl opacity-40">🔍</div>
      <p class="mt-3 text-sm text-ink-2">{{ error }}</p>
    </div>

    <!-- 聚合结果：每个源一张卡片 -->
    <div
      v-else-if="hits.length"
      class="mt-6 flex flex-col gap-3 md:mt-4 md:min-h-0 md:flex-1 md:flex-row md:gap-5"
    >
      <!-- 源筛选：桌面在左侧竖排；手机上变结果上方的横向胶囊，
           否则 375px 屏会被 152px 的侧栏吃掉四成宽度 -->
      <aside v-if="siteTabs.length > 1" class="md:w-[15rem] md:shrink-0">
        <p class="mb-2 hidden text-[11px] text-ink-3 md:block">
          搜索({{ visibleHits.length }}/{{ hits.length }})
        </p>
        <!--
          ★ tv-unstick：TV 上必须把 md:sticky 去掉（2026-11-04，用户报
            「搜索页左右键无法聚焦到左侧源列表」）。

          tv-nav 的 pinned() 把**任何 position:sticky 祖先**都当成"钉住层"，
          并对它套用顶栏那套一维规则：
            · 焦点在海报上按 ←：钉住层候选被 skipPinned 跳过 → 永远进不去；
            · 焦点在源列表上按 →：只在钉住层内部找，到头就 return false。
          两头都断，源列表在遥控器上完全不可达。
          TV 上不需要侧栏吸附（视口高度固定、列表也不长），直接取消 sticky。
        -->
        <!--
          左右两栏各自滚动（2026-11-04 用户要求：「左侧源列表不要跟随右侧
          搜索结果区域滚动，两侧滚动要分离」）。

          ★ 原来是 md:sticky + 整页滚：左栏跟着页面一起走，右侧结果一长，
            左栏就被一起推上去。TV 上还有 tv-unstick 把 sticky 摘掉（因为
            tv-nav 把 sticky 祖先当"钉住层"，左右键会进不去），于是更明显。

          ★ md:p-2.5 不是装饰：焦点环是 3px + 9px 光晕（画在元素外面），
            容器 overflow 会把它们裁掉一半 —— 用户截图里"左边框显示不全"
            就是这个。留 10px 内边距，环能完整画出来。
        -->
        <div
          class="tv-unstick no-scrollbar flex gap-1.5 overflow-x-auto pb-1 md:h-full md:min-h-0 md:flex-col md:gap-1 md:overflow-x-hidden md:overflow-y-auto md:p-2.5"
        >
          <button
            class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-left text-[12px] transition md:rounded-lg md:px-2.5 md:py-2 md:text-[13px]"
            :class="
              siteFilter === null
                ? 'bg-accent font-medium text-on-accent'
                : 'bg-card text-ink-2 hover:bg-card-hover hover:text-ink'
            "
            @click="siteFilter = null"
          >
            <span class="truncate">全部</span>
            <span class="shrink-0 text-[11px] opacity-70 md:ml-auto">{{ hits.length }}</span>
          </button>
          <button
            v-for="t in siteTabs"
            :key="t.key"
            class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-left text-[12px] transition md:rounded-lg md:px-2.5 md:py-2 md:text-[13px]"
            :class="
              siteFilter === t.key
                ? 'bg-accent font-medium text-on-accent'
                : 'bg-card text-ink-2 hover:bg-card-hover hover:text-ink'
            "
            :title="t.name"
            @click="siteFilter = t.key"
          >
            <span class="truncate">{{ t.name }}</span>
            <span class="shrink-0 text-[11px] opacity-70 md:ml-auto">{{ t.count }}</span>
          </button>
        </div>
      </aside>

      <div class="min-w-0 flex-1 md:h-full md:min-h-0 md:overflow-y-auto md:p-2.5">
        <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 md:mb-4">
          <p class="text-xs text-ink-3">
            找到 {{ visibleHits.length }} 条结果<template
              v-if="!searchFinal && searchProgress.total && searchProgress.returned < searchProgress.total"
            >
              <span class="ml-1.5 font-normal text-ink-3 tabular-nums">
                （{{ searchProgress.returned }}/{{ searchProgress.total }} 个源已返回）
              </span></template
            ><template v-if="siteFilter">
              （仅 {{ siteTabs.find((t) => t.key === siteFilter)?.name }}）</template
            ><template v-if="noiseFiltered">
              <span
                class="ml-1.5 text-warn/80"
                title="设置 → 搜索与源 → 噪音过滤。想看到这些结果就把模式改成「仅排序降级」或清空词表。"
              >
                · 已滤掉 {{ noiseFiltered }} 条噪音
              </span></template
            ><template v-if="noiseDowngraded">
              <span
                class="ml-1.5 text-ink-3"
                title="这些条目排在最后了，往下翻能看到"
              >
                · {{ noiseDowngraded }} 条噪音已沉底
              </span></template
            >
          </p>
          <!--
            重新搜索（强刷）：绕过后端结果缓存。
            没有它的话同词再搜是毫秒级返回同一份缓存，用户点多少次都看不到新东西。
            disabled 时不给点：搜索进行中再点只会让后端 epoch 作废上一轮，白等一次。
          -->
          <button
            v-if="!loading"
            class="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-3 transition hover:bg-elevated hover:text-ink-1"
            :title="'绕过缓存，重新搜索全部源（约 10~30 秒）'"
            @click="run(true)"
          >
            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-3-6.7M21 3v6h-6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            重新搜索
          </button>
        </div>

        <!-- 缩略图视图 -->
        <div v-if="layout === 'grid'" class="poster-grid" :style="colsStyle(groupCols)">
          <button
            v-for="h in visibleHits"
            :key="h.key"
            class="group rounded-lg text-left"
            :title="`${h.vod_name} · ${h.site_name}`"
            @click="openHit(h)"
          >
            <div class="relative aspect-[2/3] overflow-hidden rounded-lg bg-elevated">
              <PosterImage :src="h.vod_pic" :alt="h.vod_name" img-class="transition duration-300 group-hover:scale-105" />
              <!-- 源标记：每张卡片只代表一个源，点进去就是那个源的线路 -->
              <span
                class="absolute left-1.5 top-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-accent backdrop-blur"
              >
                {{ h.site_name }}
              </span>
              <!-- 备注角标（24集全之类） -->
              <span
                v-if="h.vod_remarks"
                class="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/85"
              >
                {{ h.vod_remarks }}
              </span>
              <div class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/80 to-transparent" />
            </div>
            <p class="poster-title mt-2 truncate font-medium group-hover:text-accent">
              {{ h.vod_name }}
            </p>
            <p class="mt-0.5 truncate text-[11px] text-ink-3">{{ h.site_name }}</p>
          </button>
        </div>

        <!-- 列表视图 -->
        <div v-else class="space-y-2">
          <button
            v-for="h in visibleHits"
            :key="h.key"
            class="flex w-full items-center gap-4 rounded-lg border border-line bg-surface p-3 text-left transition hover:border-accent/30 hover:bg-elevated"
            @click="openHit(h)"
          >
            <div class="h-20 w-14 shrink-0 overflow-hidden rounded bg-elevated">
              <PosterImage :src="h.vod_pic" :alt="h.vod_name" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ h.vod_name }}</div>
              <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span class="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                  {{ h.site_name }}
                </span>
                <span v-if="h.vod_remarks" class="text-[11px] text-ink-3">{{ h.vod_remarks }}</span>
              </div>
            </div>
            <svg class="h-4 w-4 shrink-0 text-ink-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 单站结果 -->
    <div v-else-if="list.length" class="poster-grid mt-8" :style="colsStyle(listCols)">
      <PosterCard v-for="item in list" :key="item.vod_id" :item="item" :site="store.current" />
    </div>
    </template>
  </div>
</template>
