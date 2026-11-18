<script setup lang="ts">
/**
 * 「关于」弹框：当前版本 + GitHub 入口 + 版本历史（可滚动）。
 *
 * 三个硬约定（照搬设置页现有弹层，理由见 SettingsView「站点明细」那段注释）：
 *  1. **Teleport to body** —— 设置页的 `<main>` 是 `relative z-10`，形成了层叠
 *     上下文；弹框留在里面时 `z-[120]` 只在 main 内部比较，顶栏（sticky z-30）
 *     会盖住它。唯一解法是跳出去。
 *  2. **`data-tv-scope`** —— tv-nav 据此把方向键收窄到弹框内。
 *  3. **历史区 `data-tv-scroll` + `tabindex="0"` 两个都带** —— TV 上才把这块当
 *     滚动停靠点，方向键才滚得动（缺一个就"焦点进不来、上下没反应"，
 *     UpdateDialog 2026-11-13 踩过）。
 *
 * 数据是**运行时拉**的（`api/changelog.ts`），所以有加载/失败两态；失败给「重试」。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { fetchChangelogHistory, type ChangelogEntry } from '@/api/changelog'
import { formatNoteLines } from '@/api/appUpdate'

const props = defineProps<{
  /** 当前安装版本（设置页从 boot_info / __APP_VERSION__ 拿到的那份） */
  version: string
  /** 平台名，只用于副标题 */
  platform?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-project'): void
}>()

const loading = ref(true)
const error = ref('')
const versions = ref<ChangelogEntry[]>([])
/** 历史滚动区：TV 上必须能在渲染落地后拿到焦点 */
const scroller = ref<HTMLElement>()
/** 失败态的「重试」：这是那时唯一有意义的落点 */
const retryBtn = ref<HTMLElement>()
/** 「返回」：列表还没到（加载中）时的保底落点，别让 TV 焦点悬空 */
const backBtn = ref<HTMLElement>()

const iconSrc = computed(() => `${import.meta.env.BASE_URL}icon-192.png`)

/**
 * 把焦点交给 tv-nav（TV 壳）或原生 focus。
 *
 * ★ TV 上不能只调 `el.focus()`：tv-nav 的焦点框是加 `.meow-tv-focus` class 画的，
 *   原生 `:focus` 是另一套。只调原生焦点时方向键动的是 tv-nav 的框、原生那圈留在
 *   原处；而且初始焦点可能被 tv-nav 自己的 initialFocus 抢走（2026-11-18 踩过，
 *   LibraryAddDialog 同款处理）。
 */
function focusEl(el: HTMLElement | undefined | null, pin = true): void {
  if (!el) return
  const w = window as unknown as {
    __meowTvNav?: unknown
    __meowTvFocus?: (t: Element, pin?: boolean) => boolean
  }
  if (typeof w.__meowTvNav === 'function' && typeof w.__meowTvFocus === 'function') {
    w.__meowTvFocus(el, pin)
    return
  }
  el.focus()
}

async function load(force = false): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    versions.value = await fetchChangelogHistory(force)
    await nextTick()
    // 有列表：焦点落到滚动区（TV 上随即能用方向键滚）
    focusEl(scroller.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    await nextTick()
    focusEl(retryBtn.value)
  } finally {
    loading.value = false
  }
}

/** 历史条目按行拆：老版本（0.9.x）有些行没编号，formatNoteLines 会补上 */
function linesOf(entry: ChangelogEntry): string[] {
  return formatNoteLines(entry.lines.join('\n'))
}

onMounted(() => {
  // 加载中也有落点：TV 上弹框刚出现时若没有焦点，方向键会跑到背景
  focusEl(backBtn.value)
  void load()
})
</script>

<template>
  <Teleport to="body">
    <div
      data-tv-scope
      class="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 sm:p-6"
      @click.self="emit('close')"
    >
      <div
        class="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-base"
        style="box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.75)"
      >
        <!-- 头部：图标 + 版本 + GitHub + 返回 -->
        <div class="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
          <img :src="iconSrc" alt="" width="36" height="36" class="h-9 w-9 rounded-[9px] object-cover" />
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-ink">猫窝 Meow</div>
            <div class="mt-0.5 text-[12px] text-ink-3">
              v{{ version }}<span v-if="platform" class="ml-1.5">· {{ platform }}</span>
            </div>
          </div>
          <button
            type="button"
            class="rounded-md bg-card p-1.5 text-ink-2 transition hover:bg-card-hover hover:text-ink"
            title="项目主页"
            aria-label="项目主页"
            @click="emit('open-project')"
          >
            <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
          </button>
          <button
            ref="backBtn"
            type="button"
            class="rounded-md bg-card px-2.5 py-1 text-[11px] text-ink transition hover:bg-card-hover"
            @click="emit('close')"
          >
            返回
          </button>
        </div>

        <!-- 版本历史：TV 上方向键靠 data-tv-scroll + tabindex 才滚得动 -->
        <div
          ref="scroller"
          data-tv-scroll
          tabindex="0"
          class="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none"
        >
          <p v-if="loading" class="py-10 text-center text-xs text-ink-3">正在拉取版本历史…</p>
          <div v-else-if="error" class="py-8 text-center">
            <p class="text-xs text-hot">{{ error }}</p>
            <button
              ref="retryBtn"
              type="button"
              class="mt-3 rounded-md bg-card px-3 py-1.5 text-[12px] text-ink transition hover:bg-card-hover"
              @click="load(true)"
            >
              重试
            </button>
          </div>
          <ul v-else class="space-y-5">
            <li v-for="entry in versions" :key="entry.version">
              <div class="flex items-center gap-2">
                <span class="text-[13px] font-medium text-ink">v{{ entry.version }}</span>
                <!-- 日期来自 release tag；老版本没打过 tag 就不显示（不猜） -->
                <span v-if="entry.date" class="text-[11px] tabular-nums text-ink-3">
                  {{ entry.date }}
                </span>
                <span
                  v-if="entry.version === props.version"
                  class="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
                >
                  当前
                </span>
              </div>
              <ul class="mt-1 space-y-1">
                <li
                  v-for="(line, i) in linesOf(entry)"
                  :key="i"
                  class="text-[12px] leading-relaxed text-ink-2"
                >
                  {{ line }}
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>
