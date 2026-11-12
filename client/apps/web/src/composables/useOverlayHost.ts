import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 全屏安全的 Teleport 目标。
 *
 * ## 为什么不能直接 `Teleport to="body"`（2026-11-12 实测）
 *
 * 浏览器进入 **HTML 真全屏**（`element.requestFullscreen()`）后，只渲染
 * `document.fullscreenElement` 那棵子树；挂在 `body` 上的浮层虽然还在 DOM 里、
 * `getBoundingClientRect()` 也正常（继承视口尺寸），但**一个像素都不会画**。
 *
 * 实测症状（PC 端直播页）：
 * - `document.fullscreenElement` = 播放容器；
 * - 指南面板 rect = 544×1440、"visible"、`checkVisibility()=true`；
 * - `document.elementsFromPoint(100,100)` 只有 `<video>`，截图里也只有画面；
 * - 退出全屏后同一块面板立刻可见。
 *
 * 所以全屏时要把目标换成全屏元素本身（它是 `position: fixed; inset: 0` 的
 * 视口容器，绝对定位子元素仍然贴视口边缘，`overflow-hidden` 也不会裁到
 * `inset-0` 的东西）。退出全屏再换回 body。
 *
 * 注意：`fullscreenchange` 在元素级和 document 级都会触发，这里只监听
 * document 上的——冒泡已经覆盖两种来源，且不会有重复处理。
 */
export function useOverlayHost() {
  const host = ref<Element | string>('body')

  const sync = () => {
    host.value = (document.fullscreenElement as Element | null) || 'body'
  }

  onMounted(() => {
    // 挂载时可能已经在全屏（路由恢复 / 深链直接进播放页）
    sync()
    document.addEventListener('fullscreenchange', sync)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', sync)
  })

  return host
}
