<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ delay?: number; as?: string }>(), {
  delay: 0,
  as: 'div',
})

const el = ref<HTMLElement | null>(null)
const armed = ref(false)
const shown = ref(false)
let io: IntersectionObserver | null = null

onMounted(() => {
  if (!el.value) return
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduce || !('IntersectionObserver' in window)) {
    shown.value = true
    return
  }
  // 只有 JS 就绪后才隐藏元素，避免脚本失败时正文不可见
  armed.value = true
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          shown.value = true
          io?.disconnect()
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -48px 0px' },
  )
  io.observe(el.value)
})

onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <component
    :is="props.as"
    ref="el"
    class="mw-reveal"
    :class="{ 'is-armed': armed, 'is-visible': shown }"
    :style="{ transitionDelay: `${props.delay}ms` }"
  >
    <slot />
  </component>
</template>

<style>
.mw-reveal {
  transition:
    opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.7s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: opacity, transform;
}

.mw-reveal.is-armed:not(.is-visible) {
  opacity: 0;
  transform: translateY(26px);
}

@media (prefers-reduced-motion: reduce) {
  .mw-reveal,
  .mw-reveal.is-armed:not(.is-visible) {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
</style>
