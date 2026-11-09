import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 构建产物的老内核兼容性回归。
 *
 * 背景：TV 端在 Android 9（Chrome 66）设备上黑屏，根因是 Tailwind v4 把
 * 83% 的样式包进 `@layer`，Chrome 99 以下遇到该 at-rule 会整块丢弃——
 * 页面 DOM 正常、图片正常、onPageFinished 正常回调，所以既不报错也没有提示。
 *
 * 这些断言直接读 dist，构建出问题立刻失败。跑之前需要先 `pnpm build`。
 */
const DIST = join(__dirname, '..', 'dist', 'assets')

function cssFiles(): string[] {
  if (!existsSync(DIST)) return []
  return readdirSync(DIST).filter((f) => f.endsWith('.css'))
}

function jsFiles(): string[] {
  if (!existsSync(DIST)) return []
  return readdirSync(DIST).filter((f) => f.endsWith('.js'))
}

describe('构建产物：老内核（Chrome 66）兼容性', () => {
  it('dist 存在（先跑 pnpm build）', () => {
    expect(existsSync(DIST), 'dist/assets 不存在，无法验证产物').toBe(true)
    expect(cssFiles().length).toBeGreaterThan(0)
  })

  it('CSS 里不能出现 @layer —— Chrome 99 以下会丢掉整块规则', () => {
    // ★ 判据是"有没有真正的 at-rule"，不是"出现这几个字"。
    //
    // 踩过两次误报：
    //   1. tokens.css / legacy-css.css 里有大量解释"为什么必须写在 @layer
    //      之外"的注释。构建链（flattenCssLayers + 压缩器）不保证把注释
    //      全删掉，于是 includes('@layer') 命中注释，断言失败——但产物里
    //      一个 at-rule 都没有。
    //   2. 若照误报去删注释，等于把"为什么这么写"的来由删掉，
    //      下一个改样式的人还会再踩一次。
    //
    // 所以先剥注释，再精确匹配 at-rule 形式：`@layer` 后跟名字/花括号/分号。
    // 只写注释里提到 `@layer` 不会命中。
    const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
    const hasRealLayerRule = (css: string) =>
      /@layer\s*([\w-]+\s*[,;{]|\{)/.test(stripComments(css))
    const bad = cssFiles().filter((f) => hasRealLayerRule(readFileSync(join(DIST, f), 'utf8')))
    // 失败信息要直接指向修复手段，不然下一个人只会看到文件名
    expect(bad, `这些产物含 @layer 声明：${bad.join(', ')}。检查 vite-plugins/flattenCssLayers.ts 是否还被 vite.config 引用`).toEqual([])
  })

  it('核心工具类必须真的在产物里（展平不能把它们弄丢）', () => {
    const all = cssFiles()
      .map((f) => readFileSync(join(DIST, f), 'utf8'))
      .join('\n')
    for (const cls of ['.flex{', '.grid{', '.hidden{', '.absolute{', '.w-full{', '.h-full{']) {
      expect(all.includes(cls), `产物里找不到 ${cls}，页面会没有布局`).toBe(true)
    }
  })

  it('CSS 里不能有未包裹的 @layer 声明语句（@layer a, b;）', () => {
    for (const f of cssFiles()) {
      const css = readFileSync(join(DIST, f), 'utf8')
      expect(/@layer\s+[\w-]+\s*[,;]/.test(css), `${f} 里还有 @layer 语句`).toBe(false)
    }
  })

  // ── 降级层覆盖度门禁 ──
  //
  // 背景：生成器连续三轮出现"类名正则不匹配就静默 continue"，每次都是
  // 一半档位没生成、且没有任何报错：
  //   1. 漏 \  → py-1.5 / px-2.5 全丢
  //   2. 漏 [  → py-[7px] 任意值全丢
  //   3. 漏 \: → 所有响应式变体（.sm\:px-6）全丢
  // 这三条断言直接读产物 + 生成结果，任何一条回归都会立刻失败。

  const legacyCss = (() => {
    const p = join(__dirname, '..', 'src', 'styles', 'legacy-generated.css')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  })()
  const allCss = () => cssFiles().map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n')

  it('响应式变体的降级规则必须包在同一断点的 @media 里', () => {
    // ★ 只有"存在"不够，位置错了更糟：把 .sm\:px-6 的兜底展开到全局，
    //   窄屏会拿到宽屏的间距 —— 方向反着错，比不做还难看。
    const css = legacyCss
    // 找出所有 html[data-legacy-css] .sm\:xxx / .md\:xxx / .lg\:xxx
    const hits = [...css.matchAll(/^(.*?)(html\[data-legacy-css='1'\]\s*\.(sm|md|lg|xl)\\:)/gm)]
    expect(hits.length, '生成器没产出任何响应式兜底，检查 CLASS_RE 是否放行了 \\:').toBeGreaterThan(0)
    const bad = hits.filter((m) => !/@media[^{]*\{\s*$/.test(m[1])).map((m) => m[2])
    expect(bad, `这些响应式兜底没包在 @media 里，窄屏会被污染：${bad.join(', ')}`).toEqual([])
  })

  it('gap-x / gap-y 必须按主轴分开兜底（不能只加 margin-left）', () => {
    // ★ 断言读**产物**而不是源文件：源文件改对但没重新构建时，
    //   读源文件的断言会假绿（实测踩过：故意把 gap-y 改成 margin-left，
    //   测试仍 11 passed，因为比对的是源文件、产物还是旧的）。
    const css = allCss()
    const x = [...css.matchAll(/\.flex:not\(\.flex-wrap\)\.gap-x-[^{]*\{[^}]*margin-left/g)]
    const y = [...css.matchAll(/\.flex-col\.gap-y-[^{]*\{[^}]*margin-top/g)]
    expect(x.length, 'gap-x 的兜底缺失或方向错（应只加 margin-left）').toBeGreaterThan(0)
    expect(y.length, 'gap-y 的兜底缺失或方向错（应只加 margin-top）').toBeGreaterThan(0)
    // ★ 反向校验：gap-x 绝不能出现 margin-top（那会让横向间距变成纵向偏移）
    const wrong = [...css.matchAll(/\.gap-x-[^{]*\{[^}]*margin-top/g)]
    expect(wrong.length, 'gap-x 被错误地写成了 margin-top').toBe(0)
  })

  it('aspect-video 必须有兜底（命名比例，生成器曾漏掉）', () => {
    /*
     * 选择器后面允许带 `:not([class*="h-["])` —— 那是 2026-10-30 加的排除项：
     * 自带固定高（`h-[4.78rem]`）的元素不能用 padding-top 占位
     * （百分比按父宽算，会把 153×86 的壁纸卡片拉成 153×511）。
     * 所以这里只断言"存在 aspect-video 的 padding-top 兜底"，不限定选择器结尾。
     */
    expect(legacyCss, 'aspect-video 没有 padding-top 兜底，Chrome 88 以下缩略图会塌成 0 高')
      .toMatch(/\.aspect-video[^{]*\{[^}]*padding-top:\s*56\.25%/)
  })

  it('自带固定高的 aspect 元素必须被排除在 padding-top 兜底之外', () => {
    /*
     * 踩过（2026-10-30 投影仪 Chrome 66）：壁纸卡片 `aspect-video w-[8.5rem]`
     * 被 padding-top:56.25% 按**父容器宽度**算成 510px，卡片从 86px 变 511px。
     * 判据：兜底选择器必须排除带 `h-[...]` 固定高的元素。
     */
    expect(legacyCss, 'aspect 兜底没有排除固定高元素，卡片会被按父宽拉高')
      .toMatch(/:not\(\[class\*="h-\["\]\)/)
  })

  it('降级层的每条规则都必须带 data-legacy-css 开关', () => {
    // 不带开关会在**新内核上**也生效，与原生 gap / aspect-ratio 叠加
    // （实测 Chrome 110：间距从 94px 变 102px）。
    const body = legacyCss
      .split('\n')
      .filter((l) => l.trim().endsWith('}') && l.includes('{')) // 规则行（含 @media 包裹的）
    const bad = body.filter((l) => !l.includes("data-legacy-css='1'"))
    expect(bad, `这些规则没带降级开关，会污染新内核：\n${bad.slice(0, 5).join('\n')}`).toEqual([])
  })

  it('降级层规则必须真的被打进产物（不是只生成在源文件里）', () => {
    // 剥掉注释：legacy-css.css 里有大量解释"为什么这么写"的注释，
    // 其中会出现 data-legacy-css 字样，不剥会误判成"已打进包"。
    const css = allCss().replace(/\/\*[\s\S]*?\*\//g, '')

    // ★ 判据用"源文件里的每条规则都能在产物里找到"，而不是几条抽样正则。
    //   抽样会漏（踩过：抽 gap-x 但产物里压缩后形态不同，误判成没打进包）。
    //   两边都是同一种转义形态（.gap-x-3 / .sm\:px-6），可以直接比字符串。
    expect(legacyCss.length, 'legacy-generated.css 为空，先跑 node scripts/gen-legacy-css.mjs').toBeGreaterThan(0)
    const srcBody = legacyCss.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = srcBody.split('\n').filter((l) => l.includes("data-legacy-css='1'"))
    expect(rules.length, '源文件里没有降级规则').toBeGreaterThan(0)

    const missing: string[] = []
    for (const line of rules) {
      const m = line.match(/\s\.([^\s{]+)\s*\{/)
      if (!m) continue
      // 产物用双引号（data-legacy-css="1"），选择器部分与源文件一致
      if (!css.includes('.' + m[1])) missing.push(m[1])
    }
    expect(missing, `这些降级规则没打进产物：${missing.join(', ')}`).toEqual([])
  })

  it('JS 不能含 Chrome 66 不支持的语法（可选 catch 绑定等）', () => {
    const offenders: string[] = []
    for (const f of jsFiles()) {
      const js = readFileSync(join(DIST, f), 'utf8')
      if (/catch\s*\{/.test(js)) offenders.push(`${f}: catch{}`)
      // 空值合并与逻辑赋值：es2017 目标下必须已被降级
      if (/\?\?=|\|\|=|&&=/.test(js)) offenders.push(`${f}: 逻辑赋值`)
    }
    expect(offenders, offenders.join('; ')).toEqual([])
  })

  // ── 单属性 transform 的兜底（2026-10-27 实测：三处错位）──
  //
  // Tailwind v4 把 -translate-y-1/2 编译成 CSS `translate` 属性（需 Chrome 104）：
  //   .-translate-y-1/2 { translate: var(--tw-translate-x) var(--tw-translate-y) }
  // 老核心不认，元素只剩 top:50%，于是**向下偏半个自身高度**。
  //
  // 投影仪（Chrome 66）实测与反事实（补 transform 后归零）：
  //   搜索框放大镜 +12px、设置页左导航竖线 +9px
  it('translate / rotate 单属性必须有 transform 兜底', () => {
    const s = readFileSync(
      join(__dirname, '..', 'src', 'styles', 'legacy-css.css'), 'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    // ★ 用 [class~='…'] 属性选择器：类名里的 / 在产物中会带反斜杠转义，
    //   手写转义容易多写一层（踩过：写成双反斜杠，选择器永不匹配）。
    for (const [cls, tf] of [
      ['-translate-y-1/2', 'translateY(-50%)'],
      ['-translate-x-1/2', 'translateX(-50%)'],
      ['rotate-90', 'rotate(90deg)'],
      ['-rotate-90', 'rotate(-90deg)'],
      ['rotate-180', 'rotate(180deg)'],
    ]) {
      const esc = cls.replace(/[[\]]/g, '\\$&')
      const tfe = tf.replace(/[()]/g, '\\$&')
      const re = new RegExp(
        `\\[class~='${esc}'\\]\\s*\\{[^}]*transform:\\s*${tfe}`
      )
      expect(s, `${cls} 缺少 transform 兜底，老核心上会偏半个身位`).toMatch(re)
    }
    // 同时带 x/y 两个类时必须合成一次，否则后一条会覆盖前一条
    expect(s, '同时 -translate-x/y 时应合成 translate(-50%,-50%)，否则只剩一个轴生效')
      .toMatch(/\[class~='-translate-x-1\/2'\]\[class~='-translate-y-1\/2'\]\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/)
  })

  it('button 上的 grid 居中必须有 flex 兜底（旧 Blink 只对齐纵向）', () => {
    const s = readFileSync(
      join(__dirname, '..', 'src', 'styles', 'legacy-css.css'), 'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    // ★ 只覆盖 button，不能放开到通配：
    //   干净环境实测（Chrome 66，同一条 display:grid;place-items:center）
    //     div / a / span / label / section / li → (0,0) 正常
    //     button                                → 横向 -28px，纵向 0
    //   给已正常的元素也加 flex 会与原生实现叠加（间距被多推一次）。
    expect(s, 'button + grid place-items-center 缺少 flex 兜底，图标会贴左边缘')
      .toMatch(/button\[class~='grid'\]\[class~='place-items-center'\]\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*center/)

    // 反向校验：绝不能写成通配（会污染 div 等已被证明正常的元素）
    expect(/\[\s*data-legacy-css='1'\s*\]\s*\*\s*\[class~='grid'\]/.test(s),
      'button 居中兜底写成了通配选择器，会给已正常的元素重复偏移').toBe(false)
  })

  it('降级层的 inset 不能被压缩器合并回简写（自反陷阱）', () => {
    // ★ 降级层存在的意义就是绕开 Chrome 66 不认的 `inset` 简写，而 CSS 压缩器
    //   看到 top/right/bottom/left 会"贴心"地合并回 `inset:0`——规则原封不动地
    //   失效，且构建全程无报错。
    //
    // 实测（投影仪 Chrome 66 播放页）：
    //   div.absolute.inset-0 算出来 0×0 → 里面 h-full w-full 的 <video> 也是 0×0，
    //   但 videoWidth=1440、currentTime 照常推进、drawImage 能画出帧。
    //   表现是「只有声音没画面 / 音画不同步」，极易误判成解码或编码问题。
    const css = allCss().replace(/\/\*[\s\S]*?\*\//g, '')
    const bad: string[] = []
    for (const m of css.matchAll(/\[data-legacy-css="1"\][^{]*\{([^}]*)\}/g)) {
      const body = m[1]
      // 只看真出现简写的（展开后的长属性不含这些）
      if (/(^|;)\s*inset\s*:/.test(body)) bad.push('inset: ' + m[0].slice(0, 70))
      if (/(^|;)\s*inset-inline\s*:/.test(body)) bad.push('inset-inline ' + m[0].slice(0, 60))
      if (/(^|;)\s*inset-block\s*:/.test(body)) bad.push('inset-block ' + m[0].slice(0, 60))
    }
    expect(bad, `降级层里出现 inset 简写（Chrome 66 不认，定位会整体失效）：\n${bad.slice(0, 5).join('\n')}`).toEqual([])

    // 正向：inset-0 必须展开成四条
    expect(css, 'inset-0 的降级规则没展开成 top/right/bottom/left')
      .toMatch(/\[data-legacy-css="1"\]\s*\.inset-0\s*\{[^}]*top:0[^}]*right:0[^}]*bottom:0[^}]*left:0/)
  })

  it('入口 HTML 引用的都是存在的文件', () => {
    const html = readFileSync(join(__dirname, '..', 'dist', 'index.html'), 'utf8')
    const refs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1])
    expect(refs.length, 'index.html 没有任何 assets 引用').toBeGreaterThan(0)
    for (const r of refs) {
      expect(existsSync(join(__dirname, '..', 'dist', r)), `index.html 引用了不存在的 ${r}`).toBe(true)
    }
  })

  it('JS 内联样式不能用 inset / margin-inline 等简写（降级层覆盖不到）', () => {
    // ★ CSS 降级层只能作用于样式表，**管不了 JS 写的 style.cssText**。
    //   实测投影仪 Chrome 66：danmaku.ts 的弹幕容器用 `inset:0`，
    //   div 完全没有定位偏移 → 被排到 video 下方的静态流（y=720，视口高 720）。
    //   弹幕引擎照常工作（canvas 内 1% 像素非空、队列 2433 条），但整层
    //   在屏幕外 —— 用户看到的是"弹幕开着却一条都没有"，而所有状态字段都正常。
    //
    //   所以源码里凡是内联样式，必须写 top/right/bottom/left 长属性。
    const SRC = join(__dirname, '..', 'src')
    const bad: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(ts|vue)$/.test(e.name)) continue
        const text = readFileSync(p, 'utf8')
        // 只看内联样式字符串里出现的简写；注释行单独排除（解释性注释会提到 inset:0）
        for (const line of text.split('\n')) {
          const t = line.trim()
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
          // 探测代码故意用简写（要测的就是简写认不认），行尾标 legacy-disabled 跳过
          if (line.includes('legacy-disabled')) continue
          // 字符串里的 inset: 或 margin-inline: 等（作为内联样式片段）
          if (/(['"`])[^'"`]*\b(inset|margin-inline|padding-inline|margin-block|padding-block)\s*:/.test(line)) {
            bad.push(`${p.replace(SRC, 'src')}: ${t.slice(0, 76)}`)
          }
        }
      }
    }
    walk(SRC)
    expect(
      bad,
      `这些 JS 内联样式用了老内核不认的简写，降级层覆盖不到（改用 top/right/bottom/left）：\n${bad.slice(0, 6).join('\n')}`,
    ).toEqual([])
  })
})
