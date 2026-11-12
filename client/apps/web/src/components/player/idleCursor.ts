/**
 * 全屏播放时的「空闲隐藏光标」逻辑（Web / PC / TV 共用）。
 *
 * ## 为什么单独抽出来
 *
 * 这段逻辑要同时满足三件事：只在全屏生效、鼠标空闲 N 秒才隐藏、任何指针
 * 活动立刻恢复。直接写在 6000 行的 VideoPlayer 里没法单测，而这类"定时器
 * + 状态翻转"的代码最容易在改动中悄悄坏掉（例如退出全屏后光标一直藏着）。
 *
 * ## 为什么还要原生 API（PC）
 *
 * 样式层的 `cursor: none` 在 WebView2 的某些全屏合成场景不会传给窗口系统，
 * 指针会残留；桌面端另外调 Tauri 的 `setCursorVisible`。这里只负责算
 * "该不该隐藏"，具体怎么隐藏由 `apply` 决定。
 */
export interface IdleCursorOptions {
  /** 当前是否处于播放器全屏（原生全屏或伪全屏） */
  isFullscreen: () => boolean
  /** 当前环境是否适合隐藏光标（触摸/电视不隐藏） */
  canHide: () => boolean
  /** 应用隐藏状态：hidden=true 隐藏，false 恢复 */
  apply: (hidden: boolean) => void
  /** 空闲多久后隐藏，默认 3000ms */
  idleMs?: number
}

export interface IdleCursor {
  /** 任何指针活动（move/down）：立刻恢复并重新计时 */
  activity: () => void
  /** 退出全屏/卸载：清定时器并恢复 */
  stop: () => void
  /** 当前是否隐藏（测试用） */
  isHidden: () => boolean
}

export function createIdleCursor(opts: IdleCursorOptions): IdleCursor {
  const idleMs = opts.idleMs ?? 3000
  let timer: ReturnType<typeof setTimeout> | undefined
  let hidden = false

  const set = (next: boolean) => {
    if (hidden === next) return
    hidden = next
    opts.apply(next)
  }

  return {
    activity() {
      // 非全屏 / 触摸环境：保持光标可见，也不排定时器
      if (!opts.isFullscreen() || !opts.canHide()) {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        set(false)
        return
      }
      if (hidden) set(false)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        set(true)
      }, idleMs)
    },
    stop() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      set(false)
    },
    isHidden() {
      return hidden
    },
  }
}
