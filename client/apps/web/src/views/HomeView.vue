<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchCategory, fetchHome } from '@/api'
import type { HomeClass, HomeResult, VodItem } from '@/api/types'
import PosterCard from '@/components/common/PosterCard.vue'
import { colsStyle, useCardCols } from '@/composables/useCardCols'
import { useAppStore } from '@/stores/app'
import { pushHistory } from '@/stores/history'
import { useReturnRestore } from '@/composables/useReturnRestore'

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

/**
 * 列数按可用宽度算，设置页的 homeCols 只是上限（见 useCardCols）。
 * 手机竖屏 3 列、电视 8 列都由同一套规则得出，不再靠视口断点切档。
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

async function loadHome() {
  if (!site.value) return
  loading.value = true
  error.value = ''
  try {
    const h = await fetchHome(site.value)
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
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
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
    error.value = e?.message || String(e)
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
    error.value = e?.message || String(e)
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
 * 聚焦的胶囊居中（2026-11-06 用户报：右键后靠右的胶囊聚焦会出界）。
 *
 * <p>★ 用 focusin 不用 watch(activeTid)：遥控器右键只是**移动焦点**，
 * 没有点选，activeTid 不变 —— watch 永远不触发。focusin 会冒泡，
 * 编程式 focus()（tv-nav 的移焦）同样触发。
 *
 * <p>和设置页分区胶囊（SettingsView 的 chipsEl watch）同一个手法：
 * scrollLeft 把目标项居中，**不用 scrollIntoView** —— 部分内核会连带
 * 滚竖向容器把页面拽回去（docs/27 §5.9）。
 */
function onChipFocus(e: FocusEvent) {
  const box = chipsEl.value
  const el = e.target as HTMLElement | null
  if (!box || !box.clientWidth || !el) return
  const target = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2
  box.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
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
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
})

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
  <div class="mx-auto max-w-[1600px] px-6 py-6 max-sm:px-3 max-sm:py-4">
    <!-- 第一行：源站返回的分类 -->
    <!--
      手机：分类胶囊吸顶（2026-11-05 用户要求，和设置页的分区胶囊同一套）。

      ★ 只给 <640：TV 上 tv-nav 把**任何 position:sticky 祖先**当"钉住层"，
        左右键会进不去内容区（见 SearchView 的 tv-unstick 注释）——
        电视必须保持 static。PC 也不吸（桌面高度富裕，吸顶反而多一条横带）。
      ★ 吸顶时底色用 --color-header-veil + 背景模糊，紧贴顶栏下沿成一条连续面板；
        `-my-3` 是给横向滚动条留白的负边距，吸顶后要归零，否则 top 会差 12px。
    -->
    <div
      v-if="classes.length"
      ref="chipsEl"
      class="cat-chips no-scrollbar -mx-6 mb-3 flex gap-1.5 overflow-x-auto overflow-y-hidden px-6 py-3 -my-3 max-sm:sticky max-sm:top-[var(--header-h)] max-sm:z-20 max-sm:-mx-3 max-sm:my-0 max-sm:mb-2 max-sm:border-b max-sm:border-line/60 max-sm:bg-[var(--color-header-veil)] max-sm:px-3 max-sm:py-2.5 max-sm:backdrop-blur-xl"
      @focusin="onChipFocus"
    >
      <button
        v-for="c in classes"
        :key="c.type_id"
        class="shrink-0 rounded-full px-4 py-1.5 text-sm transition"
        :class="
          c.type_id === activeTid
            ? 'bg-accent font-medium text-on-accent'
            : 'text-ink-2 hover:bg-card-hover hover:text-ink'
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
    <div v-else-if="error && !list?.length" class="py-24 text-center">
      <div class="text-3xl opacity-40">📭</div>
      <p class="mt-3 text-sm text-ink-2">{{ error }}</p>
      <p class="mt-1 text-xs text-ink-3">可以换个站点试试</p>
      <button
        class="mt-5 rounded-md bg-card px-4 py-2 text-sm hover:bg-card-hover"
        @click="loadHome"
      >
        刷新
      </button>
    </div>

    <!-- 网格 -->
    <template v-else>
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
