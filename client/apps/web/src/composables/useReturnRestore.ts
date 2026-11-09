import { onActivated, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

/**
 * 页面返回时恢复滚动位置与本页焦点。
 *
 * <p><b>为什么需要它</b>：TV 上从首页点海报进详情、按返回，首页会回到顶部
 * （`router` 的 `scrollBehavior` 原来一律 `{ top: 0 }`）。用户刚看的那一屏没了，
 * 得重新按十几次方向键找回原位置。收藏、历史、片库、搜索结果同理。
 *
 * <p><b>为什么不能只靠 router 的 savedPosition</b>：它只记住 window 的
 * `scrollX/Y`。而 TV 上真正滚动的经常是**页面内部的某个 div**
 * （设置页右栏、弹层内容区），window 的 scrollY 恒为 0 —— savedPosition
 * 永远是 `{top:0}`，等于没恢复。
 *
 * <p><b>做法</b>：
 * <ol>
 *   <li>卸载时记住"滚动量最大的那个容器"的 scrollTop（找不到就用 window）</li>
 *   <li>以及当前 `.meow-tv-focus` 元素的选择器路径</li>
 *   <li>重新挂载时恢复两者；焦点元素找不到就退回原来的元素</li>
 * </ol>
 *
 * <p><b>为什么不恢复焦点到"第 N 个卡片"</b>：列表可能在返回时被重新拉取
 * （首页每次进来都会 refresh），顺序可能变。用元素自身可识别的特征
 * （seen 选择器路径）更稳；找不到就只恢复滚动，至少位置对。
 */
export function useReturnRestore(key: string): void {
  const storageKey = `meow.restore.${key}`

  /** 找当前滚动量最大的可见容器（含 window）。 */
  function activeScroller(): { el: HTMLElement | null; top: number } {
    const winTop =
      window.scrollY ||
      (document.scrollingElement ? document.scrollingElement.scrollTop : 0) ||
      document.documentElement.scrollTop ||
      0
    let best: HTMLElement | null = null
    let bestTop = winTop
    const nodes = document.querySelectorAll('main *, body > div *')
    for (let i = 0; i < nodes.length; i++) {
      const e = nodes[i] as HTMLElement
      if (!e.scrollTop) continue
      const oy = getComputedStyle(e).overflowY
      if (oy !== 'auto' && oy !== 'scroll') continue
      if (e.scrollTop > bestTop) {
        best = e
        bestTop = e.scrollTop
      }
    }
    return { el: best, top: bestTop }
  }

  /**
   * 给"当前焦点元素"生成一个稳定的路径。
   *
   * <p>优先用能唯一识别它的属性（data-* / id / href），实在没有就用
   * "父元素 nth-child 链"——后者在列表重排后会失效，所以只是兜底。
   */
  function focusPath(): string {
    const el = document.querySelector('.meow-tv-focus')
    if (!el || !(el instanceof HTMLElement)) return ''
    const ds = el.dataset || {}
    for (const k of Object.keys(ds)) {
      if (k === 'tvScope' || k === 'tvScroll' || k === 'tvFirst') continue
      if (ds[k]) return `[data-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}="${ds[k]}"]`
    }
    if (el.id) return '#' + el.id
    const href = el.getAttribute('href')
    if (href) return `${el.tagName.toLowerCase()}[href="${href}"]`
    // 兜底：从 main 往下数 nth-child
    const parts: string[] = []
    let cur: HTMLElement | null = el
    while (cur && cur !== document.body && parts.length < 6) {
      const parent: HTMLElement | null = cur.parentElement
      if (!parent) break
      const idx = Array.prototype.indexOf.call(parent.children, cur) + 1
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`)
      cur = parent
    }
    return parts.join(' > ')
  }

  function save(): void {
    try {
      const s = activeScroller()
      const payload = {
        top: s.top,
        // 记录是哪个容器：用它的 class 前缀做标记，恢复时重新找
        cls: s.el ? s.el.className : '',
        focus: focusPath(),
      }
      sessionStorage.setItem(storageKey, JSON.stringify(payload))
    } catch {
      /* sessionStorage 不可用（隐私模式）就不恢复，不影响主流程 */
    }
  }

  function restore(): void {
    let payload: { top?: number; cls?: string; focus?: string } | null = null
    try {
      const raw = sessionStorage.getItem(storageKey)
      if (!raw) return
      payload = JSON.parse(raw)
      // 用一次就清掉：下次"新导航"进来不该还停在旧位置
      sessionStorage.removeItem(storageKey)
    } catch {
      return
    }
    if (!payload) return
    /*
     * 恢复要重试：列表数据是异步拉的（首页 boot 后才有卡片），
     * 而内容撑开后才有可能滚到目标位置。只等两帧在 TV 上不够 ——
     * 实测冷启动要 1~2 秒才出首屏数据，两帧（~32ms）时容器还没有滚动高度。
     *
     * 所以按"直到滚到位或超时"重试：每 120ms 试一次，最多 2 秒。
     * 判据是 scrollTop 真的设进去了（差值在几像素内），不是"调用过"。
     */
    let tries = 0
    const attempt = () => {
      tries++
      {
        try {
          if (payload!.cls) {
            // 按 class 找同一个容器（取首个匹配，足够区分"右栏/内容区"这类）
            const first = payload!.cls.split(/\s+/).filter(Boolean)[0]
            if (first) {
              const el = document.querySelector('.' + CSS.escape(first)) as HTMLElement | null
              if (el && el.scrollHeight > el.clientHeight) {
                el.scrollTop = payload!.top!
              }
            }
          }
          if (!payload!.cls) {
            window.scrollTo(0, payload!.top!)
          }
          const now =
            window.scrollY ||
            (document.scrollingElement ? document.scrollingElement.scrollTop : 0)
          const scrollDone = Math.abs(now - payload!.top!) < 8
          /*
           * ★ 焦点是否恢复成功，要单独判。
           *
           * 踩过（2026-10-30 实测「片库页添加弹框返回没聚焦到原位置」）：
           * 原来只判 window 滚动量是否到位，`top` 为 0 时首帧就 scrollDone=true，
           * 于是**立刻停止重试**——可那一刻目标按钮还没渲染出来，
           * `querySelector` 命中不到，focus 就永远没恢复。
           * 表现：sessionStorage 里的记录被正常消费了，焦点却落在别处。
           */
          let focusDone = !payload!.focus
          if (payload!.focus) {
            const target = document.querySelector(payload!.focus)
            if (target && (target as HTMLElement).getBoundingClientRect().width > 2) {
              /*
               * 走 `__meowTvFocus` 而不是手动加 class。
               *
               * 手动 `classList.add('meow-tv-focus')` 只画框，**不会同步 tv-nav
               * 内部的 current 索引**；下一次按方向键时它会从旧索引（通常是 -1）
               * 出发算几何，表现为"按一下方向键，焦点从别处开始跳"。
               * `__meowTvFocus` 内部就是 `highlight()`，两件事一起做。
               */
              const w = window as unknown as {
                __meowTvFocus?: (t: Element, pin?: boolean) => boolean
              }
              if (typeof w.__meowTvFocus === 'function') {
                // pin=true：挡住 initialFocus 的两次兜底落点（否则恢复完立刻被改）
                if (w.__meowTvFocus(target, true)) focusDone = true
              } else {
                // 非 TV 环境（没有 tv-nav）：手动标一下，浏览器里也只是视觉提示
                document.querySelectorAll('.meow-tv-focus').forEach((e) => {
                  e.classList.remove('meow-tv-focus')
                })
                target.classList.add('meow-tv-focus')
                focusDone = true
              }
            }
          }
          if ((!scrollDone || !focusDone) && tries < 17) window.setTimeout(attempt, 120)
        } catch {
          /* 恢复失败不影响页面本身 */
          if (tries < 17) window.setTimeout(attempt, 120)
        }
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(attempt))
  }

  onMounted(() => {
    restore()
    window.addEventListener('pagehide', save)
  })
  /*
   * ★ 关键：必须在**离开路由之前**保存。
   *
   * 踩过（实测）：只靠 onUnmounted 保存时，那一刻路由已经切走了
   * （`route.path` 已经是新页面），而 activeScroller() 是在当前 DOM 上量的 ——
   * 新页面还没渲染出内容，量到的是 0，于是"位置恢复"永远恢复成顶部。
   * onBeforeRouteLeave 触发时旧 DOM 还在，量到的才是用户真正看到的位置。
   */
  onBeforeRouteLeave(() => {
    save()
  })
  onUnmounted(() => {
    // 兜底：非路由原因卸载（切站、注销）也记一下
    window.removeEventListener('pagehide', save)
  })
  // keep-alive 场景（目前没用，留着以防将来给列表页加）
  onActivated(restore)
}
