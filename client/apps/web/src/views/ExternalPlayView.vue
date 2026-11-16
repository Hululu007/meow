<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import VideoPlayer from '@/components/player/VideoPlayer.vue'
import { apiBase } from '@/api'

/**
 * 投屏接收页（B 类）：别人把会话投到本机后，由这个页面播放。
 *
 * <p>为什么单独一页而不是复用 PlayView：投过来的只有"一个地址 + 标题 + 弹幕地址"，
 * 没有站点/剧集表/线路表；塞进 PlayView 会让那些 null 分支扩散到全文件。
 *
 * <p>状态权威在 {@code core.CastReceiver}（接收端），本页只做两件事：
 * 轮询它的 state/position 并跟随，以及每 2s 回报本地进度。
 */
const route = useRoute()
const router = useRouter()
const player = ref<InstanceType<typeof VideoPlayer> | null>(null)

const sessionId = String(route.query.sessionId || '')
const url = String(route.query.url || '')
const title = String(route.query.title || '投屏播放')
const danmakuUrl = String(route.query.danmakuUrl || '')
const startAt = Math.max(0, Number(route.query.position || 0))
/** TV 接收时由原生层传入：接收端自己的 loopback 地址 + 令牌（不依赖已配置的后端地址）。 */
const castApi = String(route.query.castApi || '')
const ct = String(route.query.ct || '')

function apiRoot() {
  return castApi || apiBase()
}

function apiUrl(path: string, extra = '') {
  const q = [ct ? `ct=${encodeURIComponent(ct)}` : '', extra].filter(Boolean).join('&')
  return `${apiRoot()}${path}${q ? '?' + q : ''}`
}

const err = ref('')
/** 会话来源（名称 · 端类型 · IP），接收页顶部展示 */
const senderLabel = ref('')
/** 浏览器拦了有声自动播放后，改静音起播，提示用户点一下开声音 */
const mutedFallback = ref(false)
let pollTimer: number | undefined
let reportTimer: number | undefined
let seeking = false
let pollFail = 0
/** 本页是否真正起播过（避免第一条 paused 回报把静音兜底刚起的播放按停） */
let everPlayed = false

interface SessionState {
  ok?: boolean
  sessionId?: string
  state?: string
  position?: number
  duration?: number
  /** 来源：名称 + 端类型 + 远端 IP（接收端按会话记录） */
  sender?: string
  senderKind?: string
  senderHost?: string
  media?: {
    url?: string
    title?: string
    danmakuUrl?: string
  }
}

async function fetchSession(): Promise<SessionState | null> {
  try {
    const r = await fetch(apiUrl('/api/cast/session', `id=${encodeURIComponent(sessionId)}`))
    if (!r.ok) return null
    return (await r.json()) as SessionState
  } catch {
    return null
  }
}

/** 来源标签：名称（端类型 · IP）。名称里已含 PC/TV/Web 时不再重复。 */
function describeSender(st: SessionState): string {
  const name = (st.sender || '').trim()
  const kind =
    st.senderKind === 'pc' ? 'PC' : st.senderKind === 'tv' ? 'TV' : st.senderKind === 'web' ? 'Web' : ''
  const host = (st.senderHost || '').trim()
  const extra: string[] = []
  if (kind && !name.toUpperCase().includes(kind.toUpperCase())) extra.push(kind)
  if (host) extra.push(host)
  return `${name || kind || '局域网设备'}${extra.length ? '（' + extra.join(' · ') + '）' : ''}`
}

async function sendCommand(action: string, value?: number) {
  try {
    await fetch(apiUrl('/api/cast/command'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, action, value }),
    })
  } catch {
    /* 忽略 */
  }
}

function onLoaded() {
  if (startAt > 1) player.value?.seekTo(startAt)
}

function enableSound() {
  player.value?.unmute?.()
  mutedFallback.value = false
}

async function poll() {
  const st = await fetchSession()
  if (!st) {
    // 网络抖动/接收端重启：不要立刻退页，连续失败再退
    pollFail += 1
    if (pollFail >= 5) {
      cleanup()
      void router.replace('/')
    }
    return
  }
  pollFail = 0
  senderLabel.value = describeSender(st)
  if (st.ok === false || st.state === 'idle') {
    /*
     * 被新会话接管（连投/换手机）时，本页手里的 sessionId 已过期，但接收端
     * 会返回**当前**会话。直接退出首页会和新 hash 抢路由——实测：新会话的
     * location.hash 刚写进来，旧页的 replace('/') 随后把它盖掉，接收端停在
     * 首页但会话显示 playing。这里直接跟到新会话。
     */
    if (st.sessionId && st.media?.url) {
      cleanup()
      void router.replace({
        name: 'extPlay',
        query: {
          sessionId: st.sessionId,
          url: st.media.url,
          title: st.media.title || '投屏播放',
          danmakuUrl: st.media.danmakuUrl || '',
          position: String(st.position || 0),
          castApi,
          ct,
        },
      })
      return
    }
    cleanup()
    void router.replace('/')
    return
  }
  const local = player.value?.getTime?.() ?? 0
  const paused = player.value?.isPaused?.() ?? true
  if (st.state === 'paused' && !paused && everPlayed) player.value?.pause()
  if (st.state === 'playing' && paused) player.value?.play()
  // 遥控 seek：差 3s 以上才跟，避免和我们自己的回报互相拉扯
  if (
    !seeking &&
    typeof st.position === 'number' &&
    Math.abs(st.position - local) > 3
  ) {
    seeking = true
    player.value?.seekTo(st.position)
    window.setTimeout(() => (seeking = false), 1500)
  }
}

async function report() {
  const p = player.value
  if (!p || !sessionId) return
  const paused = p.isPaused?.() ?? true
  const t = p.getTime?.() ?? 0
  /*
   * 起播前不要回报 paused：PC 端自动播放会被策略拦住，静音兜底可能比第一条
   * 回报晚（实测 2s 回报 paused → 接收端把下一轮 poll 当成"遥控暂停"，
   * 静音刚起播就被按停）。只要时间走过 0，就说明真的起播过。
   */
  if (!paused || t > 0) everPlayed = true
  if (paused && !everPlayed) return
  try {
    await fetch(apiUrl('/api/cast/progress'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        state: paused ? 'paused' : 'playing',
        position: Math.round(t),
        duration: Math.round(p.getDuration?.() ?? 0),
      }),
    })
  } catch {
    /* 忽略 */
  }
}

async function exitCast() {
  await sendCommand('stop')
  cleanup()
  void router.replace('/')
}

function cleanup() {
  if (pollTimer) window.clearInterval(pollTimer)
  if (reportTimer) window.clearInterval(reportTimer)
  pollTimer = undefined
  reportTimer = undefined
}

function onError(e: { message?: string }) {
  err.value = e?.message || '播放失败'
}

/** TV 壳的返回键：接收页上没有"上一层"语义，直接停止投屏并回首页。 */
const pageBackWin = window as unknown as { __meowTvPageBack?: () => boolean }
function handlePageBack(): boolean {
  void exitCast()
  return true
}

/*
 * 播放器自己的 __meowTvConsumeBack 链会先"暂停 + 再按退出"——那是播放页的
 * 语义（回到详情页继续看）。接收页没有上一层，一次 BACK 就该结束投屏。
 * 所以在最外层再包一层：有弹层先让原链关弹层，否则直接 exitCast。
 */
const consumeWin = window as unknown as {
  __meowTvConsumeBack?: (() => boolean) | null
}
let prevConsumeBack: (() => boolean) | null = null
let backDisposed = false

function hasVisibleOverlay(): boolean {
  const nodes = document.querySelectorAll('[role="dialog"], [data-tv-scope]')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i] as HTMLElement
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.width >= 2 && r.height >= 2) return true
  }
  return false
}

function handleConsumeBack(): boolean {
  if (backDisposed) return false
  if (hasVisibleOverlay()) return prevConsumeBack ? prevConsumeBack() : false
  void exitCast()
  return true
}

onMounted(() => {
  if (!url || !sessionId) {
    void router.replace('/')
    return
  }
  pageBackWin.__meowTvPageBack = handlePageBack
  backDisposed = false
  prevConsumeBack = consumeWin.__meowTvConsumeBack ?? null
  consumeWin.__meowTvConsumeBack = handleConsumeBack
  /*
   * App 的返回键接管是按 DOM/路由判定的；页面挂 pageBack 后必须喊一声，
   * 否则壳的 __meowTvConsumeBack 不会装回来，按 BACK 直接走 goBack()。
   */
  window.dispatchEvent(new Event('meow:tv-pageback'))
  everPlayed = false
  pollTimer = window.setInterval(() => void poll(), 1200)
  reportTimer = window.setInterval(() => void report(), 2000)
  void poll()
})

onBeforeUnmount(() => {
  cleanup()
  backDisposed = true
  if (pageBackWin.__meowTvPageBack === handlePageBack) pageBackWin.__meowTvPageBack = undefined
  if (consumeWin.__meowTvConsumeBack === handleConsumeBack) {
    consumeWin.__meowTvConsumeBack = prevConsumeBack
  }
  window.dispatchEvent(new Event('meow:tv-pageback'))
})
</script>

<template>
  <div class="relative h-screen w-screen overflow-hidden bg-black text-white">
    <VideoPlayer
      v-if="url"
      ref="player"
      :src="url"
      :danmaku-url="danmakuUrl"
      :title="title"
      :auto-play="true"
      :can-cast="false"
      :muted-fallback="true"
      @loaded="onLoaded"
      @autoplay-muted="mutedFallback = true"
      @error="onError"
    />
    <div
      class="absolute left-3 top-3 z-50 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-xs text-white backdrop-blur"
    >
      <span class="max-w-[50vw] truncate">投屏播放 · {{ title }}</span>
      <span v-if="senderLabel" class="max-w-[26vw] truncate text-white/60">
        来自 {{ senderLabel }}
      </span>
      <button class="rounded bg-white/10 px-2 py-0.5 hover:bg-white/20" @click="exitCast">
        退出
      </button>
    </div>
    <div
      v-if="mutedFallback"
      class="absolute bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-black/80 px-4 py-2.5 text-xs text-white shadow-2xl backdrop-blur"
    >
      <span>浏览器要求先静音播放</span>
      <button class="rounded bg-white/10 px-2 py-1 hover:bg-white/20" @click="enableSound">
        开启声音
      </button>
    </div>
    <p v-if="err" class="absolute inset-x-0 bottom-6 z-50 text-center text-sm text-hot">
      {{ err }}
    </p>
  </div>
</template>
