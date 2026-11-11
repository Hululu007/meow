<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

/**
 * 背景音乐播放器。
 *
 * 音源是 site/docs/public/music/long-juan-feng.mp3（OGG 在 Chrome 下读不到总时长，
 * 转成 MP3 才有可靠的 duration）。文件缺失时显示「背景音乐未找到」。
 *
 * 浏览器禁止有声自动播放，所以等第一次用户交互（点击/按键）再起播；
 * 用户主动暂停后不再自动恢复。
 */
const src = withBase('/music/long-juan-feng.mp3')
const title = '龙卷风 - 邓紫棋'
const artist = ''

const audio = ref<HTMLAudioElement | null>(null)
const playing = ref(false)
const failed = ref(false)
const mounted = ref(false)
const expanded = ref(false)
const progress = ref(0)
const duration = ref(0)

let started = false
let userPaused = false

function fmt(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

const timeText = computed(() => `${fmt(progress.value)} / ${fmt(duration.value)}`)
const percent = computed(() => (duration.value > 0 ? (progress.value / duration.value) * 100 : 0))

async function play() {
  try {
    await audio.value?.play()
    playing.value = true
  } catch {
    playing.value = false
  }
}

function toggle() {
  if (playing.value) {
    audio.value?.pause()
    userPaused = true
    playing.value = false
  } else {
    userPaused = false
    void play()
  }
}

function onTime() {
  if (audio.value) progress.value = audio.value.currentTime
}

function onMeta() {
  if (audio.value) duration.value = audio.value.duration
}

function onError() {
  failed.value = true
}

function seek(e: MouseEvent) {
  const bar = e.currentTarget as HTMLElement
  const rect = bar.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  if (audio.value && duration.value > 0) {
    audio.value.currentTime = ratio * duration.value
    progress.value = audio.value.currentTime
  }
}

function onFirstGesture() {
  if (started || userPaused) return
  started = true
  void play()
}

onMounted(() => {
  mounted.value = true
  window.addEventListener('pointerdown', onFirstGesture, { once: true })
  window.addEventListener('keydown', onFirstGesture, { once: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onFirstGesture)
  window.removeEventListener('keydown', onFirstGesture)
})
</script>

<template>
  <div v-if="mounted && failed" class="mw-music-missing">背景音乐未找到</div>

  <div
    v-else-if="mounted"
    class="mw-music"
    :class="{ 'is-open': expanded, 'is-playing': playing }"
    @mouseenter="expanded = true"
    @mouseleave="expanded = false"
  >
    <audio
      ref="audio"
      :src="src"
      preload="metadata"
      loop
      @timeupdate="onTime"
      @loadedmetadata="onMeta"
      @error="onError"
    />

    <button class="mw-music-btn" :aria-label="playing ? '暂停背景音乐' : '播放背景音乐'" @click.stop="toggle">
      <svg v-if="!playing" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 18.5a3 3 0 1 1-2-2.83V6.2a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 18 3.95v10.72a3 3 0 1 1-2-2.83V7.3l-7 1.75v9.45Z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
        <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
      </svg>
    </button>

    <div class="mw-music-panel">
      <div class="mw-music-meta">
        <b>{{ title }}</b>
        <span v-if="artist">{{ artist }}</span>
      </div>
      <div class="mw-music-track" role="slider" :aria-valuenow="Math.round(percent)" @click.stop="seek">
        <i :style="{ width: `${percent}%` }" />
      </div>
      <span class="mw-music-time">{{ timeText }}</span>
    </div>
  </div>
</template>

<style scoped>
.mw-music-missing {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 30;
  padding: 6px 12px;
  border: 1px dashed var(--mw-line);
  border-radius: 999px;
  background: var(--mw-panel-flat);
  color: var(--mw-text-3);
  font-size: 11px;
}

.mw-music {
  position: fixed;
  left: 20px;
  bottom: 20px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 10px;
}

.mw-music-btn {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
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

.mw-music-btn svg {
  width: 18px;
  height: 18px;
}

.mw-music-btn:hover {
  color: var(--mw-cyan);
  border-color: var(--mw-line-strong);
  transform: translateY(-1px);
}

.mw-music.is-playing .mw-music-btn {
  color: var(--mw-cyan);
  border-color: var(--mw-line-strong);
  box-shadow: 0 0 0 4px var(--mw-brand-soft, rgba(3, 218, 197, 0.12));
}

.mw-music-panel {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--mw-panel-flat);
  backdrop-filter: blur(12px);
  overflow: hidden;
  opacity: 0;
  transition:
    max-width 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    padding 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.25s ease;
}

.mw-music.is-open .mw-music-panel {
  max-width: 300px;
  padding: 6px 14px 6px 16px;
  border-color: var(--mw-line);
  opacity: 1;
}

.mw-music-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  white-space: nowrap;
  line-height: 1.25;
}

.mw-music-meta b {
  color: var(--mw-text);
  font-size: 12.5px;
  font-weight: 650;
}

.mw-music-meta span {
  color: var(--mw-text-3);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.mw-music-track {
  position: relative;
  width: 74px;
  height: 3px;
  border-radius: 999px;
  background: var(--mw-line);
  cursor: pointer;
}

.mw-music-track i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--mw-cyan), var(--mw-violet));
}

.mw-music-time {
  color: var(--mw-text-3);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .mw-music {
    left: 12px;
    bottom: 12px;
  }

  .mw-music.is-open .mw-music-panel {
    max-width: 220px;
    padding: 5px 10px 5px 12px;
  }

  .mw-music-meta span {
    display: none;
  }

  .mw-music-track {
    width: 52px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mw-music-btn,
  .mw-music-panel {
    transition: none;
  }
}
</style>
