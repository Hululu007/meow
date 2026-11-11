<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'

/**
 * 背景音乐播放器。
 *
 * 音源：site/docs/public/music/long-juan-feng.mp3
 * （原始 OGG 在 Chrome 下读不到 duration，转 128k MP3 才有可靠时长）
 *
 * 可视化用浏览器自带的 AnalyserNode 做 FFT，不引第三方库：
 * audioMotion / butterchurn 那类库是为全屏播放器设计的，塞进 44px 按钮里
 * 只会把首屏压垮。这里取它们的视觉语言（频谱 + 旋转唱片 + 发光进度），
 * 用 30 行 canvas 自己画。
 *
 * 浏览器禁止有声自动播放：等第一次用户交互再起播；用户主动暂停后不再自动恢复。
 */
const src = withBase('/music/long-juan-feng.mp3')
const title = '龙卷风 - 邓紫棋'

const audio = ref<HTMLAudioElement | null>(null)
const miniCanvas = ref<HTMLCanvasElement | null>(null)
const barCanvas = ref<HTMLCanvasElement | null>(null)

const playing = ref(false)
const failed = ref(false)
const mounted = ref(false)
const expanded = ref(false)
const progress = ref(0)
const duration = ref(0)

let started = false
let userPaused = false
/** 自动起播的时间戳：用于吞掉紧随其后的一次按钮点击 */
let autoPlayAt = 0

// ── 音频图与绘制状态 ──────────────────────────────
let ac: AudioContext | null = null
let analyser: AnalyserNode | null = null
let bins: Uint8Array | null = null
let raf = 0
let miniCtx: CanvasRenderingContext2D | null = null
let barCtx: CanvasRenderingContext2D | null = null

const MINI_W = 20
const MINI_H = 15
const BAR_W = 52
const BAR_H = 22

const CYAN = '#03dac5'
const VIOLET = '#7c5cff'

function setupCanvas(canvas: HTMLCanvasElement | null, w: number, h: number) {
  if (!canvas) return null
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const c = canvas.getContext('2d')
  if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0)
  return c
}

function drawBars(
  c: CanvasRenderingContext2D | null,
  w: number,
  h: number,
  count: number,
  data: Uint8Array | null,
) {
  if (!c) return
  c.clearRect(0, 0, w, h)
  const gap = count > 4 ? 2 : 1.5
  const bw = Math.max(1.5, (w - gap * (count - 1)) / count)
  for (let i = 0; i < count; i++) {
    // 取低频段的一小部分，视觉上更像节拍
    const idx = data && data.length ? Math.floor((i / count) * data.length * 0.62) : -1
    const v = data && idx >= 0 ? data[idx] / 255 : 0
    const bh = Math.max(1.5, v * h)
    const g = c.createLinearGradient(0, h, 0, h - bh)
    g.addColorStop(0, CYAN)
    g.addColorStop(1, VIOLET)
    c.fillStyle = g
    c.beginPath()
    if (typeof c.roundRect === 'function') {
      c.roundRect(i * (bw + gap), h - bh, bw, bh, bw / 2)
    } else {
      c.rect(i * (bw + gap), h - bh, bw, bh)
    }
    c.fill()
  }
}

function paint() {
  drawBars(miniCtx, MINI_W, MINI_H, 4, bins)
  drawBars(barCtx, BAR_W, BAR_H, 9, bins)
}

function startLoop() {
  if (raf) return
  const tick = () => {
    raf = 0
    if (!analyser || !bins) return
    analyser.getByteFrequencyData(bins)
    paint()
    if (playing.value) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  if (bins) bins.fill(0)
  paint()
}

/** 首次播放时才建图：AudioContext 必须在用户手势里创建/恢复 */
function ensureGraph() {
  if (ac || !audio.value) return
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return
  ac = new AC()
  const source = ac.createMediaElementSource(audio.value)
  analyser = ac.createAnalyser()
  analyser.fftSize = 128
  analyser.smoothingTimeConstant = 0.82
  source.connect(analyser)
  analyser.connect(ac.destination)
  bins = new Uint8Array(analyser.frequencyBinCount)
}

function fmt(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

const timeText = computed(() => `${fmt(progress.value)} / ${fmt(duration.value)}`)
const percent = computed(() => (duration.value > 0 ? (progress.value / duration.value) * 100 : 0))

function play(): Promise<void> {
  // 必须在用户手势的同步栈里先调 play()。
  // 之前先 await ac.resume() 再 play，等待期间手势过期，浏览器会以
  // NotAllowedError 拒绝播放（表现为「点了没反应」）。
  const started2 = audio.value?.play()
  // 建图失败不该阻断播放：退化成纯音频也比不响好
  try {
    ensureGraph()
    if (ac && ac.state === 'suspended') void ac.resume().catch(() => {})
  } catch {
    /* 没有可视化，但音频照播 */
  }
  return (started2 ?? Promise.reject(new Error('no audio')))
    .then(() => {
      playing.value = true
      startLoop()
    })
    .catch(() => {
      playing.value = false
    })
}

function toggle() {
  // pointerdown 已经自动起播时，随后的 click 不能再当一次「暂停」：
  // 否则 play() 的 promise 先 resolve，这里就会把刚响的音频停掉（实测约 1/3 命中）
  if (performance.now() - autoPlayAt < 500) return

  if (playing.value) {
    audio.value?.pause()
    userPaused = true
    playing.value = false
    stopLoop()
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
  autoPlayAt = performance.now()
  void play()
}

function onVisibility() {
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  } else if (playing.value) {
    startLoop()
  }
}

onMounted(async () => {
  mounted.value = true
  // v-if 的内容在同一个 tick 里还没进 DOM，必须等下一次渲染
  await nextTick()
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    miniCtx = setupCanvas(miniCanvas.value, MINI_W, MINI_H)
    barCtx = setupCanvas(barCanvas.value, BAR_W, BAR_H)
  }
  window.addEventListener('pointerdown', onFirstGesture, { once: true })
  window.addEventListener('keydown', onFirstGesture, { once: true })
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onFirstGesture)
  window.removeEventListener('keydown', onFirstGesture)
  document.removeEventListener('visibilitychange', onVisibility)
  if (raf) cancelAnimationFrame(raf)
  void ac?.close().catch(() => {})
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

    <button
      class="mw-music-btn"
      :aria-label="playing ? '暂停背景音乐' : '播放背景音乐'"
      :aria-pressed="playing"
      @click.stop="toggle"
    >
      <span class="mw-music-ring" aria-hidden="true"></span>
      <canvas ref="miniCanvas" class="mw-music-mini" aria-hidden="true"></canvas>
      <svg class="mw-music-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 18.5a3 3 0 1 1-2-2.83V6.2a1 1 0 0 1 .76-.97l9-2.25A1 1 0 0 1 18 3.95v10.72a3 3 0 1 1-2-2.83V7.3l-7 1.75v9.45Z" />
      </svg>
    </button>

    <div class="mw-music-panel">
      <div class="mw-disc" :class="{ spinning: playing }" aria-hidden="true">
        <i></i>
      </div>

      <div class="mw-music-main">
        <b class="mw-music-title">{{ title }}</b>
        <div class="mw-music-track" role="slider" :aria-valuenow="Math.round(percent)" aria-label="播放进度" @click.stop="seek">
          <i :style="{ width: `${percent}%` }"></i>
          <em :style="{ left: `${percent}%` }"></em>
        </div>
        <span class="mw-music-time">{{ timeText }}</span>
      </div>

      <canvas ref="barCanvas" class="mw-music-bars" aria-hidden="true"></canvas>
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

/* ── 按钮 ─────────────────────────────── */
.mw-music-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
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

.mw-music-btn:hover {
  color: var(--mw-cyan);
  border-color: var(--mw-line-strong);
  transform: translateY(-1px);
}

.mw-music.is-playing .mw-music-btn {
  color: var(--mw-cyan);
  border-color: var(--mw-line-strong);
}

/* 播放时外圈呼吸光环 */
.mw-music-ring {
  position: absolute;
  inset: -4px;
  border-radius: 50%;
  border: 1px solid transparent;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.mw-music.is-playing .mw-music-ring {
  opacity: 1;
  border-color: var(--mw-line-strong);
  animation: mw-music-pulse 2.6s ease-out infinite;
}

@keyframes mw-music-pulse {
  0% {
    transform: scale(0.92);
    opacity: 0.7;
  }
  70% {
    transform: scale(1.18);
    opacity: 0;
  }
  100% {
    transform: scale(1.18);
    opacity: 0;
  }
}

.mw-music-mini {
  width: 20px;
  height: 15px;
  opacity: 0;
  transition: opacity 0.25s ease;
}

.mw-music-icon {
  position: absolute;
  width: 17px;
  height: 17px;
  transition: opacity 0.25s ease;
}

.mw-music.is-playing .mw-music-mini {
  opacity: 1;
}

.mw-music.is-playing .mw-music-icon {
  opacity: 0;
}

/* ── 展开面板 ──────────────────────────── */
.mw-music-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 14px;
  background: var(--mw-panel-flat);
  backdrop-filter: blur(12px);
  overflow: hidden;
  opacity: 0;
  transition:
    max-width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    padding 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.25s ease;
}

.mw-music.is-open .mw-music-panel {
  max-width: 330px;
  padding: 9px 13px;
  border-color: var(--mw-line);
  opacity: 1;
}

/* 旋转唱片 */
.mw-disc {
  position: relative;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  border-radius: 50%;
  background:
    repeating-radial-gradient(circle at center, rgba(255, 255, 255, 0.05) 0 1px, transparent 1px 3px),
    radial-gradient(circle at 32% 28%, #2a3540, #0c1116 70%);
  box-shadow:
    inset 0 0 0 1px var(--mw-line),
    0 2px 8px rgba(0, 0, 0, 0.35);
}

.mw-disc i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #5cf5e4, var(--mw-cyan) 55%, #00897b);
  box-shadow: 0 0 8px rgba(3, 218, 197, 0.6);
}

.mw-disc.spinning {
  animation: mw-disc-spin 4.2s linear infinite;
}

@keyframes mw-disc-spin {
  to {
    transform: rotate(360deg);
  }
}

.mw-music-main {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.mw-music-title {
  color: var(--mw-text);
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
}

.mw-music-track {
  position: relative;
  width: 132px;
  height: 4px;
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

/* 进度前端的光点 */
.mw-music-track em {
  position: absolute;
  top: 50%;
  width: 5px;
  height: 5px;
  margin: -2.5px 0 0 -2.5px;
  border-radius: 50%;
  background: #eafffb;
  box-shadow: 0 0 8px rgba(3, 218, 197, 0.9);
  opacity: 0;
  transition: opacity 0.2s ease;
}

.mw-music-track:hover em {
  opacity: 1;
}

.mw-music-time {
  color: var(--mw-text-3);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.mw-music-bars {
  width: 52px;
  height: 22px;
  flex: 0 0 52px;
}

@media (max-width: 640px) {
  .mw-music {
    left: 12px;
    bottom: 12px;
  }

  .mw-music.is-open .mw-music-panel {
    max-width: 240px;
    padding: 7px 10px;
  }

  .mw-music-track {
    width: 96px;
  }

  .mw-music-bars {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mw-music-btn,
  .mw-music-panel {
    transition: none;
  }

  .mw-music.is-playing .mw-music-ring,
  .mw-disc.spinning {
    animation: none;
  }
}
</style>
