/**
 * 自绘标题栏的拖拽 / 双击最大化（B4）。
 *
 * 为什么不用 `data-tauri-drag-region`：
 * Tauri 2 的内置拖拽走 `core:window:allow-start-dragging` 权限，
 * 当前 capabilities 没授这个权限，实测拖不动（用户 2026-11-18 报）。
 * 这里直接调自家命令，绕开权限配置。
 *
 * 交互细节：
 * - 指针移动超过 3px 才真正开始拖拽，否则单击/双击会被系统拖拽吞掉；
 * - 按钮、链接、输入框等交互元素上不启动拖拽；
 * - Windows 的 `start_dragging` 会进入系统移动循环，鼠标松开自动结束。
 */
import { tauriInvoke } from '@/api'

const INTERACTIVE =
  'button,a,input,select,textarea,[role="button"],[data-no-drag],.window-controls'

export function isChromeInteractive(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.(INTERACTIVE)
}

export function beginWindowDrag(e: PointerEvent): void {
  if (e.button !== 0 || isChromeInteractive(e.target)) return
  const startX = e.clientX
  const startY = e.clientY
  let started = false

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }
  const onMove = (ev: PointerEvent) => {
    if (started) return
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return
    started = true
    cleanup()
    tauriInvoke('desktop_window_start_drag').catch(() => {
      /* 壳不在时静默 */
    })
  }
  const onUp = () => cleanup()

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}

export function toggleMaximizeOnDblClick(e: MouseEvent): void {
  if (isChromeInteractive(e.target)) return
  tauriInvoke('desktop_window_toggle_maximize').catch(() => {
    /* 静默 */
  })
}
