import type { Plugin } from 'vite'

/**
 * 把产物 CSS 里的 `@layer` 展开成普通规则。
 *
 * Tailwind v4 会把 83% 的样式（805 条工具类）包进 `@layer utilities{...}`。
 * Chrome 99 以下不认识 `@layer`，解析到该 at-rule 时**整块丢弃**——
 * `.flex` / `.grid` / `.absolute` / `.w-full` 全部消失，页面 DOM 正常但
 * 一点布局和配色都没有。配上 TV 壳的纯黑 windowBackground，表现就是
 * 「配置正常、进去全黑、没有任何提示」且**不产生任何 JS 错误**
 * （所以 onReceivedError 与加载看门狗都兜不住）。
 *
 * 实测：Android 9 的极米 Z6X Pro 出厂 WebView 就是 Chromium 66–69，
 * 国内投影仪没有 Play 商店更新通道，永久停在老内核。
 *
 * 展平是有损的——原来靠 layer 顺序解决的优先级会变成源码顺序。
 * 但 Tailwind 生成时本来就是按 properties → theme → base → components →
 * utilities 的顺序输出的，展平后顺序不变，实际优先级一致。
 */
export function flattenCssLayers(): Plugin {
  return {
    name: 'meow-flatten-css-layers',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'asset' || !name.endsWith('.css')) continue
        const raw = typeof chunk.source === 'string'
          ? chunk.source
          : Buffer.from(chunk.source).toString('utf8')
        let src = raw
        if (src.includes('@layer')) src = flatten(src)
        // ★ 必须在展平之后、且对**所有**产物做：压缩器会把
        //   `top:0;right:0;bottom:0;left:0` 合并回 `inset:0`，
        //   等于把降级层又改回了它在绕开的东西（实测见 unshortenLogical）。
        src = unshortenLegacy(src)
        if (src !== raw) {
          chunk.source = src
          this.info?.(
            `flattenCssLayers: ${name} ${raw.length} → ${src.length} bytes`,
          )
        }
      }
    },
  }
}

/**
 * 把降级层里被压缩器合并回简写的逻辑属性重新展开。
 *
 * ★ 这是一个自反的坑：降级层的存在就是为了绕开 Chrome 66 不认的
 *   `inset` / `margin-inline` 等简写，而 CSS 压缩器看到
 *   `top:0;right:0;bottom:0;left:0` 会"贴心"地合并成 `inset:0`——
 *   于是降级规则原封不动地失效了，而且构建全程无任何报错。
 *
 * 实测（投影仪 Chrome 66）：播放页的 `div.absolute.inset-0` 算出来 0×0，
 * 里面 `h-full w-full` 的 `<video>` 跟着塌成 0×0；但 video 的
 * `videoWidth=1440`、`currentTime` 照常推进、`drawImage` 也能画出帧。
 * 表现就是「只有声音没有画面 / 音画不同步」，非常容易误判成解码问题。
 *
 * 只处理带 `[data-legacy-css` 前缀的选择器：原生工具类的 `inset:0` 是
 * 给新内核用的，动它没有意义还会增大体积。
 */
function unshortenLegacy(css: string): string {
  // 逐个规则块扫描；只在选择器含 data-legacy-css 且声明里有简写时改写
  return css.replace(/([^{}]*\{(?:[^{}])*?\})/g, (rule) => {
    if (!rule.includes('data-legacy-css')) return rule
    const brace = rule.indexOf('{')
    if (brace < 0) return rule
    const sel = rule.slice(0, brace)
    let body = rule.slice(brace + 1, rule.lastIndexOf('}'))
    if (body.indexOf('inset') < 0) return rule

    // inset: <v>            → top/right/bottom/left
    // inset: <v> <h>        → 上=下=v，左右=h
    // inset: <t> <h> <b>    → 上=t 左右=h 下=b
    // inset: <t> <r> <b> <l>
    body = body.replace(
      /(^|;)\s*inset\s*:\s*([^;]+)/g,
      (_m, lead, val) => {
        const parts = String(val).trim().split(/\s+/)
        if (parts.length === 1) {
          const v = parts[0]
          return `${lead}top:${v};right:${v};bottom:${v};left:${v}`
        }
        if (parts.length === 2) {
          const [v, h] = parts
          return `${lead}top:${v};right:${h};bottom:${v};left:${h}`
        }
        if (parts.length === 3) {
          const [t, h, b] = parts
          return `${lead}top:${t};right:${h};bottom:${b};left:${h}`
        }
        const [t, r, b, l] = parts
        return `${lead}top:${t};right:${r};bottom:${b};left:${l}`
      },
    )
    // inset-inline / inset-block 同理
    body = body.replace(/(^|;)\s*inset-inline\s*:\s*([^;]+)/g, (_m, lead, v) => {
      const p = String(v).trim().split(/\s+/)
      return `${lead}left:${p[0]};right:${p[1] ?? p[0]}`
    })
    body = body.replace(/(^|;)\s*inset-block\s*:\s*([^;]+)/g, (_m, lead, v) => {
      const p = String(v).trim().split(/\s+/)
      return `${lead}top:${p[0]};bottom:${p[1] ?? p[0]}`
    })
    return sel + '{' + body + '}'
  })
}

/** 把 @layer a, b; 语句删掉，把 @layer x { ... } 块的花括号去掉、内容提升到原位置 */
function flatten(css: string): string {
  let out = ''
  let i = 0
  const n = css.length
  while (i < n) {
    const at = css.indexOf('@layer', i)
    if (at < 0) {
      out += css.slice(i)
      break
    }
    out += css.slice(i, at)

    // 读取层名与后续字符，判断是语句（;）还是块（{）
    let j = at + '@layer'.length
    while (j < n && /\s/.test(css[j])) j++
    let nameEnd = j
    while (nameEnd < n && /[\w\-, \t]/.test(css[nameEnd])) nameEnd++
    let k = nameEnd
    while (k < n && /\s/.test(css[k])) k++

    if (css[k] === ';') {
      // @layer a, b; —— 纯声明，直接删除
      i = k + 1
      continue
    }
    if (css[k] !== '{') {
      // 不是我们认识的形态，原样保留这个字符避免死循环
      out += css[at]
      i = at + 1
      continue
    }

    // 块形式：找到配对右花括号，把内部内容原样提升
    let depth = 0
    let p = k
    let end = n
    while (p < n) {
      const c = css[p]
      if (c === '/' && css[p + 1] === '*') {
        const close = css.indexOf('*/', p + 2)
        p = close < 0 ? n : close + 2
        continue
      }
      if (c === '"' || c === "'") {
        const q = c
        p++
        while (p < n) {
          if (css[p] === '\\') {
            p += 2
            continue
          }
          if (css[p] === q) break
          p++
        }
        p++
        continue
      }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          end = p
          break
        }
      }
      p++
    }
    out += css.slice(k + 1, end)
    i = end + 1
  }
  return out
}
