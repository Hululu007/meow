<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const progress = ref(0)
let raf = 0

function update() {
  const doc = document.documentElement
  const max = doc.scrollHeight - doc.clientHeight
  progress.value = max > 0 ? Math.min(1, Math.max(0, doc.scrollTop / max)) : 0
}

function onScroll() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    update()
  })
}

onMounted(() => {
  update()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onScroll)
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <div class="mw-progress" aria-hidden="true">
    <i :style="{ transform: `scaleX(${progress})` }" />
  </div>
</template>

<style scoped>
.mw-progress {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 100;
  height: 2px;
  pointer-events: none;
}

.mw-progress i {
  display: block;
  height: 100%;
  transform-origin: 0 50%;
  background: linear-gradient(90deg, var(--mw-cyan), var(--mw-violet));
  box-shadow: 0 0 10px rgba(3, 218, 197, 0.55);
}
</style>
