<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  clearFavorites,
  listFavorites,
  refreshFavoriteRemarks,
  removeFavorite,
  type FavoriteItem,
} from '@/stores/favorites'
import PosterImage from '@/components/common/PosterImage.vue'
import { colsStyle, useCardCols } from '@/composables/useCardCols'
import { fetchDetail } from '@/api'
import { registerTvMenuHandler } from '@/stores/tvMenu'
import {
  isUpdated,
  lastCheckedAt,
  markAllSeen,
  markChecked,
  markSeen,
  pruneRemarks,
  resetUpdates,
  saveHits,
  savedHits,
  updateDelta,
} from '@/stores/favUpdates'
import { useReturnRestore } from '@/composables/useReturnRestore'

// 返回上一页时恢复滚动位置与焦点（TV 上从详情返回不该跳回顶部）
useReturnRestore('favorites')

const router = useRouter()
const items = ref<FavoriteItem[]>(listFavorites())
const { cols } = useCardCols()

const isEmpty = computed(() => items.value.length === 0)

// ---------------------------------------------------------------- 追剧更新
//
// 收藏项本地只有收藏那一刻的 remarks，判断"有没有更新"必须去源站拿最新的。
// 用 detail（不是 home/category）：只有 detail 能按 id 精确取到同一部片，
// 列表接口要靠片名重新匹配，同名剧会认错。
/**
 * 有更新的收藏：`${site}|${vod_id}` → 源站最新的 remarks。
 *
 * <p>值要留着 —— 点进详情页时用**最新值**当已读基线。原来用收藏时存的旧
 * remarks 去 markSeen，等于没更新，角标永远清不掉（2026-11-05 修）。
 * 初始值来自 localStorage：离开收藏页再回来，角标还在。
 */
const updated = ref<Map<string, string>>(new Map(Object.entries(savedHits())))
const checking = ref(false)
/** 上次全量检查的时间（0 = 没查过），用来显示"x 分钟前检查" */
const lastAt = ref(lastCheckedAt())

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前 */
function fmtAgo(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`
  return `${Math.floor(d / 86400_000)} 天前`
}

/**
 * 更新检查的状态文案。
 *
 * <p>以前只算了 checkMsg 却**从没渲染**（2026-11-05 用户问"能不能加更新标记"，
 * 其实检查一直在跑，只是页面上一个字都不显示）。现在把"查过没有 / 几部有更新"
 * 摆出来，并给一个手动检查按钮。
 */
const statusText = computed(() => {
  if (checking.value) return '正在检查更新…'
  if (updated.value.size) {
    // 汇总新增集数：remarks 抠不出集数的那几部不计入
    let total = 0
    for (const [k, latest] of updated.value) {
      const [site, vodId] = k.split('|')
      const d = updateDelta(site, vodId, latest)
      if (d !== null && d > 0) total += d
    }
    return total > 0
      ? `${updated.value.size} 部有更新 · 共 +${total} 集`
      : `${updated.value.size} 部有更新`
  }
  if (!lastAt.value) return '还没检查过更新'
  return `都是最新的 · ${fmtAgo(lastAt.value)}检查`
})

/** 逐部查最新 remarks，比出哪些更新了。 */
async function checkUpdates() {
  if (checking.value || !items.value.length) return
  checking.value = true
  const hits = new Map<string, string>()
  // 串行 + 少量并发：并发太高容易被源站限流（这些源普遍没做鉴权但有频率限制）
  const queue = [...items.value]
  const CONCURRENCY = 3
  let i = 0
  /** 成功取到 detail 的条数：全失败时不能把上一轮的角标抹掉 */
  let ok = 0
  async function worker() {
    while (i < queue.length) {
      const it = queue[i++]
      try {
        const r = await fetchDetail(it.site, it.vod_id)
        // detail 的形状是 { list: VodItem[] }，remarks 在第一条上
        const latest = r?.list?.[0]?.vod_remarks || ''
        ok++
        if (latest && isUpdated(it.site, it.vod_id, latest)) {
          hits.set(`${it.site}|${it.vod_id}`, latest)
        }
      } catch {
        /* 单片失败跳过，不影响其它片 */
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    // 一条都没查成功（源站全挂/断网）就保持上一轮的结果，别把角标清空
    if (ok) {
      updated.value = hits
      saveHits(Object.fromEntries(hits))
      // 卡片上的「全N集」角签同步成最新值，否则它还挂着收藏那天的旧话，
      // 和「有更新」角标并排看起来自相矛盾
      for (const [k, latest] of hits) {
        const [site, vodId] = k.split('|')
        refreshFavoriteRemarks(site, vodId, latest)
      }
      items.value = listFavorites()
      markChecked()
      lastAt.value = lastCheckedAt()
      // 清理已取消收藏的记录，避免这个 key 无限增长
      pruneRemarks(items.value.map((x) => `${x.site}|${x.vod_id}`))
    }
  } finally {
    checking.value = false
  }
}

// ★ 自动检查已删（2026-11-06 用户定调）：
//   "播放完就去历史继续看去了，收藏的更新功能也就没必要" ——
//   检查的触发和消费都在收藏页，而追剧用户根本不进收藏页 → 死代码，
//   还让收藏多的人每次进页白等几十秒。
//   提醒的真正落点在详情页/播放页（打开详情时零成本对比快照，
//   见 favUpdates.consumeNewEpisodes），这里的检查只保留手动按钮。

/** 点开某部片就视为"看到了最新集数"，之后不再提醒同一件事。 */
function seeIt(it: FavoriteItem) {
  const k = `${it.site}|${it.vod_id}`
  if (updated.value.has(k)) {
    // 已读基线要用源站的最新值（不是收藏时那份旧的），否则下次检查还会报更新
    const latest = updated.value.get(k) || ''
    const next = new Map(updated.value)
    next.delete(k)
    updated.value = next
    markSeen(it.site, it.vod_id, latest)
  }
}

/**
 * 角标旁显示"新增了几集"。
 *
 * <p>用户口径（2026-11-05）："更新集数是否需要显示"。
 * 显示 `+3` 比显示"有更新"信息量大得多 —— 用户知道该去看哪几集。
 *
 * <p>★ 差值必须用 `updateDelta()`（拿 `seen` 里的**收藏时**集数做减数），
 * 不能用收藏条目上的 `vod_remarks`：后者在检查命中后已被
 * `refreshFavoriteRemarks` 覆盖成最新值，拿它当旧值永远差 0。
 *
 * <p>remarks 抠不出集数时（`蓝光` / `02:06:00` 这种）返回 null → 不显示。
 */
function deltaText(it: FavoriteItem): string {
  const latest = updated.value.get(`${it.site}|${it.vod_id}`)
  if (!latest) return ''
  const d = updateDelta(it.site, it.vod_id, latest)
  if (d === null || d <= 0) return ''
  return `+${d}`
}

/** 角标 tooltip：带上源站最新的集数说明，一眼能看出"更新到哪了" */
function updateTitle(it: FavoriteItem): string {
  const v = updated.value.get(`${it.site}|${it.vod_id}`)
  const d = v ? updateDelta(it.site, it.vod_id, v) : null
  if (v && d !== null && d > 0) return `更新了 ${d} 集 · 最新：${v}`
  return v ? `最新：${v}` : '这部有更新'
}

/**
 * 全部标记已读（用户口径："增加已读，重置更新态"）。
 *
 * <p>点进详情已经会自动清一条，但收藏几十部时逐个点开不现实。
 * 这里把基线全部推到最新值 → 下轮检查不会重复报。
 */
function markAllRead() {
  if (!updated.value.size) return
  const n = updated.value.size
  if (!confirm(`把 ${n} 部标记为已读？下次检查不会再提醒这些（直到它们又有新集数）。`)) return
  markAllSeen()
  updated.value = new Map()
  items.value = listFavorites()
}

/**
 * 重置更新态：清角标但不动基线。
 *
 * <p>与"全部已读"的区别：这个只是"别再显示红点"，但下次有新集数
 * 还会提醒。适合"这几部我追完了/不想看了但还想留着收藏"的场合。
 */
function resetUpdateState() {
  if (!updated.value.size) return
  const n = updated.value.size
  if (!confirm(`清掉 ${n} 部的更新标记？\n（基线不变 —— 这几部下次有新集数仍会提醒）`)) return
  resetUpdates()
  updated.value = new Map()
}

function fmt(at: number): string {
  if (!at) return ''
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function open(it: FavoriteItem) {
  seeIt(it)
  router.push({
    name: 'detail',
    params: { site: it.site, id: it.vod_id },
    query: it.vod_name ? { name: it.vod_name } : undefined,
  })
}

function drop(it: FavoriteItem, ev: Event) {
  ev.stopPropagation()
  // 触屏上「取消收藏」是常显的（没有 hover），误触概率比桌面高，确认一次
  const touch = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches
  if (touch && !confirm(`取消收藏《${it.vod_name || '这部片'}》？`)) return
  removeFavorite(it.site, it.vod_id)
  items.value = listFavorites()
  forgetUpdate(it.site, it.vod_id)
}

/** 取消收藏后这条提醒也该立刻消失，别留在 localStorage 里等下次检查才清 */
function forgetUpdate(site: string, vodId: string) {
  const k = `${site}|${vodId}`
  if (!updated.value.has(k)) return
  const next = new Map(updated.value)
  next.delete(k)
  updated.value = next
  saveHits(Object.fromEntries(next))
}

/** 远端收藏晚到 → 刷新（冷启动竞态，与历史页同因；见 history.ts 的同类注释） */
function onRemoteSynced() {
  items.value = listFavorites()
}

function clearAll() {
  if (!confirm('清空全部收藏？')) return
  clearFavorites()
  items.value = []
  updated.value = new Map()
  saveHits({})
}

/**
 * 遥控器菜单键：当前焦点卡片能做什么。
 *
 * 卡片上那两个按钮是 group-hover 才出现的，电视没有 hover——
 * 不挂这个的话「取消收藏」在 TV 上根本按不到（用户只能进详情页再取消）。
 *
 * 焦点元素到数据的映射靠 `data-fav-key`：tv-nav 只加 class 不动 DOM 结构，
 * 用属性比"遍历 items 比对下标"稳（列表会因取消收藏而收缩）。
 */
let offMenu: (() => void) | undefined
onMounted(() => {
  offMenu = registerTvMenuHandler((focused) => {
    const li = focused?.closest?.('[data-fav-key]') as HTMLElement | null
    if (!li) return null
    const it = items.value.find((x) => `${x.site}|${x.vod_id}` === li.dataset.favKey)
    if (!it) return null
    return {
      title: it.vod_name,
      actions: [
        { label: '打开详情', run: () => open(it) },
        {
          label: '取消收藏',
          hint: it.site,
          run: () => {
            removeFavorite(it.site, it.vod_id)
            items.value = listFavorites()
            forgetUpdate(it.site, it.vod_id)
          },
        },
      ],
    }
  })
})
onMounted(() => window.addEventListener('meow:favorites-synced', onRemoteSynced))
onBeforeUnmount(() => {
  offMenu?.()
  window.removeEventListener('meow:favorites-synced', onRemoteSynced)
})
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-6 py-8 max-sm:px-3 max-sm:py-5">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold max-sm:text-lg">我的收藏</h1>
        <p class="mt-1 text-xs text-ink-3 max-sm:mt-0.5 max-sm:text-[11px]">
          共 {{ items.length }} 部 · 点封面进详情页 · 右上角可取消收藏
        </p>
      </div>
      <button
        v-if="!isEmpty"
        class="shrink-0 whitespace-nowrap rounded-md bg-card px-3 py-1.5 text-xs text-ink-2 transition hover:bg-hot/15 hover:text-hot max-sm:px-3.5 max-sm:py-2"
        @click="clearAll"
      >
        清空
      </button>
    </div>

    <!--
      更新检查状态 + 手动检查按钮。
      手机上是"状态药丸 + 右侧按钮"一行；桌面同样一行，只是间距大一点。
    -->
    <div v-if="!isEmpty" class="mt-3 flex flex-wrap items-center gap-2">
      <span
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
        :class="updated.size ? 'bg-hot/12 text-hot' : 'bg-card text-ink-3'"
      >
        <span
          v-if="checking"
          class="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent"
        />
        <span v-else-if="updated.size" class="h-1.5 w-1.5 rounded-full bg-hot" />
        {{ statusText }}
      </span>
      <!--
        全部已读 / 重置更新态（2026-11-05 用户要"增加已读，重置更新态"）。
        只在有更新时出现；两者差别在 tooltip 里说清楚，别让用户猜。
      -->
      <button
        v-if="updated.size"
        class="rounded-md bg-card px-3 py-1.5 text-[11px] text-ink-2 transition hover:bg-card-hover hover:text-ink max-sm:px-3.5 max-sm:py-2"
        title="把基线推到最新：这些部下次有新集数时仍会提醒"
        @click="markAllRead()"
      >
        全部已读
      </button>
      <button
        v-if="updated.size"
        class="rounded-md bg-card px-3 py-1.5 text-[11px] text-ink-2 transition hover:bg-card-hover hover:text-ink max-sm:px-3.5 max-sm:py-2"
        title="只清掉红点，基线不变：这些部下次有新集数仍会提醒"
        @click="resetUpdateState()"
      >
        重置更新态
      </button>
      <button
        class="ml-auto rounded-md bg-card px-3 py-1.5 text-[11px] text-ink-2 transition hover:bg-card-hover hover:text-ink disabled:opacity-40 max-sm:px-3.5 max-sm:py-2"
        :disabled="checking"
        @click="checkUpdates()"
      >
        {{ checking ? '检查中…' : '检查更新' }}
      </button>
    </div>

    <div v-if="isEmpty" class="py-24 text-center max-sm:py-16">
      <div class="text-3xl opacity-40">⭐</div>
      <p class="mt-3 text-sm text-ink-2">还没有收藏</p>
      <p class="mt-1 text-xs text-ink-3">在详情页点「收藏」，就会记在这里</p>
      <RouterLink
        to="/"
        class="mt-5 inline-block rounded-md bg-card px-4 py-2 text-sm hover:bg-card-hover"
      >
        回首页
      </RouterLink>
    </div>

    <ul v-else class="poster-grid mt-6" :style="colsStyle(cols)">
      <li
        v-for="it in items"
        :key="`${it.site}|${it.vod_id}`"
        :data-fav-key="`${it.site}|${it.vod_id}`"
        class="group cursor-pointer rounded-lg"
        tabindex="0"
        role="button"
        :aria-label="it.vod_name"
        @click="open(it)"
      >
        <div class="relative overflow-hidden rounded-lg bg-elevated aspect-[2/3]">
          <PosterImage
            :src="it.vod_pic || ''"
            :alt="it.vod_name"
            img-class="transition duration-300 group-hover:scale-105"
          />
          <div
            class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition group-hover:opacity-100"
          />
          <!--
            有更新：收藏之后源站的 remarks 变了。点进去即视为已读。
            ★ 角标保持窄（只有「有更新」四个字）：右上角是「取消收藏」按钮
              （触屏常显，28–32px），角标一旦加宽就会压住它（实测截图）。
            ★ 新增集数 `+N` 放**右下角**（那里空着），与左下的集数角签分开。
          -->
          <span
            v-if="updated.has(`${it.site}|${it.vod_id}`)"
            class="absolute left-1.5 top-1.5 rounded bg-hot px-1.5 py-0.5 text-[10px] font-medium text-on-hot shadow"
            :title="updateTitle(it)"
          >
            有更新
          </span>
          <button
            class="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/60 text-ink-2 opacity-0 transition hover:bg-hot/80 hover:text-on-hot group-hover:opacity-100 max-sm:h-8 max-sm:w-8 max-sm:bg-black/55 max-sm:opacity-100"
            title="取消收藏"
            @click="drop(it, $event)"
          >
            <svg
              class="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
          <span
            v-if="it.vod_remarks"
            class="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/65 px-1.5 py-0.5 text-[11px] text-ink-2"
          >
            {{ it.vod_remarks }}
          </span>
          <!-- 新增集数：右下角（那里空着，不与取消收藏按钮/集数角签打架） -->
          <span
            v-if="deltaText(it)"
            class="absolute bottom-1.5 right-1.5 rounded bg-hot px-1.5 py-0.5 text-[10px] font-medium text-on-hot shadow"
            :title="updateTitle(it)"
          >
            {{ deltaText(it) }}
          </span>
        </div>
        <p class="poster-title mt-2 truncate text-ink">{{ it.vod_name }}</p>
        <p class="mt-0.5 truncate text-[11px] text-ink-3">
          {{ it.site }}<template v-if="fmt(it.at)"> · {{ fmt(it.at) }}</template>
        </p>
      </li>
    </ul>
  </div>
</template>
