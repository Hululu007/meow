<script setup lang="ts">
/**
 * 播放页 / 直播页的窗口装饰（B4）。
 *
 * 这两页不渲染 AppHeader（整屏画面），所以标题栏也不能跟着渲染。
 * 处理：
 *   - 顶部 1.5px 透明拖拽条（鼠标可拖动窗口）
 *   - 右上角 hover 才浮出的红黄绿（放右侧是为了避开播放器左上角的返回键）
 *
 * 只在 Tauri 壳挂载。
 */
import WindowControls from './WindowControls.vue'
import { beginWindowDrag } from '@/composables/useWindowDrag'
</script>

<template>
  <div
    class="fixed inset-x-0 top-0 z-[199] h-2"
    aria-hidden="true"
    @pointerdown="beginWindowDrag"
  />
  <div class="group fixed right-2 top-2 z-[210] h-9 w-24">
    <div
      class="ml-auto flex w-fit opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
    >
      <WindowControls class="rounded-full bg-black/45 px-2.5 py-1.5" />
    </div>
  </div>
</template>
