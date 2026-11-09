<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { tauriInvoke } from '@/api'
import { savePrefs } from '@/stores/prefs'

const emit = defineEmits<{ (e: 'close'): void }>()

const primary = ref<HTMLButtonElement>()
const busy = ref<'hide' | 'quit' | ''>('')
/** 默认不勾：只对这一次生效；勾上才写进 closeToTray 偏好 */
const remember = ref(false)

/**
 * 把选择落到 `closeToTray`。
 *
 * 不能只靠 savePrefs 的 `meow:prefs` → main.ts 桥：那是异步 IPC，
 * 选「直接退出」时进程可能先没了、文件没写上。这里再显式 await 一次
 * 同一个命令，确保 desktop-prefs.json 真写完再执行退出/隐藏。
 * 设置页开关读的是 localStorage（savePrefs 已同步更新），两边不会分叉。
 */
async function persistChoice(closeToTray: boolean) {
  savePrefs({ closeToTray })
  try {
    await tauriInvoke('desktop_set_close_to_tray', { enabled: closeToTray })
  } catch (e) {
    console.warn('[tray] 保存关闭行为偏好失败:', e)
  }
}

/** 隐藏到托盘。隐藏失败时收起弹层，至少不让提示卡在画面上。 */
async function hideToTray() {
  if (busy.value) return
  busy.value = 'hide'
  if (remember.value) await persistChoice(true)
  try {
    await tauriInvoke('desktop_hide_to_tray')
  } catch (e) {
    console.warn('[tray] 隐藏主窗口失败:', e)
  }
  // 隐藏后 WebView 还在，若不收起，重新显示时会看到这个弹层
  emit('close')
}

/** 真退出：Rust 侧走 app.exit(0)，shutdown_all() 会停止 java/ffmpeg。 */
async function quitApp() {
  if (busy.value) return
  busy.value = 'quit'
  if (remember.value) await persistChoice(false)
  try {
    await tauriInvoke('desktop_quit')
  } catch (e) {
    console.warn('[tray] 退出应用失败:', e)
    busy.value = ''
  }
}

/**
 * Esc / 点空白处按「隐藏到托盘」处理：用户刚点了 X，最接近的意图是
 * 收起窗口而不是杀掉正在跑的后端。
 */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  hideToTray()
}

onMounted(async () => {
  window.addEventListener('keydown', onKey, true)
  // 「已提示」只在弹层真的挂载后落盘（Rust 的 CloseRequested 只负责 eval）。
  void tauriInvoke('desktop_tray_hint_shown').catch((e) => {
    console.warn('[tray] 记录首次关闭提示失败:', e)
  })
  // 与 UpdateDialog 一致：初始焦点给主按钮
  await nextTick()
  primary.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div
    class="fixed inset-0 z-[130] grid place-items-center bg-black/60 px-5 py-8"
    @click.self="hideToTray"
  >
    <div
      data-tv-scope
      class="w-full max-w-[28rem] overflow-hidden rounded-xl border border-line bg-elevated shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tray-hint-title"
    >
      <div class="border-b border-line px-4 py-3">
        <div id="tray-hint-title" class="font-medium text-ink" style="font-size: var(--fs-base)">
          关闭窗口后要做什么？
        </div>
        <div class="mt-1 text-ink-3" style="font-size: var(--fs-xs)">
          隐藏到托盘后猫窝继续在后台运行，本地后端与播放进度都不会中断。
        </div>
      </div>

      <div class="px-4 py-3">
        <p class="leading-relaxed text-ink-2" style="font-size: var(--fs-xs)">
          这个提示只出现一次，之后点 X 会按设置页
          「桌面端行为 → 关闭窗口时最小化到托盘」执行；随时可以从托盘菜单退出。
        </p>
        <label class="mt-2.5 flex items-center gap-2 text-ink-2" style="font-size: var(--fs-xs)">
          <input v-model="remember" type="checkbox" class="accent-accent" />
          <span>记住我的选择（同步到设置页，以后不再询问）</span>
        </label>
      </div>

      <div class="flex gap-2 border-t border-line px-4 py-3">
        <button
          type="button"
          class="flex-1 rounded-lg bg-card px-4 py-2.5 text-ink transition hover:bg-card-hover focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
          style="font-size: var(--fs-sm)"
          :disabled="busy !== ''"
          @click="quitApp"
        >
          退出应用
        </button>
        <button
          ref="primary"
          type="button"
          class="flex-1 rounded-lg bg-accent px-4 py-2.5 font-medium text-on-accent transition hover:bg-accent-dim focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
          style="font-size: var(--fs-sm)"
          :disabled="busy !== ''"
          @click="hideToTray"
        >
          隐藏到托盘
        </button>
      </div>
    </div>
  </div>
</template>
