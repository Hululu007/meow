<script setup lang="ts">
/**
 * 左上角红黄绿（B4，默认方案 2b）。
 *
 * 交互：
 *   - 红 = 关闭（走 window.close → 既有 CloseRequested → 关闭到托盘/退出）
 *   - 黄 = 最小化
 *   - 绿 = 最大化/还原
 * 悬停整组时显示 Windows 字形（−/□/×），兼顾两侧习惯。
 *
 * ★ 只在 Tauri 壳挂载；Web/TV/fpk 不渲染。
 * ★ 按钮自身 `@pointerdown.stop`：否则会被标题栏拖拽区吃掉，点了变成拖窗口。
 */
import { tauriInvoke } from '@/api'

const props = withDefaults(defineProps<{ fixed?: boolean }>(), { fixed: false })

function call(cmd: string) {
  tauriInvoke(cmd).catch(() => {
    /* 窗口命令失败不弹错：壳不在或权限不足时静默 */
  })
}

function onClose() {
  // 用 close 而不是 hide：Rust 的 CloseRequested 里才有「关闭到托盘」判定
  call('desktop_window_close')
}
function onMinimize() {
  call('desktop_window_minimize')
}
function onMaximize() {
  call('desktop_window_toggle_maximize')
}
</script>

<template>
  <div
    class="window-controls flex items-center gap-2"
    :class="
      props.fixed
        ? 'fixed left-3 top-3 z-[210] rounded-full bg-black/40 px-2.5 py-1.5 backdrop-blur-sm'
        : ''
    "
    @pointerdown.stop
    @dblclick.stop
  >
    <button type="button" class="tl tl-close" aria-label="关闭" title="关闭" @click.stop="onClose">
      <span class="tl-glyph" aria-hidden="true">×</span>
    </button>
    <button
      type="button"
      class="tl tl-min"
      aria-label="最小化"
      title="最小化"
      @click.stop="onMinimize"
    >
      <span class="tl-glyph" aria-hidden="true">−</span>
    </button>
    <button
      type="button"
      class="tl tl-max"
      aria-label="最大化或还原"
      title="最大化或还原"
      @click.stop="onMaximize"
    >
      <span class="tl-glyph" aria-hidden="true">□</span>
    </button>
  </div>
</template>

<style scoped>
.tl {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  border: 0;
  padding: 0;
  cursor: default;
  /* 老内核没有 :focus-visible，用它自己的 outline 兜底会被 legacy 规则清掉 */
  outline: none;
}
.tl-close {
  background: #ff5f57;
}
.tl-min {
  background: #febc2e;
}
.tl-max {
  background: #28c840;
}
.tl-glyph {
  font-size: 11px;
  line-height: 1;
  font-weight: 800;
  color: rgba(0, 0, 0, 0.78);
  opacity: 0;
  transition: opacity 0.12s ease;
  /* 别让字形被按钮的 12px 裁掉 */
  transform: translateY(-0.5px);
}
.window-controls:hover .tl-glyph,
.window-controls:focus-within .tl-glyph {
  opacity: 1;
}
</style>
