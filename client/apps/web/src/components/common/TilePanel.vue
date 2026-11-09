<script setup lang="ts">
import type { TileAction } from './tile'

defineProps<{
  items: TileAction[]
  /** 每行列数：设置页 4 列，首页功能行用 8 列更紧凑 */
  cols?: 2 | 3 | 4 | 5 | 6 | 8
}>()

const colClass: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 md:grid-cols-3',
  4: 'grid-cols-2 md:grid-cols-4',
  5: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5',
  6: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6',
  8: 'grid-cols-3 md:grid-cols-4 xl:grid-cols-8',
}
</script>

<template>
  <div class="grid gap-2.5" :class="colClass[cols || 4]">
    <button
      v-for="it in items"
      :key="it.key"
      type="button"
      class="tile group"
      :class="{ 'pointer-events-none opacity-40': it.disabled }"
      :title="it.hint"
      @click="it.onClick?.()"
    >
      <!--
        hint 既做 title 也做副标题。
        只做 title 时在 TV/触屏上完全看不见（没有 hover），用户原话是
        「不知道功能在哪，看不到文字描述」—— 这些按钮的作用恰恰不是自明的
        （「清空本地缓存」和「恢复默认设置」到底差在哪，光看名字猜不出）。
        有 hint 时改成两行；没有时保持单行，避免高度不齐。
      -->
      <span class="flex min-w-0 flex-col text-left">
        <span class="truncate text-[15px] text-ink">{{ it.label }}</span>
        <span v-if="it.hint" class="mt-0.5 truncate text-[11px] leading-tight text-ink-3">
          {{ it.hint }}
        </span>
      </span>
      <span class="ml-auto flex shrink-0 items-center gap-1.5">
        <span v-if="it.value" class="text-[13px] text-ink-2">{{ it.value }}</span>
        <svg
          v-if="it.arrow !== false"
          class="h-3.5 w-3.5 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-accent"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </span>
    </button>
  </div>
</template>
