<script setup lang="ts">
/**
 * 统一的空状态 / 错误状态。
 *
 * 三个来源（首页无数据、搜索无结果、片库空、详情失败）原来各写一套
 * 字号/间距/按钮，视觉升级后统一到这里：
 *   - 图标 + 标题 + 一句原因 + 一个动作
 *   - 标题用 --fs-title（A4 新增档），不写死 px
 *
 * ★ 只负责“在页面内容区占位”，不要拿它替换 RouterView：
 *   错误提示不能把路由出口整个顶掉（App.vue 的既有决策）。
 */
withDefaults(
  defineProps<{
    icon?: string
    title: string
    hint?: string
  }>(),
  { icon: '🐾', hint: '' },
)
</script>

<template>
  <div class="flex flex-col items-center justify-center px-6 py-20 text-center">
    <div class="text-4xl opacity-50" aria-hidden="true">{{ icon }}</div>
    <p
      class="mt-4 max-w-[34rem] text-balance font-medium text-ink"
      :style="{ fontSize: 'var(--fs-title)', lineHeight: 1.3 }"
    >
      {{ title }}
    </p>
    <p v-if="hint" class="mt-2 max-w-[34rem] text-sm leading-relaxed text-ink-2">
      {{ hint }}
    </p>
    <div v-if="$slots.default" class="mt-6 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  </div>
</template>
