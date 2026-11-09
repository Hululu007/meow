/**
 * 全局媒体互斥（2026-11-02）。
 *
 * ## 为什么需要它
 *
 * 用户报「操作切换下一集、切换线路、返回后重新播放的过程中，会出现旧视频
 * 声音还在响、同时又显示刚切进来的视频」，即**两路音轨叠加**。
 *
 * 逐条排查后，能产生重叠的路径有四条，前三条已在各自位置修掉：
 *   1. 卸载播放器时媒体元素被摘出文档但不等停（Android WebView 典型行为）
 *      → `VideoPlayer.stopMedia()`
 *   2. 同一个 `<video>` 换源，旧缓冲继续播到末尾 → 同上
 *   3. 原生播放器（ExoPlayer）盖上来，WebView 页面**没卸载**，`<video>` 照放
 *      → TV 壳 `MainActivity.onPause()` 调本文件的钩子
 *   4. **兜底**：以上任何一条漏了，或将来新写了个播放器忘了调 stopMedia
 *
 * 这一层就是第 4 条：**任何媒体元素开始播放时，主动暂停页面上其它所有
 * 媒体元素**。它不依赖任何组件记得清理自己，是"结构上不可能重叠"的那道保险。
 *
 * ## 为什么用事件捕获而不是改每个播放器
 *
 * `play` 事件不冒泡，但**会经过捕获阶段**。在 document 上以 capture 监听，
 * 任何层级、任何来源（video / audio / 动态创建的 / 第三方库的）开始播放
 * 都能被拦到，且不需要播放器配合。
 *
 * ## 为什么不直接调用对方的 pause() 就完事
 *
 * 对已经被摘出文档、或 `preload=none` 的元素，`pause()` 可能不生效。
 * 所以对被勒令停止的那个元素做"三重静音"：pause + muted + 摘 src，
 * 与 VideoPlayer.stopMedia 同一套判据（那里有详细注释）。
 */

/** 被本次前台切换静音过的元素，恢复时按需还原 muted */
const silenced = new WeakSet<HTMLMediaElement>()

function hardStop(el: HTMLMediaElement): void {
  try {
    if (!el.paused) el.pause()
  } catch {
    /* 元素不可用 */
  }
  /*
   * ★ 不摘 src：这个元素可能马上还要用（比如用户立刻切回来）。
   *   摘 src 会让它重新走一次加载，代价比"多一段缓冲"大得多。
   *   真正要防的是"出声"，muted 就够；媒体元素被永久丢弃的场景
   *   已由组件自己的 stopMedia() 覆盖。
   */
  try {
    if (!el.muted) {
      el.muted = true
      silenced.add(el)
    }
  } catch {
    /* 同上 */
  }
}

function otherMedia(current: HTMLMediaElement): HTMLMediaElement[] {
  const out: HTMLMediaElement[] = []
  const all = document.querySelectorAll('video,audio')
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLMediaElement
    if (el !== current && !el.paused) out.push(el)
  }
  return out
}

let installed = false

export function installMediaExclusivity(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  // ① 捕获阶段拦 play：谁开始播，就把其它在播的全停掉
  document.addEventListener(
    'play',
    (e) => {
      const el = e.target as HTMLMediaElement | null
      if (!el || typeof el.pause !== 'function') return
      // 自己是被别处恢复静音的，先还原（用户点了播放就是想听）
      if (silenced.has(el) && el.muted) {
        el.muted = false
        silenced.delete(el)
      }
      for (const other of otherMedia(el)) hardStop(other)
    },
    true,
  )

  /**
   * TV 壳的暂停/恢复钩子。
   *
   * 由 `MainActivity.onPause()/onResume()` 通过 evaluateJavascript 调用。
   * 这一对解决的是"原生播放器（另一个 Activity）盖上来时 WebView 页面
   * 根本没卸载"——组件里的 onBeforeUnmount / stopMedia 一次都不会跑。
   *
   * 记住"暂停是不是我们干的"很重要：用户自己按暂停后切后台再回来，
   * 不应该被我们自作主张地恢复播放。
   */
  const w = window as unknown as Record<string, unknown>
  let pausedBySystem = false

  w.__meowWebviewPause = () => {
    pausedBySystem = false
    const all = document.querySelectorAll('video,audio')
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as HTMLMediaElement
      if (!el.paused) {
        try {
          el.pause()
          pausedBySystem = true
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  w.__meowWebviewResume = () => {
    if (!pausedBySystem) return
    pausedBySystem = false
    const all = document.querySelectorAll('video,audio')
    for (let i = 0; i < all.length; i++) {
      const el = all[i] as HTMLMediaElement
      // 只恢复当前页面里显然还活着的那一个（在文档里、有源）
      if (el.isConnected && (el.currentSrc || el.src)) {
        try {
          void el.play()?.catch(() => {})
        } catch {
          /* 忽略 */
        }
      }
    }
  }
}
