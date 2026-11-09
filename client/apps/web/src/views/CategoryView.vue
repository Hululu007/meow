<script setup lang="ts">
/**
 * 分类浏览页：`/category/:site`，可选 `?tid=` 直达某个分类。
 *
 * ## 为什么要独立一页，而不是复用首页 Tab
 *
 * 首页的 Tab 是"边看边滚"的信息流；但从搜索/收藏回跳、或想横向比较几个分类时
 * 需要一个**明确的分类上下文**。旧实现只把分类列成按钮、点了回首页，
 * 等于这一页没有存在价值。
 *
 * ## 分页策略
 *
 * 与首页一致：触底前 900px 预取。区别是不无限续——分类页是浏览目录，
 * 滚到几十页没有意义，所以硬上限 50 页（也挡住不回 pagecount 的源）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchCategory, fetchHome } from '@/api'
import type { HomeClass, VodItem } from '@/api/types'
import PosterCard from '@/components/common/PosterCard.vue'
import { colsStyle, useCardCols } from '@/composables/useCardCols'

const route = useRoute()
const router = useRouter()
const site = computed(() => (route.params.site as string) || '')

const classes = ref<HomeClass[]>([])
const activeTid = ref(String(route.query.tid || ''))
const list = ref<VodItem[]>([])
const page = ref(0)
const pagecount = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const error = ref('')

const { cols, compact } = useCardCols()
const PRELOAD_PX = 900
const MAX_PAGE = 50

const hasMore = computed(
  () => page.value < MAX_PAGE && (pagecount.value === 0 || page.value < pagecount.value),
)

async function loadClasses() {
  if (!site.value) return
  try {
    const h = await fetchHome(site.value)
    classes.value = h.class || []
    if (!activeTid.value && classes.value.length) activeTid.value = classes.value[0].type_id || ''
  } catch {
    classes.value = []
  }
}

async function loadFirst() {
  if (!site.value || !activeTid.value) return
  loading.value = true
  error.value = ''
  list.value = []
  page.value = 0
  pagecount.value = 0
  try {
    const r = await fetchCategory(site.value, activeTid.value, 1)
    list.value = r.list || []
    page.value = Number(r.page || 1)
    pagecount.value = Number(r.pagecount || 0)
    if (!list.value.length) error.value = '该分类暂无数据'
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  const next = page.value + 1
  try {
    const r = await fetchCategory(site.value, activeTid.value, next)
    const got = r.list || []
    // 去重：部分源翻页会重复返回上一页内容（首页同款处理）
    const seen = new Set(list.value.map((x) => x.vod_id))
    list.value = [...list.value, ...got.filter((x) => !seen.has(x.vod_id))]
    page.value = Number(r.page || next)
    pagecount.value = Number(r.pagecount || 0)
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loadingMore.value = false
    await nextTick()
    if (needsFill()) loadMore()
  }
}

/** 内容不够一屏时继续补，否则没有滚动条也就触发不了下次加载 */
function needsFill() {
  return document.documentElement.scrollHeight <= window.innerHeight + PRELOAD_PX
}

function onScroll() {
  const remain = document.documentElement.scrollHeight - window.scrollY - window.innerHeight
  if (remain < PRELOAD_PX) loadMore()
}

function pickClass(tid: string) {
  if (!tid || tid === activeTid.value) return
  activeTid.value = tid
  // 分类写进 URL 才有"可分享/可回退"的语义；用 replace 避免刷爆历史
  router.replace({ query: { ...route.query, tid } })
  window.scrollTo({ top: 0 })
  void (async () => {
    await loadFirst()
    await nextTick()
    if (needsFill()) loadMore()
  })()
}

onMounted(async () => {
  window.addEventListener('scroll', onScroll, { passive: true })
  await loadClasses()
  await loadFirst()
  await nextTick()
  if (needsFill()) loadMore()
})

onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))

// 换站点（从首页切源后点分类）时整体重来
watch(site, async () => {
  activeTid.value = String(route.query.tid || '')
  await loadClasses()
  await loadFirst()
})
</script>

<template>
  <div class="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
    <button
      class="mb-4 flex items-center gap-1.5 text-sm text-ink-2 transition hover:text-accent"
      @click="router.push({ name: 'home' })"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="m15 18-6-6 6-6" />
      </svg>
      返回首页
    </button>

    <div class="flex flex-wrap items-center gap-2">
      <h1 class="mr-2 text-lg font-semibold">{{ site }}</h1>
      <button
        v-for="c in classes"
        :key="c.type_id"
        class="rounded-full border px-3 py-1 text-xs transition"
        :class="
          c.type_id === activeTid
            ? 'border-accent/60 bg-accent/15 text-accent'
            : 'border-line text-ink-2 hover:border-accent/40 hover:text-ink'
        "
        @click="pickClass(c.type_id || '')"
      >
        {{ c.type_name }}
      </button>
    </div>

    <p v-if="loading" class="mt-8 text-sm text-ink-3">加载中…</p>
    <p v-else-if="error && !list.length" class="mt-8 text-sm text-ink-3">{{ error }}</p>

    <div
      class="mt-5 grid gap-x-3"
      :class="compact ? 'gap-y-3' : 'gap-y-5'"
      :style="colsStyle(cols)"
    >
      <PosterCard v-for="v in list" :key="v.vod_id" :item="v" :site="site" />
    </div>

    <div class="mt-8 pb-6 text-center text-xs text-ink-3">
      <span v-if="loadingMore">正在加载更多…</span>
      <span v-else-if="list.length && !hasMore">已经到底了（共 {{ list.length }} 部）</span>
      <span v-else-if="error && list.length">{{ error }}</span>
    </div>
  </div>
</template>
