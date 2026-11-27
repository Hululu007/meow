<script setup lang="ts">
/**
 * iOS 侧载的**二级升级指引弹框**（不是"发现新版本"弹框）。
 *
 * ## 层级关系（2026-11-27 用户口径）
 * 1. 通用 `UpdateDialog` 照常弹「发现新版本」（版本 / 日志 / 更新·稍后）—— 与 PC/TV 一致；
 * 2. iOS 上点「更新」→ **在本弹框之上**再叠这一层，给出两条可复制链接
 *    （正式 IPA 直链 + 侧载商店源），因为 iOS 不能像 PC/TV 那样自装。
 *
 * 它只在 `UpdateDialog` 内部 `showIosGuide` 为真时挂载（v-if），z-[140] 盖在
 * 通用弹框（z-[130]）之上。关闭只收自己（emit close），**不碰 store 的对话框
 * 状态** —— 下面的"发现新版本"弹框要继续留着，用户还能点稍后。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { currentVersion } from '@/api/appUpdate'
import { found } from '@/stores/appUpdate'

const emit = defineEmits<{ (e: 'close'): void }>()

/** 当前安装版本（iOS 读 meowIos.version） */
const currentAppVersion = currentVersion()
/** 图标路径（fpk 挂在 /app/meow/ 下，必须走 BASE_URL；模板里不能写 import.meta） */
const iconSrc = `${import.meta.env.BASE_URL}icon-192.png`
/** 刚复制过哪条链接（给按钮一个"已复制"反馈） */
const copiedKey = ref('')
/** 主按钮引用（初始焦点） */
const primary = ref<HTMLButtonElement>()

/** 复制文本：老 WebView 无 clipboard API 时用 textarea + execCommand 兜底 */
async function copyLink(key: string, text: string): Promise<void> {
  if (!text) return
  let ok = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      ok = true
    }
  } catch {
    /* 落兜底 */
  }
  if (!ok) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      // iOS 上 textarea 必须在视口内且不可见，否则 execCommand 复制无效
      ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      ok = false
    }
  }
  copiedKey.value = ok ? key : ''
  if (ok) window.setTimeout(() => { if (copiedKey.value === key) copiedKey.value = '' }, 1800)
}

/**
 * 返回键 / Esc：只收这一层指引弹框，不碰下面的"发现新版本"。
 * 本组件是叠在 UpdateDialog 之上的，UpdateDialog 也抢了 `__meowTvConsumeBack`；
 * 这里挂上时覆盖它，卸载时还原 UpdateDialog 的那个（prevBackHandler）。
 */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault()
    emit('close')
  }
}
let prevBackHandler: (() => boolean) | null = null
onMounted(async () => {
  window.addEventListener('keydown', onKey)
  const w = window as unknown as { __meowTvConsumeBack?: (() => boolean) | null }
  prevBackHandler = w.__meowTvConsumeBack || null
  w.__meowTvConsumeBack = () => {
    emit('close')
    return true
  }
  await nextTick()
  primary.value?.focus()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  const w = window as unknown as { __meowTvConsumeBack?: (() => boolean) | null }
  w.__meowTvConsumeBack = prevBackHandler
  prevBackHandler = null
})
</script>

<template>
  <!-- z-[140]：盖在通用 UpdateDialog(z-[130]) 之上 -->
  <div
    class="fixed inset-0 z-[140] grid place-items-center bg-black/70 px-5 py-8"
    @click.self="emit('close')"
  >
    <div
      data-tv-scope
      class="glass-panel w-full max-w-[30rem] overflow-hidden rounded-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ios-guide-title"
    >
      <div class="flex items-center gap-3 border-b border-line px-4 py-3">
        <img :src="iconSrc" alt="" width="40" height="40" class="h-10 w-10 shrink-0 rounded-[10px] object-cover" />
        <div class="min-w-0 flex-1">
          <div id="ios-guide-title" class="text-sm font-medium text-ink">iOS 升级指引</div>
          <div class="mt-1 text-[12px] text-ink-3">从 v{{ currentAppVersion }} 升级到 v{{ found?.version }}</div>
        </div>
      </div>

      <div class="space-y-2 px-4 py-3">
        <p class="text-[11px] leading-relaxed text-ink-3">
          iOS 不允许 App 自行安装 IPA。复制下面的链接，在 LiveContainer / SideStore 中刷新源或重新导入即可更新。
        </p>
        <div class="rounded-lg bg-card px-3 py-2">
          <div class="text-[11px] font-medium text-ink-2">正式版 IPA 直链（始终指向最新版）</div>
          <div class="mt-1 break-all font-mono text-[11px] text-ink-3">{{ found?.fixedUrl }}</div>
          <button
            type="button"
            class="mt-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] text-on-accent hover:bg-accent-dim focus:outline-none focus:ring-2 focus:ring-accent"
            @click="copyLink('fixed', found?.fixedUrl || '')"
          >{{ copiedKey === 'fixed' ? '已复制' : '复制直链' }}</button>
        </div>
        <div class="rounded-lg bg-card px-3 py-2">
          <div class="text-[11px] font-medium text-ink-2">侧载商店源（AltStore / SideStore / LiveContainer）</div>
          <div class="mt-1 break-all font-mono text-[11px] text-ink-3">{{ found?.sourceUrl }}</div>
          <button
            type="button"
            class="mt-1.5 rounded-md bg-accent px-2.5 py-1 text-[11px] text-on-accent hover:bg-accent-dim focus:outline-none focus:ring-2 focus:ring-accent"
            @click="copyLink('source', found?.sourceUrl || '')"
          >{{ copiedKey === 'source' ? '已复制' : '复制源地址' }}</button>
        </div>
      </div>

      <div class="flex gap-2 border-t border-line px-4 py-3">
        <button
          ref="primary"
          type="button"
          class="flex-1 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-on-accent transition hover:bg-accent-dim focus:outline-none focus:ring-2 focus:ring-accent"
          @click="emit('close')"
        >知道了</button>
      </div>
    </div>
  </div>
</template>
