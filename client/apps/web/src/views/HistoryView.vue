<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { clearHistory, listHistory, pushHistory, removeHistory, type HistoryItem } from '@/stores/history'
import PosterImage from '@/components/common/PosterImage.vue'
import { fetchDetail } from '@/api'
import { dailySeries, fmtDuration, overview, summary } from '@/stores/watchStats'
import type { StatsOverview } from '@/stores/watchStats'
import WatchStatsPanel from '@/components/common/WatchStatsPanel.vue'
import { registerTvMenuHandler } from '@/stores/tvMenu'
import { useReturnRestore } from '@/composables/useReturnRestore'
import { groupByDay } from '@/utils/historyGroup'

// 返回上一页时恢复滚动位置与焦点（TV 上从详情返回不该跳回顶部）
useReturnRestore('history')

const router = useRouter()
const items = ref<HistoryItem[]>(listHistory())

const isEmpty = computed(() => items.value.length === 0)

/**
 * 补封面：给缺图的老记录回源站查一次 detail。
 *
 * <p><b>为什么必须补</b>：历史记录里的 `vod_pic` 是写历史那一刻从 URL 或
 * 搜索结果里拿的。从历史页/搜索页直达播放时 URL 不带封面，写入的就是空；
 * 而那些记录**永远不会自己变好** —— 用户看到的就是一排胶片占位图
 * （实测本机 10 条全空）。
 *
 * <p>只补缺图的，并发限 3：历史最多 10 条，一次进来打 10 个 detail
 * 在 TV 上会把首屏拖慢，而且部分源 detail 要 2-3 秒。
 * 补到之后立刻写回 localStorage，下次进页面不用再查。
 */
const POSTER_GAP = 260
async function fillMissingPosters() {
  const todo = items.value.filter((it) => !it.vod_pic && it.site && it.vod_id
    // 冒烟/测试写入的假站点，回源只会 404
    && !it.site.startsWith('__'))
  if (!todo.length) return
  let i = 0
  const worker = async () => {
    while (i < todo.length) {
      const it = todo[i++]
      try {
        const r = await fetchDetail(it.site, it.vod_id)
        const v = r.list?.[0]
        if (!v) continue
        const pic = typeof v.vod_pic === 'string' ? v.vod_pic.trim() : ''
        const nm = typeof v.vod_name === 'string' ? v.vod_name.trim() : ''
        // 一个都没补到就别写，避免把"源站也没图"变成反复回源
        if (!pic && !nm) continue
        pushHistory({
          site: it.site,
          siteName: it.siteName,
          vod_id: it.vod_id,
          // 空值不覆盖（见 mergeInto），所以这里只传真实拿到的
          ...(pic ? { vod_pic: pic } : {}),
          // 片名是纯数字 id 时说明当初也没拿到，一并补上
          ...(nm && /^\d+$/.test(it.vod_name || '') ? { vod_name: nm } : {}),
          ...(v.vod_remarks ? { vod_remarks: v.vod_remarks } : {}),
          at: it.at,
        }, { notify: false })
      } catch {
        /* 源站限流/超时都跳过，下次进页面再试 */
      }
      // 轻微间隔：这些请求打的是同一个源站，连发容易 429
      await new Promise((r) => setTimeout(r, POSTER_GAP))
    }
  }
  await Promise.all([worker(), worker(), worker()])
  // 写回后重新读，触发海报显示
  items.value = listHistory()
}

// 每次进入本页都重读一次：统计数据会被播放页改动
onMounted(() => {
  refreshStats()
  // 缺图的老记录回源补一次（异步，不挡住首屏渲染）
  void fillMissingPosters()
})

// ---------------------------------------------------------------- 观看统计
//
// 时长由播放页按"播放器实际推进的秒数"累加（不是 pos 差值，拖动会跳变）。
// 这里只负责展示。
const stats = ref(summary())

// ---------------------------------------------------------------- 统计面板
//
// 卡片只留 4 个关键数字 + 近 7 天小柱，完整图表收进弹框（见 WatchStatsPanel）。
// 用户原话：「时长保留的情况下，额外单独统计按钮，打开统计面板」。
const statsOpen = ref(false)

/**
 * 打开面板：先重置内部滚动到顶部。
 *
 * 踩过（实测）：面板是 `v-if`，但里面的滚动容器 DOM 会被 Vue 复用 ——
 * 上次滚到底，再打开时直接停在底部，"指标卡"那一排看不见，
 * 用户会以为面板坏了。所以每次打开都显式归零。
 */
async function openStats() {
  statsOpen.value = true
  await nextTick()
  const box = document.querySelector(
    '[data-tv-scope] [data-tv-scroll]',
  ) as HTMLElement | null
  if (box) box.scrollTop = 0
}
const ov = ref<StatsOverview>(overview())
/**
 * 热力图用全年（53 周），趋势图用近 30 天。
 *
 * 两个窗口不同是有意的：热力图看"一年里哪段时间看得多"（需要长跨度），
 * 趋势线看"最近的变化"（30 个点以上在 720px 宽的图里会糊成一片）。
 */
const series = ref(dailySeries(371))
const trendSeries = ref(dailySeries(30))
const bySite = ref<Array<{ name: string; seconds: number }>>([])

/**
 * 按站点聚合观看时长。
 *
 * <p><b>为什么按"历史条数"分摊而不是精确时长</b>：`watchStats` 只存了
 * "每天看了多久"，没存"每个站点看了多久"；历史项里有 `at`（最后打开时间）
 * 和 `dur`（该集总时长），但没有"实际看了多少"。
 *
 * <p>所以这里用**可解释的近似**：每个站点的权重 = 该站点影片数 × 平均进度。
 * 进度取 `pos / dur`（看到哪儿了），没有 `dur` 的按 50% 估。这个值只在
 * 面板里展示占比，不影响任何实际数字，近似误差可以接受；
 * 如果要精确，得在 `watchStats` 里再加一张"按站点"的表 —— 那会让
 * localStorage 体积翻倍，而收益只是一个图表的精度。
 */
function siteBreakdown(): Array<{ name: string; seconds: number }> {
  const total = ov.value.month || stats.value.total
  if (!total || !items.value.length) return []
  const weight = new Map<string, number>()
  for (const it of items.value) {
    const dur = Number(it.dur) || 0
    const pos = Number(it.pos) || 0
    // 看到哪儿了；dur 未知时按一半估
    const ratio = dur > 0 ? Math.min(1, Math.max(0.05, pos / dur)) : 0.5
    const name = it.siteName || it.site || '未知'
    weight.set(name, (weight.get(name) || 0) + ratio)
  }
  const sum = [...weight.values()].reduce((a, b) => a + b, 0)
  if (!sum) return []
  return [...weight.entries()]
    .map(([name, w]) => ({ name, seconds: Math.round((w / sum) * total) }))
    .filter((x) => x.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
}

/**
 * 重算全部统计。
 *
 * <p>定义在所有 ref / 依赖函数之后：`refreshStats` 会调用 `siteBreakdown`，
 * 而那是 `const` 箭头函数（不变量提升）。放在前面调用会落进 TDZ。
 */
function refreshStats() {
  stats.value = summary()
  ov.value = overview()
  series.value = dailySeries(371)
  trendSeries.value = dailySeries(30)
  bySite.value = siteBreakdown()
}

/** Escape 关面板（App.vue 的返回键就是靠派发 Escape 让组件自己关的） */
function onStatsKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && statsOpen.value) statsOpen.value = false
}

/**
 * 关闭面板 → 把焦点还给「统计」按钮。
 *
 * 遥控器按 OK 打开时 tv-nav 会自己记住打开者；但鼠标/脚本点击不经过
 * enter()，需要显式给锚点（站点明细弹框踩过这个坑，docs/49 第五轮）。
 */
function closeStats() {
  statsOpen.value = false
  const w = window as unknown as {
    __meowTvScopeClosed?: (fallbackSelector?: string) => boolean
  }
  if (typeof w.__meowTvScopeClosed === 'function') {
    w.__meowTvScopeClosed('[data-tv-key="history-stats"]')
  }
}

refreshStats()
if (typeof window !== 'undefined') {
  // 两个刷新时机：
  //  1) 播放页累加时长时发的自定义事件（同一标签页内实时更新）
  //  2) 组件重新挂载（从播放页返回历史页——这时组件可能被缓存复用，
  //     不刷新就会显示上次的数字）
  window.addEventListener('meow:watch-stats', refreshStats)
}

/**
 * 按天分组（小标题文案见 utils/historyGroup）。
 *
 * <p>随 items 变化重算：补封面会把新数据写回 localStorage 再刷新 items，
 * 那时分组也要跟着更新。
 */
const groups = computed(() => groupByDay(items.value))

/**
 * 每张卡片右下角的时间。
 *
 * <p>日期已经在分组小标题里了，这里**只给时分**——原来那行是
 * 「2026-11-03 10:12」，和上面的「今天 · 11月3日」重复说了两遍日期，
 * 一行里塞两个时间点反而更难扫。
 */
function fmtTime(at: number): string {
  const d = new Date(at)
  const now = Date.now()
  const diff = now - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function open(it: HistoryItem) {
  // 有播放进度就直达播放页，否则回详情页挑线路
  if (it.ep_url && it.flag) {
    router.push({
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
  router.push({
    name: 'detail',
    params: { site: it.site, id: it.vod_id },
    query: it.vod_name ? { name: it.vod_name } : undefined,
  })
}

/** 打开详情页（次级入口，不进播放页） */
function openDetail(it: HistoryItem, ev: Event) {
  ev.stopPropagation()
  router.push({
    name: 'detail',
    params: { site: it.site, id: it.vod_id },
    query: it.vod_name ? { name: it.vod_name } : undefined,
  })
}

/** 进度百分比，0 表示没有进度 */
function pct(it: HistoryItem): number {
  if (typeof it.pos !== 'number' || !it.dur || it.dur <= 0) return 0
  return Math.max(0, Math.min(100, (it.pos / it.dur) * 100))
}

/** 「第3集 · 看到 23:41」 */
function progressText(it: HistoryItem): string {
  if (typeof it.pos !== 'number' || it.pos < 1) return ''
  const part = it.ep ? `${it.ep} · ` : ''
  return `${part}看到 ${clock(it.pos)}`
}

function clock(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`
}

async function drop(it: HistoryItem, ev: Event) {
  ev.stopPropagation()
  /*
   * 删除一律要确认。
   *
   * <p>2026-11-12 之前按 `(hover: none)` 分档（触屏才确认，鼠标不确认），
   * 实测翻车：同样的设备/同样的点法，有时弹框有时直接删 —— 媒体查询反映的是
   * **主指针设备**，模拟器/带鼠标的盒子/遥控器都可能让它翻转，不能拿它当
   * "这次是不是手指点的"的判据。删除是不可恢复操作，统一确认。
   */
  if (!(await confirmDialog(`从历史中移除《${it.vod_name || '这条记录'}》？`, { danger: true })))
    return
  removeHistory(it.site, it.vod_id)
  items.value = listHistory()
}

async function clearAll() {
  if (!(await confirmDialog('清空全部观看历史？', { danger: true }))) return
  clearHistory()
  items.value = []
}

/**
 * 远端进度同步完成后刷新列表（冷启动竞态）。
 *
 * <p>远端是 `main.ts` 启动后异步拉的，通常晚于本页 `onMounted` 里的
 * `listHistory()`。不监听的话，页面会停在「还没有观看记录」——
 * 而 localStorage 里其实已经有数据（实测 OECT：10 条记录、页面空白）。
 *
 * <p>用独立事件名，不走 `meow:history-changed`（那个会把这次合并再推回后端）。
 */
function onRemoteSynced() {
  items.value = listHistory()
  refreshStats()
}

/**
 * 遥控器菜单键：卡片上的「移除 / 详情」是 hover 才出现的，电视够不到。
 * 焦点元素靠 `data-hist-key` 映射回数据，不用下标（列表会收缩）。
 */
let offMenu: (() => void) | undefined
onMounted(() => {
  offMenu = registerTvMenuHandler((focused) => {
    const li = focused?.closest?.('[data-hist-key]') as HTMLElement | null
    if (!li) return null
    const it = items.value.find((x) => `${x.site}|${x.vod_id}` === li.dataset.histKey)
    if (!it) return null
    const canResume = !!(it.ep_url && it.flag)
    return {
      title: it.vod_name,
      actions: [
        // ★ 没有播放记录（只有浏览痕迹）时不重复给「打开详情」。
        //   实测投影仪截图：第一条和第二条都叫「打开详情」，用户没法分辨。
        ...(canResume
          ? [{ label: '继续播放', hint: it.ep ? `${it.ep} · ${clock(it.pos ?? 0)}` : '接着上次', run: () => open(it) }]
          : []),
        {
          label: '打开详情',
          hint: '换线路 / 选集',
          run: () => router.push({ name: 'detail', params: { site: it.site, id: it.vod_id } }),
        },
        {
          label: '从历史中移除',
          run: () => {
            removeHistory(it.site, it.vod_id)
            items.value = listHistory()
          },
        },
      ],
    }
  })
  // Escape 关统计面板：App.vue 的返回键就是靠派发 Escape 让组件自己关
  document.addEventListener('keydown', onStatsKey)
  // 远端进度晚到 → 刷新列表（见 onRemoteSynced 的注释）
  window.addEventListener('meow:history-synced', onRemoteSynced)
})
onBeforeUnmount(() => {
  offMenu?.()
  document.removeEventListener('keydown', onStatsKey)
  window.removeEventListener('meow:history-synced', onRemoteSynced)
})
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-6 py-8 max-sm:px-3 max-sm:py-5">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold max-sm:text-lg">观看历史</h1>
        <p class="mt-1 text-xs text-ink-3 max-sm:mt-0.5 max-sm:text-[11px]">
          本地保存最近 {{ items.length }} 条 · 点封面继续播放 · 右上角可移除
        </p>
      </div>
      <button
        v-if="!isEmpty"
        class="ml-auto shrink-0 whitespace-nowrap rounded-md bg-card px-3 py-1.5 text-xs text-ink-2 transition hover:bg-hot/15 hover:text-hot max-sm:px-3.5 max-sm:py-2"
        @click="clearAll"
      >
        清空
      </button>
    </div>

    <!--
      观看统计：历史页原来只有流水，看不出"看了多少"。

      ★ 显示条件用「有总时长 **或** 有历史」。
      踩过（用户反馈「没见统计按钮啊」，2026-10-30）：条件原来是
      `stats.total > 0`，可只要统计一直是 0（新装、清过缓存、或旧版本
      播过的片没累加过时长），整张卡连「统计」按钮一起消失 ——
      用户有 14 条历史却找不到入口。
      时长是"锦上添花"，入口才是主路径：宁可显示一排 0，
      也要让用户能点进去看（面板里会提示"还没有累计时长"）。
    -->
    <div
      v-if="stats.total > 0 || items.length > 0"
      class="mt-5 rounded-xl border border-line bg-card px-4 py-3.5 max-sm:mt-4 max-sm:px-3.5 max-sm:py-3"
    >
      <div
        class="flex flex-wrap items-baseline gap-x-6 gap-y-2 max-sm:grid max-sm:grid-cols-4 max-sm:gap-x-3 max-sm:gap-y-2"
      >
        <div>
          <div class="text-[11px] text-ink-3">今天</div>
          <div class="text-lg font-semibold text-ink max-sm:text-[15px]">{{ fmtDuration(stats.today) }}</div>
        </div>
        <div>
          <div class="text-[11px] text-ink-3">近 7 天</div>
          <div class="text-lg font-semibold text-ink max-sm:text-[15px]">{{ fmtDuration(stats.week) }}</div>
        </div>
        <div>
          <div class="text-[11px] text-ink-3">总计</div>
          <div class="text-lg font-semibold text-ink max-sm:text-[15px]">{{ fmtDuration(stats.total) }}</div>
        </div>
        <div>
          <div class="text-[11px] text-ink-3">有记录</div>
          <div class="text-lg font-semibold text-ink max-sm:text-[15px]">{{ stats.days }} 天</div>
        </div>

        <!--
          ★ 卡片里不要放近 7 天柱状图（用户要求「图片红框内容去除」）。

          踩过（2026-10-30 截图）：那里原本是一排柱子 + 7 个日期标签。
          零数据时 7 个柱子高度全是 0，只剩一排光秃秃的「10-24 … 10-30」，
          占掉卡片右半边却什么信息都没有 —— 纯噪音。
          而真要看逐日曲线，弹框里的趋势图（30 天、带面积）比这排小柱
          信息量大得多，重复且更差。

          所以卡片只保留 4 个关键数字（时长），完整图表全部收进弹框。
        -->
        <button
          data-tv-key="history-stats"
          class="ml-auto shrink-0 self-center rounded-md bg-card px-3 py-1.5 text-[11px] text-ink-2 transition hover:bg-card-hover hover:text-ink max-sm:col-span-4 max-sm:ml-0 max-sm:w-full max-sm:py-1.5 max-sm:text-[11px]"
          @click="openStats()"
        >
          统计 ›
        </button>
      </div>
    </div>

    <WatchStatsPanel
      :open="statsOpen"
      :overview="ov"
      :series="series"
      :trend-series="trendSeries"
      :by-site="bySite"
      :titles="items.length"
      @close="closeStats()"
    />

    <div v-if="isEmpty" class="py-24 text-center max-sm:py-16">
      <div class="text-3xl opacity-40">🕘</div>
      <p class="mt-3 text-sm text-ink-2">还没有观看记录</p>
      <p class="mt-1 text-xs text-ink-3">在首页点开任意影片就会记在这里</p>
      <RouterLink
        to="/"
        class="mt-5 inline-block rounded-md bg-card px-4 py-2 text-sm hover:bg-card-hover"
      >
        回首页
      </RouterLink>
    </div>

    <!--
      按「天」分组（2026-11-03 用户要求「按每日观看拆分加日期小标题」）。

      ★ 逐日小标题而不是一条时间轴细线：历史最多几十条、跨几天到几周，
        细线在中段全是空白，反而看不出分段；小标题本身就够区分。
      ★ 组内保持 listHistory 的顺序（at 倒序 = 最近打开的在最前）。
    -->
    <div v-else class="mt-6 space-y-8 max-sm:mt-5 max-sm:space-y-6">
      <section v-for="g in groups" :key="g.key" :data-day="g.key">
        <h2 class="flex items-baseline gap-2">
          <span class="text-[15px] font-semibold text-ink">{{ g.label }}</span>
          <span class="text-[11px] text-ink-3">{{ g.items.length }} 部</span>
        </h2>
        <ul class="mt-3 grid grid-cols-3 gap-x-4 gap-y-6 max-sm:mt-2.5 max-sm:gap-x-2.5 max-sm:gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      <li
        v-for="it in g.items"
        :key="`${it.site}|${it.vod_id}`"
        :data-hist-key="`${it.site}|${it.vod_id}`"
        class="group cursor-pointer rounded-lg outline-none"
        tabindex="0"
        role="button"
        :aria-label="`${it.vod_name} ${progressText(it) || ''}`"
        @click="open(it)"
        @keydown.enter.prevent="open(it)"
      >
        <div class="relative overflow-hidden rounded-lg bg-elevated aspect-[2/3]">
          <PosterImage
            :src="it.vod_pic"
            :alt="it.vod_name"
            img-class="transition duration-300 group-hover:scale-105"
          />
          <div
            class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition group-hover:opacity-100"
          />
          <!--
            封面上的浮层（移除 / 集数徽标 / 详情）压的是**海报画面**，
            文字必须固定白色系：`text-ink-2` 在浅色主题下是深灰
            （#4a5262），压在半透明黑底上等于看不见（2026-11-12 实测）。
          -->
          <button
            class="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white/80 opacity-0 transition hover:bg-hot/80 hover:text-on-hot group-hover:opacity-100 max-sm:h-10 max-sm:w-10 max-sm:bg-black/55 max-sm:opacity-100"
            tabindex="-1"
            title="从历史中移除"
            @click="drop(it, $event)"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <span
            v-if="it.vod_remarks"
            class="poster-badge"
            :class="isScoreRemarks(it.vod_remarks) ? 'poster-badge--score poster-badge--after-action' : ''"
          >
            {{ it.vod_remarks }}
          </span>
          <!-- 详情次级入口：想换线路/跳集而不续播时用 -->
          <button
            class="absolute bottom-1.5 right-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white/80 opacity-0 transition hover:bg-black/85 hover:text-white group-hover:opacity-100 max-sm:hidden"
            tabindex="-1"
            title="打开详情（换线路 / 选集）"
            @click="openDetail(it, $event)"
          >
            详情
          </button>
          <!-- 进度条：贴在封面底部 -->
          <div v-if="pct(it) > 0" class="absolute inset-x-0 bottom-0 h-[3px] bg-card-hover">
            <div class="h-full bg-player" :style="{ width: pct(it) + '%' }" />
          </div>
        </div>
        <!-- 标题行右侧放「详情」：手机没有 hover，封面上的按钮会压住海报；
             放这里时信息行（源 · 时间）就能占满整行，不被按钮挤成省略号 -->
        <p class="mt-2 flex items-center gap-1 max-sm:mt-1.5">
          <span class="min-w-0 flex-1 truncate text-[13px] text-ink max-sm:text-[12px]">
            {{ it.vod_name }}
          </span>
          <button
            class="hit-44 shrink-0 rounded px-2 py-1.5 text-[11px] text-ink-3 active:text-accent sm:hidden"
            title="打开详情（换线路 / 选集）"
            @click="openDetail(it, $event)"
          >
            详情 ›
          </button>
        </p>
        <p v-if="progressText(it)" class="mt-0.5 truncate text-[11px] text-player max-sm:text-[10px]">
          {{ progressText(it) }}
        </p>
        <!-- 日期已经在分组标题里了，这里只留时间，避免同一行重复说两遍日期 -->
        <p class="mt-0.5 truncate text-[11px] text-ink-3 max-sm:text-[10px]">
          {{ it.siteName }} · {{ fmtTime(it.at) }}
        </p>
      </li>
        </ul>
      </section>
    </div>
  </div>
</template>
