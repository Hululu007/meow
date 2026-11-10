<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import KernelDiagram from './KernelDiagram.vue'

const quickStart = withBase('/guide/quick-start.html')
const downloads = withBase('/reference/downloads.html')

const visual = ref<HTMLElement | null>(null)
let raf = 0

onMounted(() => {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (reduce) return
  const onScroll = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      // 图示轻微滞后滚动，制造景深；限制幅度避免跑出可视区
      const y = Math.min(window.scrollY, 820)
      if (visual.value) visual.value.style.transform = `translate3d(0, ${(y * 0.09).toFixed(2)}px, 0)`
    })
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))
})
</script>

<template>
  <section class="mw-hero">
    <div class="mw-hero-bg" aria-hidden="true"></div>
    <div class="mw-hero-grid" aria-hidden="true"></div>
    <div class="mw-hero-noise" aria-hidden="true"></div>

    <div class="mw-hero-inner">
      <div class="mw-hero-copy">
        <p class="mw-kicker">
          <span class="mw-dot"></span>
          猫窝 Meow · 跨端影视客户端
        </p>

        <h1 class="mw-hero-title">
          一套内核
          <span class="mw-grad">三个出口</span>
        </h1>

        <p class="mw-hero-lede">
          同一套 JVM 宿主、同一份 spider jar、同一套配置语义，
          同时服务浏览器、Windows 桌面端和 Android TV。
          仓库只提供加载能力，源包由你导入。
        </p>

        <div class="mw-hero-actions">
          <a class="mw-btn mw-btn-primary" :href="quickStart">
            快速开始
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </a>
          <a class="mw-btn mw-btn-ghost" :href="downloads">下载客户端</a>
          <a class="mw-btn mw-btn-text" href="https://github.com/upchr/meow" target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.09.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.55-1.14-4.55-5.05 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.92-2.34 4.79-4.57 5.04.36.32.68.94.68 1.9v2.81c0 .27.18.59.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
            </svg>
            GitHub
          </a>
        </div>

        <ul class="mw-hero-tags">
          <li>Web</li>
          <li>Windows</li>
          <li>Android TV</li>
          <li>fnOS</li>
          <li class="mw-tag-muted">source-available</li>
        </ul>
      </div>

      <div ref="visual" class="mw-hero-visual">
        <KernelDiagram />
      </div>
    </div>

    <div class="mw-hero-fade" aria-hidden="true"></div>

    <div class="mw-hero-scroll" aria-hidden="true">
      <span>向下滚动</span>
      <i></i>
    </div>
  </section>
</template>

<style scoped>
.mw-hero {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  min-height: min(74vh, 730px);
  padding: 44px 0 84px;
  overflow: hidden;
}

.mw-hero-bg,
.mw-hero-grid,
.mw-hero-noise,
.mw-hero-fade {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* 细颗粒噪点：给大块深色底增加质感，避免纯色的“塑料感” */
.mw-hero-noise {
  z-index: -1;
  opacity: var(--mw-noise-opacity);
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 140px 140px;
}

.mw-hero-bg {
  z-index: -3;
  background:
    radial-gradient(58% 48% at 18% 0%, var(--mw-glow-a), transparent 72%),
    radial-gradient(48% 42% at 88% 6%, var(--mw-glow-b), transparent 70%);
}

.mw-hero-grid {
  z-index: -2;
  background-image:
    linear-gradient(var(--mw-grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--mw-grid-line) 1px, transparent 1px);
  background-size: 52px 52px;
  mask-image: radial-gradient(ellipse 85% 65% at 50% 38%, #000 20%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 85% 65% at 50% 38%, #000 20%, transparent 78%);
}

.mw-hero-fade {
  z-index: -1;
  top: auto;
  height: 110px;
  background: linear-gradient(to bottom, transparent, var(--mw-bg));
}

.mw-hero-inner {
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
  padding: 0 32px;
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
  align-items: center;
  gap: 24px;
}

.mw-kicker {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 22px;
  padding: 5px 13px 5px 11px;
  border: 1px solid var(--mw-line);
  border-radius: 999px;
  background: var(--mw-panel);
  color: var(--mw-text-2);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.mw-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mw-cyan);
  box-shadow: 0 0 10px var(--mw-cyan);
  animation: mw-pulse 2.6s ease-in-out infinite;
}

.mw-hero-title {
  margin: 0;
  font-size: clamp(38px, 4.8vw, 64px);
  line-height: 1.04;
  font-weight: 800;
  letter-spacing: -0.035em;
  color: var(--mw-text);
}

.mw-grad {
  display: block;
  background: linear-gradient(96deg, var(--mw-grad-1) 0%, var(--mw-grad-2) 46%, var(--mw-grad-3) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.mw-hero-lede {
  max-width: 520px;
  margin: 24px 0 0;
  color: var(--mw-text-2);
  font-size: 16.5px;
  line-height: 1.85;
}

.mw-hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 34px;
}

.mw-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 46px;
  padding: 0 22px;
  border-radius: 11px;
  font-size: 14.5px;
  font-weight: 650;
  text-decoration: none;
  transition:
    transform 0.2s ease,
    box-shadow 0.25s ease,
    border-color 0.25s ease,
    background 0.25s ease;
}

.mw-btn:hover {
  transform: translateY(-1px);
}

.mw-btn-primary {
  color: #04120f;
  background: linear-gradient(135deg, #5cf5e4, var(--mw-cyan) 55%, #00b9a8);
  box-shadow:
    0 0 0 1px rgba(3, 218, 197, 0.5),
    0 10px 34px -8px rgba(3, 218, 197, 0.55);
}

.mw-btn-primary:hover {
  box-shadow:
    0 0 0 1px rgba(3, 218, 197, 0.7),
    0 14px 42px -8px rgba(3, 218, 197, 0.7);
}

.mw-btn-primary svg {
  width: 16px;
  height: 16px;
}

.mw-btn-ghost {
  color: var(--mw-text);
  border: 1px solid var(--mw-line);
  background: var(--mw-panel);
}

.mw-btn-ghost:hover {
  border-color: var(--mw-line-strong);
  background: var(--mw-panel-hover);
}

.mw-btn-text {
  color: var(--mw-text-2);
  padding: 0 10px;
}

.mw-btn-text svg {
  width: 17px;
  height: 17px;
}

.mw-btn-text:hover {
  color: var(--mw-text);
}

.mw-hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 30px 0 0;
  padding: 0;
  list-style: none;
}

.mw-hero-tags li {
  padding: 3px 10px;
  border: 1px solid var(--mw-line);
  border-radius: 6px;
  color: var(--mw-text-2);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.mw-hero-tags .mw-tag-muted {
  border-style: dashed;
  color: var(--mw-text-3);
}

.mw-hero-visual {
  position: relative;
  margin-left: -34px;
  will-change: transform;
}

.mw-hero-scroll {
  position: absolute;
  left: 50%;
  bottom: 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
  color: var(--mw-text-3);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.22em;
}

.mw-hero-scroll i {
  display: block;
  width: 1px;
  height: 34px;
  background: linear-gradient(to bottom, var(--mw-cyan), transparent);
  transform-origin: top;
  animation: mw-scroll-hint 2.2s ease-in-out infinite;
}

@keyframes mw-scroll-hint {
  0% {
    transform: scaleY(0.2);
    opacity: 0.2;
  }
  45% {
    transform: scaleY(1);
    opacity: 0.9;
  }
  100% {
    transform: scaleY(0.2);
    opacity: 0.2;
  }
}

@keyframes mw-pulse {
  0%,
  100% {
    opacity: 1;
    box-shadow: 0 0 10px var(--mw-cyan);
  }
  50% {
    opacity: 0.45;
    box-shadow: 0 0 4px var(--mw-cyan);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mw-hero-scroll i {
    animation: none;
    opacity: 0.5;
    transform: scaleY(1);
  }
}

@media (max-width: 1024px) {
  .mw-hero {
    min-height: 0;
    padding: 56px 0 72px;
  }

  .mw-hero-inner {
    grid-template-columns: 1fr;
    gap: 40px;
    padding: 0 24px;
  }

  .mw-hero-visual {
    order: 2;
    max-width: 620px;
    margin-left: 0;
  }
}

@media (max-width: 768px) {
  /* 架构图在窄屏缩到 0.5 倍后文字不可读，直接让位给文案 */
  .mw-hero-visual {
    display: none;
  }

  .mw-hero {
    min-height: auto;
    padding-bottom: 44px;
  }

  .mw-hero-scroll {
    display: none;
  }
}

@media (max-width: 640px) {
  .mw-hero-lede {
    font-size: 15.5px;
  }

  .mw-btn {
    height: 44px;
    padding: 0 18px;
  }

  .mw-hero-tags li {
    font-size: 11px;
  }
}
</style>
