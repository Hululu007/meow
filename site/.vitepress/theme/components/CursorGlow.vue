<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 跟随鼠标的柔光层：只作用于精确指针设备（鼠标/触控板），
 * 用 lerp 平滑，避免直接跟手造成的生硬感。
 */
const glow = ref<HTMLElement | null>(null)

let raf = 0
let targetX = 0
let targetY = 0
let curX = 0
let curY = 0
let started = false

function tick() {
  raf = 0
  curX += (targetX - curX) * 0.14
  curY += (targetY - curY) * 0.14
  if (glow.value) {
    glow.value.style.transform = `translate3d(${curX}px, ${curY}px, 0)`
  }
  if (Math.abs(targetX - curX) > 0.4 || Math.abs(targetY - curY) > 0.4) {
    raf = requestAnimationFrame(tick)
  }
}

function onMove(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return
  targetX = e.clientX
  targetY = e.clientY
  if (!started) {
    started = true
    curX = targetX
    curY = targetY
    if (glow.value) glow.value.style.opacity = '1'
  }
  if (!raf) raf = requestAnimationFrame(tick)
}

function onLeave() {
  if (glow.value) glow.value.style.opacity = '0'
}

onMounted(() => {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const fine = window.matchMedia?.('(pointer: fine)').matches
  if (reduce || !fine) return
  window.addEventListener('pointermove', onMove, { passive: true })
  document.addEventListener('pointerleave', onLeave)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onMove)
  document.removeEventListener('pointerleave', onLeave)
  if (raf) cancelAnimationFrame(raf)
})
</script>

<template>
  <div ref="glow" class="mw-cursor-glow" aria-hidden="true"></div>
</template>

<style>
.mw-cursor-glow {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 0;
  width: 620px;
  height: 620px;
  margin: -310px 0 0 -310px;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.6s ease;
  background: radial-gradient(circle, var(--mw-cursor-glow) 0%, transparent 62%);
  mix-blend-mode: var(--mw-cursor-blend);
}

@media (pointer: coarse) {
  .mw-cursor-glow {
    display: none;
  }
}
</style>
