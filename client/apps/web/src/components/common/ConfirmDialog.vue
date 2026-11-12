<script setup lang="ts">
/**
 * 应用内确认 / 提示弹框（遥控器可用）。
 *
 * 挂载点在 App.vue，调用方只 `await confirmDialog('...')`，见
 * composables/useConfirm.ts 里的说明（为什么不用原生 confirm）。
 *
 * ★ 三条与原生弹框必须一致的保证：
 *   1. **阻塞语义不变**：调用方拿到的仍是"点了确定才为真"的结果，
 *      `if (!(await confirmDialog(...))) return` 可以直接替换原来的写法；
 *   2. **Esc / BACK 等于取消**，点遮罩空白处也等于取消（和原生一致）；
 *   3. **TV 焦点落在「取消」**：危险操作一按 OK 就删掉太容易误触。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { dialogState, settleDialog } from '@/composables/useConfirm'
import { useOverlayHost } from '@/composables/useOverlayHost'

/** 全屏（播放页）时 Teleport 目标要换成全屏元素，否则一个像素都不画 */
const host = useOverlayHost()

const cancelBtn = ref<HTMLButtonElement>()
const okBtn = ref<HTMLButtonElement>()

/**
 * 开框后一小段时间内忽略点击。
 *
 * <p>弹框出现在屏幕正中，而触发的那个按钮（历史/收藏封面右上角的 ×）
 * 位置是随列表滚动变的 —— 滚到中间那一行时，× 和新弹框的「确定」可能只差
 * 几十像素。用户"点了没反应就再点一下"时，第二下会直接落在「确定」上，
 * 表现就是"弹框一闪，东西已经删了"。300ms 足够挡住这种第二击，
 * 又不影响正常操作。
 */
const armed = ref(false)
let armTimer: number | undefined

function ok() {
  if (armed.value) settleDialog(true)
}
function cancel() {
  if (armed.value) settleDialog(false)
}

function onKey(e: KeyboardEvent) {
  if (!dialogState.open) return
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }
}

watch(
  () => dialogState.open,
  async (open) => {
    window.clearTimeout(armTimer)
    if (!open) return
    armed.value = false
    await nextTick()
    const target = dialogState.kind === 'confirm' ? cancelBtn.value : okBtn.value
    target?.focus()
    armTimer = window.setTimeout(() => {
      armed.value = true
    }, 300)
  },
)

onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => {
  window.clearTimeout(armTimer)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <Teleport :to="host">
    <div
      v-if="dialogState.open"
      class="fixed inset-0 z-[140] grid place-items-center bg-black/55 px-5 py-8"
      @click.self="cancel"
    >
      <!-- data-tv-scope：把遥控方向键收窄到弹框内（tv-nav 的几何选焦是全文档竞争） -->
      <div
        class="flex max-h-[calc(100dvh-4rem)] w-full max-w-[24rem] flex-col rounded-xl border border-line bg-elevated p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        data-tv-scope
      >
        <div v-if="dialogState.title" class="shrink-0 text-[15px] font-semibold text-ink">
          {{ dialogState.title }}
        </div>
        <!--
          长文案在横屏矮视口（高 320px）会顶出屏幕：正文自己滚，标题与按钮
          固定 —— 原来卡片既没有 max-height 也没有 overflow，确认不了也关不掉
          （2026-11-12 审计）。
        -->
        <p
          class="min-h-0 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-ink-2"
          :class="dialogState.title ? 'mt-2' : ''"
        >
          {{ dialogState.message }}
        </p>
        <div class="mt-5 flex shrink-0 justify-end gap-2">
          <button
            v-if="dialogState.kind === 'confirm'"
            ref="cancelBtn"
            type="button"
            class="h-11 rounded-lg px-4 text-sm text-ink-2 transition hover:bg-card-hover focus:outline-none focus:ring-2 focus:ring-accent"
            :data-tv-first="true"
            @click="cancel"
          >
            {{ dialogState.cancelText }}
          </button>
          <button
            ref="okBtn"
            type="button"
            class="h-11 rounded-lg px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-accent"
            :class="
              dialogState.danger
                ? 'bg-hot text-on-hot hover:bg-hot/85'
                : 'bg-accent text-on-accent hover:bg-accent-dim'
            "
            :data-tv-first="dialogState.kind === 'alert' ? true : undefined"
            @click="ok"
          >
            {{ dialogState.okText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
