<script setup lang="ts">
/**
 * 无边框窗口的 8 向缩放手柄（B4）。
 *
 * tao 的 decorations:false 会去掉 WS_THICKFRAME，窗口失去原生边框，
 * 只能由网页在视口边缘放热区调 `start_resize_dragging`。
 *
 * 尺寸：边 1.5px、角 3px。只占视口最外圈，不挡内容点击。
 */
import { tauriInvoke } from '@/api'

function start(direction: string) {
  tauriInvoke('desktop_window_start_resize', { direction }).catch(() => {
    /* 窗口命令失败静默 */
  })
}
</script>

<template>
  <div aria-hidden="true">
    <!-- 边 -->
    <div class="fixed left-2 right-2 top-0 z-[300] h-1.5 cursor-ns-resize" @pointerdown.prevent="start('n')" />
    <div class="fixed bottom-0 left-2 right-2 z-[300] h-1.5 cursor-ns-resize" @pointerdown.prevent="start('s')" />
    <div class="fixed bottom-2 right-0 top-2 z-[300] w-1.5 cursor-ew-resize" @pointerdown.prevent="start('e')" />
    <div class="fixed bottom-2 left-0 top-2 z-[300] w-1.5 cursor-ew-resize" @pointerdown.prevent="start('w')" />
    <!-- 角 -->
    <div class="fixed left-0 top-0 z-[301] h-3 w-3 cursor-nwse-resize" @pointerdown.prevent="start('nw')" />
    <div class="fixed right-0 top-0 z-[301] h-3 w-3 cursor-nesw-resize" @pointerdown.prevent="start('ne')" />
    <div class="fixed bottom-0 left-0 z-[301] h-3 w-3 cursor-nesw-resize" @pointerdown.prevent="start('sw')" />
    <div class="fixed bottom-0 right-0 z-[301] h-3 w-3 cursor-nwse-resize" @pointerdown.prevent="start('se')" />
  </div>
</template>
