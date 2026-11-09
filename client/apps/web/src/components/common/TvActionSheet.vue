<script setup lang="ts">
/**
 * 遥控器「菜单键」弹出的操作面板。
 *
 * 为什么需要：卡片上的「移除 / 详情」是 hover 才出现的浮层按钮，鼠标能点，
 * 遥控器够不到（没有 hover，也没法把焦点停在 opacity:0 的元素上）。
 * 电视通用的做法是给当前选中的卡片挂一个上下文菜单——按菜单键列出
 * 这张卡片能做的事。
 *
 * 数据来源是**页面注册的 provider**，不是一个全局动作表：只有当前页知道
 * 焦点在哪张卡片、能对它做什么。
 */
import { closeTvMenu, tvMenuActions, tvMenuIsOpen, tvMenuTitle } from '@/stores/tvMenu'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const panel = ref<HTMLElement>()

/**
 * 返回键要能关掉这个面板（2026-11-04 审计补）。
 *
 * App.vue 的返回键只会把 Escape 派发给可见的 `[data-tv-scope]` / `[role=dialog]`，
 * 然后无条件 return true —— 本组件原来是**唯一一个没有 Escape 接收端**的
 * 全局弹层，于是面板开着时按返回：面板不关、按键还被吞掉，用户只能再按
 * 菜单键或选一个动作才能退出。
 */
function onEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (tvMenuIsOpen()) closeTvMenu()
}

onMounted(() => document.addEventListener('keydown', onEscape))
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape))

watch(tvMenuIsOpen, async (v) => {
  if (!v) return
  // 打开后把焦点交给第一个动作：电视上焦点框不动就等于"没打开"
  await nextTick()
  const first = panel.value?.querySelector('button')
  first?.focus()
})
</script>

<template>
  <div
    v-if="tvMenuIsOpen()"
    class="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 px-4 pb-6 sm:items-center sm:pb-0"
    @click.self="closeTvMenu()"
  >
    <!-- data-tv-scope：tv-nav 据此把焦点收窄到面板内，方向键不会跑到背景卡片上 -->
    <div
      ref="panel"
      data-tv-scope
      class="w-full max-w-md overflow-hidden rounded-xl border border-line bg-elevated shadow-2xl"
      role="dialog"
      aria-label="卡片操作"
    >
      <div class="border-b border-line px-4 py-2.5 text-[12px] text-ink-3">
        {{ tvMenuTitle() }}
      </div>
      <div class="p-1.5">
        <button
          v-for="a in tvMenuActions()"
          :key="a.label"
          class="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink"
          @click="a.run(); closeTvMenu()"
        >
          <span class="flex-1">{{ a.label }}</span>
          <span v-if="a.hint" class="text-[11px] text-ink-3">{{ a.hint }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
