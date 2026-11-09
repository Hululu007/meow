<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/**
 * 播放器控制栏用的小下拉。
 *
 * 原生 <select> 的选项列表由浏览器绘制，**总是往下弹**，
 * 在屏幕底部的控制栏里会被裁掉（实测只能看到一小条）。
 * 这里自己实现，并根据可用空间自动决定往上还是往下。
 */
export interface Option {
  value: number | string
  label: string
}

const props = defineProps<{
  modelValue: number | string
  options: Option[]
  /** 触发按钮的显示文本，默认取当前项 label */
  label?: string
  /**
   * 父级（控制栏）当前是否可见。
   *
   * <p>控制栏收起用的是 `visibility:hidden`，菜单作为后代一起被隐藏，
   * 但 `open` 还是 true —— 菜单"隐形存活"，tv-nav 仍可能把焦点算进去；
   * 用户下次唤出控制栏时它还开着。父级一隐藏就关掉。
   */
  parentVisible?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', v: number | string): void }>()

const open = ref(false)
const root = ref<HTMLElement>()
const menu = ref<HTMLElement>()
const menuStyle = ref<Record<string, string>>({})

const current = computed(
  () => props.options.find((o) => o.value === props.modelValue) ?? props.options[0],
)
const display = computed(() => props.label || String(current.value?.label ?? ''))

async function toggle() {
  // 控制栏已经收起（visibility:hidden）时不许打开：菜单是它的后代，
  // 会跟着一起隐形，只剩一个不可见但存在的 DOM 节点。
  // 实测（2026-11-03）：此时打开菜单，tv-nav 的 visible() 判它不可见，
  // 焦点搬不进去，等于"点了倍速什么都没发生"。
  if (!open.value && props.parentVisible === false) return
  open.value = !open.value
  if (!open.value) return
  await nextTick()
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const itemH = 30
  const est = Math.min(props.options.length * itemH + 12, 320)
  const spaceBelow = window.innerHeight - r.bottom
  // 下方放不下就往上弹（播放器控制栏在底部，通常都会走这条）
  const up = spaceBelow < est + 12
  menuStyle.value = up
    ? { bottom: `${window.innerHeight - r.top + 6}px`, left: `${r.left}px`, width: `${Math.max(r.width, 84)}px` }
    : { top: `${r.bottom + 6}px`, left: `${r.left}px`, width: `${Math.max(r.width, 84)}px` }
  // 等菜单真正渲染出来再搬焦点
  await nextTick()
  focusMenu()
}

function pick(v: number | string) {
  emit('update:modelValue', v)
  open.value = false
}

/**
 * 关菜单并交还焦点。
 *
 * <p>TV 上菜单带 `data-tv-scope`，tv-nav 会把方向键收窄到菜单内；
 * 关闭时用 `__meowTvScopeClosed()` 把焦点还给触发按钮（不还的话焦点框
 * 悬在已卸载的节点上，下一次按键才重新找，用户看到"焦点不见了"）。
 */
function close() {
  if (!open.value) return
  open.value = false
  const w = window as unknown as { __meowTvScopeClosed?: () => boolean }
  if (typeof w.__meowTvScopeClosed === 'function') w.__meowTvScopeClosed()
}

/** 打开后把 TV 焦点搬进菜单第一项（否则焦点还留在触发按钮上，方向键选不动） */
function focusMenu() {
  if (document.documentElement.dataset.tv !== '1') return
  const w = window as unknown as { __meowTvFocus?: (el: unknown, pin?: boolean) => boolean }
  if (typeof w.__meowTvFocus === 'function' && menu.value) w.__meowTvFocus(menu.value, true)
}

watch(
  () => props.parentVisible,
  (v) => {
    if (v === false) close()
  },
)

function onDocDown(e: MouseEvent) {
  const t = e.target as Node
  // 只判 root 会把「点菜单项」当成点击外部：mousedown 先关菜单，
  // 随之而来的 click 落到已卸载的节点上，选项永远选不中
  //（倍速看起来"点了没反应"就是这个原因）。所以菜单节点要单独算上。
  if (root.value?.contains(t) || menu.value?.contains(t)) return
  close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocDown)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocDown)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-xs text-ink transition hover:bg-white/20 backdrop-blur"
      @click.stop="toggle"
    >
      {{ display }}
      <svg
        class="h-3 w-3 opacity-70 transition"
        :class="open ? 'rotate-180' : ''"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <!--
      不要 Teleport 到 body：真全屏（requestFullscreen）时浏览器只渲染
      全屏元素及其后代，body 下的菜单会被整个藏掉 —— 全屏里点倍速没反应
      就是这个原因。留在这里，fixed 定位仍相对视口（祖先没有 transform /
      filter），全屏时随播放器一起显示。
    -->
    <div
      v-if="open"
      ref="menu"
      data-tv-scope
      class="rate-menu fixed z-[110] max-h-[60vh] overflow-y-auto rounded-lg border border-line bg-elevated p-1 shadow-2xl"
      :style="menuStyle"
      @click.stop
    >
      <button
        v-for="o in options"
        :key="o.value"
        type="button"
        class="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-xs transition"
        :class="
          o.value === modelValue
            ? 'bg-player/20 text-player'
            : 'text-ink-2 hover:bg-card-hover hover:text-ink'
        "
        @click="pick(o.value)"
      >
        <span>{{ o.label }}</span>
        <svg
          v-if="o.value === modelValue"
          class="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="3"
        >
          <path d="m5 13 4 4L19 7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style>
@keyframes rate-menu-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.rate-menu {
  animation: rate-menu-in 0.12s ease both;
}
</style>
