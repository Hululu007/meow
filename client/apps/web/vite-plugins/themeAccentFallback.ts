import type { Plugin } from 'vite'

/**
 * 把 Tailwind 的 accent 静态兜底改成主题色。
 *
 * ## 问题（2026-11-12 实测）
 *
 * Tailwind v4 给 `bg-accent/15`、`border-accent/60`、`ring-accent/40` 这类
 * 「颜色 + 透明度」工具类生成的是：
 *
 * ```css
 * .border-accent\/60 { border-color: #03dac599 }              // 静态兜底
 * @supports (color: color-mix(in lab, red, red)) {
 *   .border-accent\/60 { border-color: color-mix(in oklab, var(--color-accent) 60%, transparent) }
 * }
 * ```
 *
 * 兜底色是 **@theme 里的默认 accent（meow 青 #03dac5）写死的**。老内核
 * 不认识 `color-mix`（TV 壳的 Chromium 66，`<html data-no-color-mix="1">`），
 * 于是所有半透明 accent 一律显示成青色 —— 换 Claude/OLED 等主题只换了实心
 * 部分，胶囊底、选中框、焦点环全还是青的。之前被误判成"UA 焦点框"三次。
 *
 * ## 做法
 *
 * 构建期把 `#03dac5NN`（NN = 两位十六进制 alpha）重写成
 * `rgb(var(--color-accent-rgb) / 0.NNN)`，三元组由 tokens.css 按
 * data-style × data-mode 提供。仍然不依赖 color-mix，老内核直接生效。
 *
 * 只处理 accent：其它语义色（hot/warn/ok/player）在八套主题里差异小，
 * 而且同样写死的情况没有用户可见的错色报告，先不动。
 */
export function themeAccentFallback(): Plugin {
  const ACCENT_HEX = /#03dac5([0-9a-fA-F]{2})\b/g

  return {
    name: 'meow-theme-accent-fallback',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'asset' || !name.endsWith('.css')) continue
        const raw = typeof chunk.source === 'string'
          ? chunk.source
          : Buffer.from(chunk.source).toString('utf8')
        let count = 0
        const out = raw.replace(ACCENT_HEX, (_m, hex: string) => {
          count++
          const alpha = (parseInt(hex, 16) / 255).toFixed(3)
          return `rgb(var(--color-accent-rgb) / ${alpha})`
        })
        if (count === 0) continue
        chunk.source = out
        this.info?.(`themeAccentFallback: ${name} 重写 ${count} 处 accent 兜底`)
      }
    },
  }
}
