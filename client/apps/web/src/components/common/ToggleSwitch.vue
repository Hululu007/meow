<script setup lang="ts">
/**
 * 设置页统一的启用开关。
 *
 * 踩过（2026-11-11）：WebDAV 用拨动开关，AI / 运行时模块 / GitHub 加速用勾选框，
 * 同一个「启用」在四个地方三种视觉；而且勾选框在 3 米外的电视上很难看清。
 * 统一成同一个按钮式开关，aria 语义仍是 role=switch。
 */
defineProps<{
  modelValue: boolean
  disabled?: boolean
  /** 无可见文字时给读屏器/遥控器用 */
  label?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
}>()
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40"
    :class="modelValue ? 'bg-accent' : 'bg-card-hover'"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span
      class="block h-4 w-4 rounded-full bg-surface shadow-sm ring-1 ring-black/10 transition"
      :class="modelValue ? 'translate-x-4' : 'translate-x-0.5'"
    />
  </button>
</template>
