<script setup lang="ts">
import { useRouter } from 'vue-router'

/**
 * 「我的」三页签：观看历史 / 我的收藏 / 片库。
 *
 * <p><b>为什么是共用组件</b>：/me（MeView）和 /library（LibraryView，从片库
 * 页签进来后）都要显示同一条 —— 否则从「我的」点进片库后页签栏整个消失，
 * 想回历史/收藏得多点一次底栏（2026-11-12 用户反馈「片库页上方看不见
 * 页签胶囊组」）。
 *
 * <p><b>导航语义</b>：历史 ↔ 收藏之间 `router.replace`（同页分区切换，
 * 不压返回栈，理由见 MeView 顶部注释）；片库是独立路由，`push` 进去。
 * 组件自身不持有状态：active 由调用方给（MeView 传自己的分区，
 * LibraryView 恒传 'library'），切换后的状态跟着 URL 走。
 */
const props = defineProps<{ active: 'history' | 'favorites' | 'library' }>()
const router = useRouter()
</script>

<template>
  <div class="mb-4 flex gap-1 rounded-full border border-line bg-card p-1" role="tablist">
    <button
      type="button"
      role="tab"
      :aria-selected="props.active === 'history'"
      class="flex-1 rounded-full py-2.5 text-sm transition"
      :class="
        props.active === 'history'
          ? 'bg-accent font-medium text-on-accent'
          : 'text-ink-2 hover:bg-card-hover hover:text-ink'
      "
      @click="router.replace({ name: 'me' })"
    >
      观看历史
    </button>
    <button
      type="button"
      role="tab"
      :aria-selected="props.active === 'favorites'"
      class="flex-1 rounded-full py-2.5 text-sm transition"
      :class="
        props.active === 'favorites'
          ? 'bg-accent font-medium text-on-accent'
          : 'text-ink-2 hover:bg-card-hover hover:text-ink'
      "
      @click="router.replace({ name: 'me', query: { tab: 'favorites' } })"
    >
      我的收藏
    </button>
    <button
      type="button"
      role="tab"
      :aria-selected="props.active === 'library'"
      class="flex-1 rounded-full py-2.5 text-sm transition"
      :class="
        props.active === 'library'
          ? 'bg-accent font-medium text-on-accent'
          : 'text-ink-2 hover:bg-card-hover hover:text-ink'
      "
      @click="router.push({ name: 'library' })"
    >
      片库
    </button>
  </div>
</template>
