<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vitepress'

/**
 * 正文截图点击放大。
 *
 * 文档列宽 688px，而安装步骤截图普遍 1400–2300px 宽（缩到 30% 时
 * 图里的按钮文字看不清）。这里用最小实现补一个灯箱，不引第三方库。
 *
 * 只接管 `.vp-doc` 内的图片：小图标（naturalWidth < 160）、被链接包住的图、
 * 标了 `.no-zoom` 的图都跳过，避免抢掉原本的点击行为。
 */
const route = useRoute()
const src = ref('')
const alt = ref('')
const open = ref(false)

let prevOverflow = ''

function isZoomable(el: HTMLElement): el is HTMLImageElement {
  if (el.tagName !== 'IMG') return false
  if (!el.closest('.vp-doc')) return false
  if (el.closest('a')) return false
  if (el.classList.contains('no-zoom')) return false
  const img = el as HTMLImageElement
  return (img.naturalWidth || 0) >= 160
}

function close() {
  if (!open.value) return
  open.value = false
  document.body.style.overflow = prevOverflow
  window.removeEventListener('keydown', onKey)
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  close()
}

function onDocClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target || !isZoomable(target)) return
  e.preventDefault()
  src.value = target.currentSrc || target.src
  alt.value = target.alt || ''
  open.value = true
  prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKey)
}

watch(
  () => route.path,
  () => close(),
)

onMounted(() => document.addEventListener('click', onDocClick))

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onKey)
  if (open.value) document.body.style.overflow = prevOverflow
})
</script>

<template>
  <Teleport to="body">
    <Transition name="mw-zoom">
      <div
        v-if="open"
        class="mw-zoom"
        role="dialog"
        aria-modal="true"
        aria-label="图片预览"
        @click="close"
      >
        <img class="mw-zoom-img" :src="src" :alt="alt" />
        <button class="mw-zoom-close" type="button" aria-label="关闭图片预览" @click.stop="close">
          ✕
        </button>
        <p class="mw-zoom-hint">点击任意处或按 Esc 关闭</p>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mw-zoom {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(4, 7, 10, 0.92);
  backdrop-filter: blur(6px);
  cursor: zoom-out;
}

.mw-zoom-img {
  max-width: 94vw;
  max-height: 88vh;
  border-radius: 8px;
  box-shadow: 0 24px 80px -20px rgba(0, 0, 0, 0.8);
  cursor: zoom-out;
}

.mw-zoom-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  border: 1px solid var(--mw-line);
  border-radius: 50%;
  background: var(--mw-panel-flat);
  color: var(--mw-text-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.mw-zoom-close:hover {
  color: var(--mw-cyan);
  border-color: var(--mw-line-strong);
}

.mw-zoom-hint {
  position: absolute;
  bottom: 18px;
  left: 50%;
  margin: 0;
  transform: translateX(-50%);
  color: var(--mw-text-3);
  font-size: 11.5px;
  letter-spacing: 0.06em;
}

.mw-zoom-enter-active,
.mw-zoom-leave-active {
  transition: opacity 0.2s ease;
}

.mw-zoom-enter-from,
.mw-zoom-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .mw-zoom {
    padding: 16px;
  }

  .mw-zoom-hint {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mw-zoom-enter-active,
  .mw-zoom-leave-active {
    transition: none;
  }
}
</style>
