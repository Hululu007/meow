<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 浮动「回到顶部」。
 *
 * VitePress 自带的返回顶部在侧栏里，长文档（source-format 366 行）滚到底后
 * 得先滚到侧栏才点得到。按钮放在音乐播放器上方（播放器占 right 20 / bottom 20
 * 的 44px 圆），避免两者重叠。
 */
const visible = ref(false)

function onScroll() {
  visible.value = window.scrollY > 700
}

function toTop() {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
}

onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
})

onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))
</script>

<template>
  <Transition name="mw-top">
    <button
      v-if="visible"
      class="mw-top"
      type="button"
      aria-label="回到顶部"
      title="回到顶部"
      @click="toTop"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 19V5m0 0-6 6m6-6 6 6"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </Transition>
</template>

<style scoped>
.mw-top {
  position: fixed;
  right: 20px;
  bottom: 76px;
  z-index: 30;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--mw-line);
  border-radius: 50%;
  background: var(--mw-panel-flat);
  color: var(--mw-text-2);
  cursor: pointer;
  backdrop-filter: blur(12px);
  transition:
    color 0.25s ease,
    border-color 0.25s ease,
    transform 0.2s ease;
}

.mw-top:hover {
  color: var(--mw-cyan);
  border-color: var(--mw-line-strong);
  transform: translateY(-1px);
}

.mw-top svg {
  width: 18px;
  height: 18px;
}

.mw-top-enter-active,
.mw-top-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.mw-top-enter-from,
.mw-top-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (prefers-reduced-motion: reduce) {
  .mw-top,
  .mw-top-enter-active,
  .mw-top-leave-active {
    transition: none;
  }
}
</style>
