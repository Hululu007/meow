import { onBeforeUnmount, ref } from 'vue'

/**
 * 系统「减少动态效果」开关（`prefers-reduced-motion: reduce`）。
 *
 * <p>**专为动图 WebP 而写**：CSS 动画能被 `@media (prefers-reduced-motion)` 关掉，
 * 但图片内部的帧动画不受任何 CSS 约束 —— 只能换源（动图 ↔ 静态图）。
 *
 * <p>用法：`const reduce = useReducedMotion()`，模板里按 `reduce` 换 `src`。
 * 会在组件卸载时自动摘监听。
 */
export function useReducedMotion() {
  const reduce = ref(false)
  /** 非浏览器环境（SSR / 单测没装 matchMedia）下保持 false，不动源 */
  let mql: MediaQueryList | null = null

  function onChange(e: MediaQueryListEvent) {
    reduce.value = e.matches
  }

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduce.value = mql.matches
    mql.addEventListener('change', onChange)
  }

  onBeforeUnmount(() => {
    mql?.removeEventListener('change', onChange)
    mql = null
  })

  return reduce
}
