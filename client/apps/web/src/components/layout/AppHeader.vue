<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { listHistory } from '@/stores/history'
import { listFavorites } from '@/stores/favorites'
import { pendingUpdateCount } from '@/stores/favUpdates'
import { getWebdav } from '@/stores/prefs'
import { getSyncStatus, onSyncStatus, type SyncStatus } from '@/stores/sync'

const store = useAppStore()
const router = useRouter()
const route = useRoute()
const keyword = ref('')
const showSites = ref(false)
/** 窄屏「更多」菜单；宽屏被 sm:hidden 藏起来，状态留着无害 */
const showMore = ref(false)

/**
 * 手机顶栏的「搜索框」。
 *
 * <p>形态上是一个占满剩余宽度的输入框样式，但**不是真 input**：
 * 点它就是直接去搜索页（那里有输入框、范围切换、最近搜索和聚合进度）。
 * 用 `<button>` 而不是只读 input 的原因：input 会先聚焦、弹一次键盘，
 * 然后才跳页 —— 用户看到的是"键盘闪一下又换页面"。
 *
 * <p>桌面（≥640）不渲染这个，走原来的内联 input + 回车。
 */
function goSearch() {
  if (route.name === 'search') return
  router.push({ name: 'search' })
}

/** 搜索页自带搜索框 + 范围切换，顶栏不再重复显示 */
const isSearchPage = computed(() => route.name === 'search')

/** 每次路由变化都重算，看完片返回时角标能立刻更新 */
const historyCount = computed(() => {
  // 依赖 route.fullPath 才会在导航后重新求值
  void route.fullPath
  return listHistory().length
})

/** 同 historyCount：收藏也可能在详情页改完后回到别的页面 */
const favoriteCount = computed(() => {
  void route.fullPath
  return listFavorites().length
})

/**
 * 收藏里有几部出了新集数（顶栏红点）。
 *
 * <p>★ 性能判据（用户明确要求"不影响性能再加"）：
 * `pendingUpdateCount()` 只读 `favUpdates` 的**模块级缓存**（见该文件的
 * `cache` 变量），不碰 localStorage、不发请求、不解析 JSON。
 * 它挂在 `route.fullPath` 上 → 每次导航算一次 → O(1)。
 *
 * <p>为什么不复用 `favoriteCount` 那套 `listFavorites()`：那个每次导航都
 * JSON.parse 一遍 localStorage 并且排序（收藏上限 500 条）。这里不碰它。
 */
const favoriteUpdates = ref(pendingUpdateCount())

/** 检查结果变了（收藏页检查完 / 标记已读）→ 角标跟着变 */
function onFavUpdatesChanged() {
  favoriteUpdates.value = pendingUpdateCount()
}

// ---------------------------------------------------------------- 同步状态

const syncStatus = ref<SyncStatus>(getSyncStatus())
/** 开关状态也要响应式，否则切换「启用」后顶栏不更新 */
const syncEnabled = ref(getWebdav().enabled)
let offSync: (() => void) | undefined

function onWebdavChange() {
  syncEnabled.value = getWebdav().enabled
}

/**
 * 顶栏的同步提示。
 *
 * 只在开启同步后出现：同步中 / 失败 时显示，
 * 成功时短暂提示，空闲时不占位置。
 */
const syncHint = computed(() => {
  if (!syncEnabled.value) return null
  const s = syncStatus.value
  if (s.state === 'syncing') return { text: '同步中', cls: 'bg-card text-ink-2', title: '正在上传到 WebDAV' }
  if (s.state === 'error')
    return { text: '同步失败', cls: 'bg-hot/15 text-hot', title: s.message || '同步失败' }
  if (s.state === 'ok')
    return { text: '已同步', cls: 'bg-ok/12 text-ok', title: s.message || '已同步' }
  return null
})

/**
 * Escape 关闭站点下拉。
 *
 * 为什么需要：TV 壳的返回键走 `onBackPressed` → `__meowTvConsumeBack`，
 * 它**不派发 keydown**。App.vue 的 onTvBack 现在会先找可见弹层并派发一次
 * Escape（让组件自己关），所以每个"弹层型"组件都必须有这个接收端。
 *
 * 实测：只加 data-tv-scope 不加这个监听时，按返回键菜单不会关，
 * 只是焦点框消失 —— 用户被困在"菜单还在但选不了"的状态。
 */
function onDocKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (showSites.value) showSites.value = false
  if (showMore.value) showMore.value = false
}

/**
 * 点空白处关菜单（鼠标/触屏）。
 *
 * <p>因为手机上「更多」没有遮罩层：点页面别处应该直接关掉，
 * 不然用户会以为菜单粘住了（原来只能再点一次「…」或选中某一项）。
 *
 * <p>触发按钮自己的 click 先执行、再冒泡到这里，所以这里用 closest 排掉
 * 触发器和菜单本身，不会出现"点开又立刻关掉"。
 */
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t) return
  if (showSites.value && !t.closest('[data-site-menu]')) showSites.value = false
  if (showMore.value && !t.closest('[data-more-menu]')) showMore.value = false
}

/** 换页后菜单一律收起：手机上不收起会浮在下一个页面上 */
watch(
  () => route.fullPath,
  () => {
    showSites.value = false
    showMore.value = false
  },
)

/*
 * 站点下拉开合与 TV 焦点的联动。
 *
 * 打开：tv-nav 的 activeScope() 会把焦点搬进菜单，并优先落到
 *       `aria-selected`（当前源）上 —— 用 TV 时按 OK 打开就能直接从当前源上下找。
 * 关闭：把焦点还给「选择站点」按钮。用户要求原话是「返回键关闭弹框，
 *       同时聚焦到原位置」；不还的话焦点框会落到菜单消失后几何最近的
 *       内容区卡片上。
 */
watch(showSites, (v) => {
  if (v) return
  const w = window as unknown as { __meowTvScopeClosed?: () => boolean }
  if (typeof w.__meowTvScopeClosed === 'function') w.__meowTvScopeClosed()
})

onMounted(() => {
  offSync = onSyncStatus((s) => (syncStatus.value = s))
  window.addEventListener('meow:webdav', onWebdavChange)
  window.addEventListener('meow:fav-updates-changed', onFavUpdatesChanged)
  document.addEventListener('keydown', onDocKey)
  document.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => {
  offSync?.()
  window.removeEventListener('meow:webdav', onWebdavChange)
  window.removeEventListener('meow:fav-updates-changed', onFavUpdatesChanged)
  document.removeEventListener('keydown', onDocKey)
  document.removeEventListener('click', onDocClick)
})

function submit() {
  const wd = keyword.value.trim()
  if (!wd) return
  router.push({ name: 'search', query: { wd } })
}

/**
 * TV：遥控器 ok / 点击落在顶栏搜索框上时，直接进搜索页（2026-11-04 用户要求）。
 *
 * <p>为什么不在顶栏就地输入（原来的做法）：
 *   · 遥控器没有字母键，顶栏这个窄输入框本来也打不了几个字；
 *   · 用户真正想要的是"进搜索页"，那里有输入框、搜索范围、**最近搜索回看**
 *     和语音/扫码兜底 —— 顶栏只是入口，不该自己扛输入。
 *
 * <p>为什么跳转不带 query：用户要求"便于根据历史回顾"，空关键词进页面
 * 才能看到「最近搜索」胶囊；如果带了词就直接开搜了，历史反而看不见。
 *
 * <p>PC/Web 不受影响：那里 input 的 click 就是正常聚焦，回车才提交。
 */
function onSearchClick() {
  const tv =
    typeof document !== 'undefined' &&
    (document.documentElement.dataset.tv === '1' || /MeowTV/i.test(navigator.userAgent))
  if (!tv) return
  // 已经在搜索页就不再重复 push（会压一条无意义的历史）
  if (route.name === 'search') return
  router.push({ name: 'search' })
}

function pickSite(key: string) {
  store.setCurrent(key)
  showSites.value = false
  if (route.name !== 'home') router.push({ name: 'home' })
}
</script>

<template>
  <header
    class="app-header sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line px-3 backdrop-blur-xl max-sm:gap-1.5 sm:gap-3 sm:px-6"
  >
    <!-- Logo -->
    <RouterLink to="/" class="group flex shrink-0 items-center gap-2.5">
      <img
        src="/icon-192.png"
        alt="猫窝"
        class="h-8 w-8 rounded-[9px] object-cover transition group-hover:brightness-110 max-sm:h-7 max-sm:w-7 max-sm:rounded-lg"
      />
      <!-- 窄屏只留图标：文字块占 44px，390px 视口上这点宽度要留给搜索框和站点名 -->
      <span class="hidden flex-col leading-none sm:flex">
        <span class="text-[15px] font-semibold tracking-[0.02em] text-ink">猫窝</span>
        <span class="mt-[3px] text-[9px] font-medium uppercase tracking-[0.2em] text-ink-3">
          Meow
        </span>
      </span>
    </RouterLink>

    <!-- 站点选择 -->
    <div class="relative min-w-0" data-site-menu>
      <button
        id="site-trigger"
        class="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink max-sm:rounded-full max-sm:border max-sm:border-line max-sm:bg-card max-sm:px-2.5 max-sm:py-1 max-sm:text-[13px] sm:px-2.5"
        @click="showSites = !showSites"
      >
        <span class="max-w-[5.5rem] truncate max-sm:max-w-[6.5rem] sm:max-w-[9rem]">
          {{ store.currentSite?.name || '选择站点' }}
        </span>
        <svg class="h-3.5 w-3.5 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <!--
        data-tv-scope：把方向键收窄到菜单内。

        踩过（实测）：菜单宽 288px、按钮起点 144px，菜单项中心比内容区
        偏右 93px；tv-nav 的次轴惩罚 ×2.5 把这点偏差放大成 232.5 分，
        而下面分类胶囊「热播剧集」只差 8px → 每次按下键都是胶囊赢。
        结果：**44 个站点一次都进不去**。

        退出路径已经齐了：选中即 pickSite() 关菜单；磁贴外点击也关。
        TV 上还要靠返回键（App.vue 的 onTvBack 现在会先关可见弹层）。
      -->
      <div
        v-if="showSites"
        data-tv-scope
        class="absolute left-0 top-full mt-2 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-line bg-elevated p-1.5 shadow-2xl max-sm:max-h-[60vh] max-sm:w-[15rem] max-sm:p-2"
        @mouseleave="showSites = false"
      >
        <button
          v-for="s in store.sortedSites"
          :key="s.key"
          :aria-selected="s.key === store.current ? 'true' : undefined"
          class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition max-sm:py-3 max-sm:text-[15px]"
          :class="
            s.key === store.current
              ? 'bg-accent/15 text-accent'
              : 'text-ink-2 hover:bg-card-hover hover:text-ink'
          "
          @click="pickSite(s.key)"
        >
          <span class="flex-1 truncate">{{ s.name }}</span>
          <span v-if="s.ext" class="text-[10px] text-ink-3">ext</span>
        </button>
      </div>
    </div>

    <!-- 直播：与点播并列，不做成"某个源里的一个分组" -->
    <RouterLink
      to="/live"
      class="hidden shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink md:flex"
      title="直播频道"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="7" width="20" height="13" rx="2" />
        <path d="M8 3l4 4 4-4" />
      </svg>
      <span>直播</span>
    </RouterLink>

    <!-- 本地片库：与点播并列。片库不是"一个在线源"，放源下拉里会被埋掉 -->
    <RouterLink
      to="/library"
      class="hidden shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink md:flex"
      title="本地 / NAS 片库"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
        <path d="M3 7l9 4 9-4" />
        <path d="M12 11v10" />
      </svg>
      <span>片库</span>
    </RouterLink>

    <!-- 收藏 -->
    <RouterLink
      to="/favorites"
      class="relative hidden shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink sm:flex"
      title="我的收藏"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
      </svg>
      <span>收藏</span>
      <!-- 有新集数：红点。不占位（absolute）→ 不推动其它导航项的排版 -->
      <span
        v-if="favoriteUpdates"
        class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-hot"
        :title="`${favoriteUpdates} 部收藏有新集数`"
      />
      <span
        v-if="favoriteCount"
        class="rounded-full bg-card-hover px-1.5 text-[10px] leading-4 text-ink-2"
      >
        {{ favoriteCount }}
      </span>
    </RouterLink>

    <!-- 历史 -->
    <RouterLink
      to="/history"
      class="hidden shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink sm:flex"
      title="观看历史"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 4v4h4" />
        <path d="M12 7v5l3 2" />
      </svg>
      <span>历史</span>
      <span
        v-if="historyCount"
        class="rounded-full bg-card-hover px-1.5 text-[10px] leading-4 text-ink-2"
      >
        {{ historyCount }}
      </span>
    </RouterLink>

    <!--
      AI 助手：独立页入口。
      TV 上浮层的对话区只有约 400px，长回答要一屏屏挪，所以把"能全屏看"
      做成顶栏可达的一级入口，而不是只在浮层里藏一个「全屏」小按钮。
    -->
    <RouterLink
      to="/ai"
      class="hidden shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink sm:flex"
      title="AI 助手"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" />
        <path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z" />
      </svg>
      <span>AI</span>
    </RouterLink>

    <!-- 同步状态：只在启用 WebDAV 且非空闲时出现 -->
    <span
      v-if="syncHint"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
      :class="syncHint.cls"
      :title="syncHint.title"
    >
      <span
        v-if="syncStatus.state === 'syncing'"
        class="h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current"
      />
      <svg v-else-if="syncStatus.state === 'ok'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 9v4M12 17h.01" />
        <circle cx="12" cy="12" r="9" />
      </svg>
      {{ syncHint.text }}
    </span>

    <!--
      搜索框：靠右浮动，不撑满中间。

      ★ 不能 shrink-0（2026-11-05 实测）：640–1023 这一档用的是桌面顶栏，
        固定 304px 的搜索框会让整条顶栏超出视口（811 宽溢出 166px、960 宽 43px）。
        允许它收缩后，窄视口自动压窄输入框；≥1024 宽度富裕、表现不变。

      用户要求「顶栏的搜索框、设置按钮 要在右侧浮动」。
      原来是 `flex-1 md:max-w-md` —— 在宽屏上它会一路撑到 448px，
      起点紧挨着左侧导航项，看起来像"占据了中间大半条"，
      而不是"浮在右侧"。改成固定宽度 + `ml-auto` 推开：
      左侧导航保持左对齐、中间留白，搜索框和设置按钮成组贴在右边缘。
    -->
      <!--
        手机「搜索框」：输入框外形 + 占满剩余宽度，点一下直达搜索页。
        不是真 input（避免先弹键盘再跳页），也不是小图标（用户要求"变宽"）。
      -->
      <button
        v-if="!isSearchPage"
        type="button"
        class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-card px-3 text-left text-[13px] text-ink-3 sm:hidden"
        title="搜索"
        aria-label="搜索"
        @click="goSearch()"
      >
        <svg class="h-4 w-4 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span class="truncate">搜索影片…</span>
      </button>

    <form
      v-if="!isSearchPage"
      class="ml-auto flex w-full min-w-0 max-w-[15rem] items-center max-sm:hidden sm:max-w-[17rem] md:max-w-[19rem]"
      @submit.prevent="submit"
    >
      <div class="relative flex-1">
        <svg
          class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          v-model="keyword"
          type="search"
          placeholder="搜索影片…"
          data-tv-input-owner
          class="h-9 w-full rounded-full border border-line bg-card pl-9 pr-3 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent/50 focus:bg-card"
          @keyup.enter="submit"
          @click="onSearchClick"
        />
      </div>
    </form>

    <!-- 右侧 -->
    <!--
      搜索页时顶栏没有搜索框（页面自己有完整搜索控件），
      这时右侧这组要自己 ml-auto 顶到右边，否则会紧贴着导航项。
    -->
    <nav
      class="flex shrink-0 items-center gap-1 max-sm:ml-auto"
      :class="isSearchPage ? 'ml-auto' : ''"
    >
      <RouterLink
        to="/settings"
        class="hidden rounded-md px-3 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink sm:block"
      >
        设置
      </RouterLink>

      <!--
        手机：顶栏不再放输入框（390px 上它会把站点名挤成 0 宽，只剩一个箭头），
        换成一个搜索图标 → 进搜索页。搜索页有完整输入框、范围切换和最近搜索，
        顶栏本来就不是手机上的输入位（与 TV 的 onSearchClick 同一套理由）。
        桌面（sm+）沿用原来的内联搜索框。
      -->

      <!-- 窄屏「更多」：上面被隐藏的入口必须在这里找得到，否则等于功能消失。
           覆盖到 md（<768）：直播/片库是 md:flex，640–767 这段只有这里能进 -->
      <div class="relative md:hidden" data-more-menu>
        <button
          class="rounded-md px-2 py-1.5 text-ink-2 transition hover:bg-card-hover hover:text-ink max-sm:grid max-sm:h-10 max-sm:w-10 max-sm:place-items-center max-sm:rounded-full"
          title="更多"
          @click="showMore = !showMore"
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="5" cy="12" r="1.4" />
            <circle cx="12" cy="12" r="1.4" />
            <circle cx="19" cy="12" r="1.4" />
          </svg>
        </button>
        <div
          v-if="showMore"
          class="absolute right-0 top-full mt-2 w-40 overflow-hidden rounded-lg border border-line bg-elevated p-1.5 shadow-2xl max-sm:w-56 max-sm:p-2"
        >
          <RouterLink
            to="/library"
            class="block rounded-md px-3 py-2 text-sm text-ink-2 transition max-sm:py-3 max-sm:text-[15px] hover:bg-card-hover hover:text-ink"
            @click="showMore = false"
          >
            片库
          </RouterLink>
          <RouterLink
            to="/live"
            class="block rounded-md px-3 py-2 text-sm text-ink-2 transition max-sm:py-3 max-sm:text-[15px] hover:bg-card-hover hover:text-ink"
            @click="showMore = false"
          >
            直播
          </RouterLink>
          <RouterLink
            to="/favorites"
            class="block rounded-md px-3 py-2 text-sm text-ink-2 transition max-sm:py-3 max-sm:text-[15px] hover:bg-card-hover hover:text-ink"
            @click="showMore = false"
          >
            收藏<span v-if="favoriteCount" class="ml-1 text-[11px] text-ink-3">{{ favoriteCount }}</span>
            <!-- 手机上的更新提醒（桌面顶栏用红点，这里用文字计数） -->
            <span v-if="favoriteUpdates" class="ml-1.5 text-[11px] text-hot">
              {{ favoriteUpdates }} 部有新集数
            </span>
          </RouterLink>
          <RouterLink
            to="/history"
            class="block rounded-md px-3 py-2 text-sm text-ink-2 transition max-sm:py-3 max-sm:text-[15px] hover:bg-card-hover hover:text-ink"
            @click="showMore = false"
          >
            历史<span v-if="historyCount" class="ml-1 text-[11px] text-ink-3">{{ historyCount }}</span>
          </RouterLink>
          <!-- AI / 设置 不进这个菜单：手机上它们是底部标签栏的一级入口 -->

        </div>
      </div>
    </nav>

  </header>
</template>
