<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

/**
 * 首次访问的欢迎页（进入闸门）。
 *
 * 只做三件事：
 * 1. 首次访问时给一个「进入」动作——浏览器要求用户手势才能播有声内容，
 *    这个点击正好满足，进入后背景音乐立刻响，而不是「随便点一下才开始」。
 * 2. 交代一句这个仓库不提供源包，避免访客以为装不上。
 * 3. 记住选择，之后直接进站；`?welcome=1` 可强制重看。
 *
 * 不在深层链接上拦截：从搜索引擎直接进 /guide/xxx 的访客不该被挡。
 */
const KEY = 'meow.welcomed.v1'
const BASE = import.meta.env.BASE_URL || '/'

const show = ref(false)
const leaving = ref(false)

/**
 * 用 location 而不是 route.path：layout-top 里拿到的 route 可能还没同步，
 * 直接读地址栏最可靠，也能兼容 /index.html 这种直连。
 */
function isHome() {
  const p = window.location.pathname.replace(/\/index\.html$/, '/')
  const base = BASE.endsWith('/') ? BASE : `${BASE}/`
  return p === base || p === base.replace(/\/$/, '')
}

function shouldShow() {
  if (typeof window === 'undefined') return false
  if (new URLSearchParams(window.location.search).get('welcome') === '1') return true
  if (localStorage.getItem(KEY)) return false
  return isHome()
}

function enter() {
  if (leaving.value) return
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* 隐私模式下写不了也不影响进入 */
  }
  leaving.value = true
  // 通知播放器：这次点击是合法的用户手势，可以起播
  window.dispatchEvent(new CustomEvent('mw:enter'))
  window.setTimeout(() => {
    show.value = false
  }, 520)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') enter()
}

let prevOverflow = ''

onMounted(() => {
  if (!shouldShow()) return
  show.value = true
  prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.body.style.overflow = prevOverflow
  window.removeEventListener('keydown', onKey)
})

function done() {
  document.body.style.overflow = prevOverflow
}
</script>

<template>
  <div
    v-if="show"
    class="mw-gate"
    :class="{ 'is-leaving': leaving }"
    role="dialog"
    aria-modal="true"
    aria-labelledby="mw-gate-title"
    @click="enter"
    @transitionend="done"
  >
    <div class="mw-gate-grid" aria-hidden="true"></div>
    <div class="mw-gate-glow" aria-hidden="true"></div>

    <div class="mw-gate-inner">
      <img class="mw-gate-logo" :src="withBase('/logo.svg')" alt="" width="88" height="88" />

      <p class="mw-gate-kicker">跨端影视客户端</p>
      <h1 id="mw-gate-title" class="mw-gate-title">猫窝 Meow</h1>
      <p class="mw-gate-sub">一套内核，三个出口</p>

      <div class="mw-gate-actions">
        <button class="mw-gate-enter" type="button" @click.stop="enter">
          进入站点
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <a class="mw-gate-skip" :href="withBase('/guide/quick-start')" @click.stop="enter">直接看文档</a>
      </div>

      <p class="mw-gate-note">
        本仓库不提供任何内容源，装完是空壳，需要导入你自己的源包。
      </p>
    </div>

    <p class="mw-gate-hint">按 Esc 或点任意处进入</p>
  </div>
</template>

<style scoped>
.mw-gate {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--mw-bg);
  cursor: pointer;
  opacity: 1;
  transition:
    opacity 0.5s ease,
    transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.mw-gate.is-leaving {
  opacity: 0;
  transform: scale(1.03);
  pointer-events: none;
}

.mw-gate-grid,
.mw-gate-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.mw-gate-grid {
  background-image:
    linear-gradient(var(--mw-grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--mw-grid-line) 1px, transparent 1px);
  background-size: 52px 52px;
  mask-image: radial-gradient(ellipse 70% 55% at 50% 45%, #000 25%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 70% 55% at 50% 45%, #000 25%, transparent 78%);
}

.mw-gate-glow {
  background:
    radial-gradient(50% 40% at 50% 30%, var(--mw-glow-a), transparent 70%),
    radial-gradient(40% 34% at 78% 74%, var(--mw-glow-b), transparent 70%);
}

.mw-gate-inner {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  animation: mw-gate-in 0.7s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes mw-gate-in {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.mw-gate-logo {
  width: 88px;
  height: 88px;
  border-radius: 22px;
  box-shadow:
    0 0 0 1px var(--mw-line),
    0 18px 48px -18px rgba(3, 218, 197, 0.55);
  animation: mw-gate-breathe 4.5s ease-in-out infinite;
}

@keyframes mw-gate-breathe {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}

.mw-gate-kicker {
  margin: 26px 0 0;
  color: var(--mw-cyan);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.2em;
}

.mw-gate-title {
  margin: 10px 0 0;
  color: var(--mw-text);
  font-size: clamp(34px, 5vw, 52px);
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

.mw-gate-sub {
  margin: 12px 0 0;
  color: var(--mw-text-2);
  font-size: 15px;
  letter-spacing: 0.02em;
}

.mw-gate-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 34px;
}

.mw-gate-enter {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 46px;
  padding: 0 24px;
  border: 0;
  border-radius: 11px;
  color: #04120f;
  background: linear-gradient(135deg, #5cf5e4, var(--mw-cyan) 55%, #00b9a8);
  font-size: 14.5px;
  font-weight: 700;
  cursor: pointer;
  box-shadow:
    0 0 0 1px rgba(3, 218, 197, 0.5),
    0 12px 36px -10px rgba(3, 218, 197, 0.6);
  transition:
    transform 0.2s ease,
    box-shadow 0.25s ease;
}

.mw-gate-enter:hover {
  transform: translateY(-1px);
  box-shadow:
    0 0 0 1px rgba(3, 218, 197, 0.75),
    0 16px 44px -10px rgba(3, 218, 197, 0.75);
}

.mw-gate-enter svg {
  width: 16px;
  height: 16px;
}

.mw-gate-skip {
  color: var(--mw-text-2);
  font-size: 13.5px;
  font-weight: 600;
  text-decoration: none;
}

.mw-gate-skip:hover {
  color: var(--mw-cyan);
}

.mw-gate-note {
  max-width: 400px;
  margin: 32px 0 0;
  color: var(--mw-text-3);
  font-size: 12.5px;
  line-height: 1.8;
}

.mw-gate-hint {
  position: absolute;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%);
  color: var(--mw-text-3);
  font-size: 11px;
  letter-spacing: 0.08em;
}

@media (max-width: 640px) {
  .mw-gate-logo {
    width: 72px;
    height: 72px;
    border-radius: 18px;
  }

  .mw-gate-actions {
    flex-direction: column;
    gap: 12px;
  }

  .mw-gate-hint {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mw-gate,
  .mw-gate-inner {
    transition: none;
    animation: none;
  }

  .mw-gate-logo {
    animation: none;
  }
}
</style>
