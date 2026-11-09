<script setup lang="ts">
/**
 * 居中模态对话框（遥控器友好）。
 *
 * 为什么不复用 `TileSelect`：它的菜单 Teleport 到 `body`，而 TV 的焦点是
 * `tv-nav.js` 按几何最近邻算出来的——菜单挂在 body 下，焦点不会跟过去，
 * 遥控器按右键只会在背后的磁贴间移动；而且它没有取消按钮，BACK 键也无处可退。
 *
 * 这个组件刻意做三件事：
 *   1. **不 Teleport**：留在原位，几何上就在屏幕中心，最近邻一定命中它；
 *   2. 选项是**竖排等宽全宽按钮**（对齐影视仓那个「请选择存盘类型」）——
 *      遥控器只有上下左右，竖排最不容易迷路；
 *   3. 挂到路由上（见 LibraryAddView），BACK 键天然能返回；
 *      组件内也提供「取消」并响应 Esc。
 */
import { onBeforeUnmount, onMounted, ref, nextTick } from 'vue'

const props = defineProps<{
  title: string
  /** 选项；disabled 的项显示为不可选（如尚未实现的存盘类型） */
  options: Array<{ id: string; label: string; hint?: string; disabled?: boolean }>
}>()

const emit = defineEmits<{
  (e: 'pick', id: string): void
  (e: 'close'): void
}>()

const first = ref<HTMLButtonElement>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault()
    emit('close')
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  // 初始焦点给第一个可选项：TV 上如果不设焦点，遥控器第一次按键会落到
  // 背后页面的元素上（实测：点了添加后按方向键，焦点跑到顶栏去了）
  await nextTick()
  first.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div
    class="fixed inset-0 z-[120] grid place-items-center bg-black/55 px-5 py-8"
    @click.self="emit('close')"
  >
    <!--
      data-tv-scope：把方向键收窄到弹框内。

      踩过（实测）：没有它时弹框开着、焦点框却能跑到背景 —— 按到「打开 AI 助手」
      悬浮按钮，以及按上键到 y=20 的顶栏「历史」。弹框纵向只占 186–534px，
      而 tv-nav 的几何选焦是全文档竞争的。

      同类组件 TvActionSheet / TileSelect / UpdateDialog 都标了这个，
      只有 CenterDialog 漏了。
    -->
    <div
      class="w-full max-w-[26rem] rounded-xl border border-line bg-elevated p-4 shadow-2xl"
      role="dialog"
      aria-modal="true"
      data-tv-scope
    >
      <div class="mb-3 text-center text-sm text-ink">{{ props.title }}</div>
      <div class="flex flex-col gap-2">
        <button
          v-for="(o, i) in props.options"
          :key="o.id"
          :ref="(el) => { if (i === 0 && !o.disabled) first = el as HTMLButtonElement }"
          type="button"
          class="w-full rounded-lg px-4 py-3 text-sm transition focus:outline-none"
          :class="
            o.disabled
              ? 'cursor-not-allowed bg-card text-ink-3 opacity-60'
              : 'bg-card text-ink hover:bg-card-hover focus:ring-2 focus:ring-accent'
          "
          :disabled="o.disabled"
          :title="o.hint"
          @click="!o.disabled && emit('pick', o.id)"
        >
          {{ o.label }}
          <span v-if="o.disabled" class="ml-1.5 text-[11px] opacity-80">（下版）</span>
        </button>
      </div>
      <button
        type="button"
        class="mt-3 w-full rounded-lg px-4 py-2 text-xs text-ink-3 transition hover:bg-card focus:ring-2 focus:ring-accent"
        @click="emit('close')"
      >
        取消
      </button>
    </div>
  </div>
</template>
