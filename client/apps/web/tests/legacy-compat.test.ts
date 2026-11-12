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
    const x = [...css.matchAll(/\[class\*=(?:"flex"|flex)\][^{]*\.gap-x-[^{]*\{[^}]*margin-left/g)]
    const y = [...css.matchAll(/\[class\*=(?:"flex-col"|flex-col)\][^{]*\.gap-y-[^{]*\{[^}]*margin-top/g)]
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

/**
 * flex-wrap 容器与手写 CSS 的 gap 兜底（2026-11-12 投影仪实测补）。
 *
 * 起因：用户对比极米投影仪（Chromium 66）与 MuMu（Chromium 110）截图，
 * 发现设置页标题行、按钮组、详情页海报与文字列之间的间距在投影仪上塌成 0。
 *
 * 两个漏洞：
 *   1. 生成器当时**故意排除 flex-wrap**（换行后相邻兄弟选择器会把每行首元素顶偏），
 *      而设置页的头部行（.set-head）恰好全是 flex-wrap → 完全没有间距；
 *   2. 生成器只扫构建产物里的 utility 类，扫不到 tokens.css / SFC 里手写的
 *      `gap:`（.set-head / .tile / .set-sub / .menu-item）→ 这些容器也没有兜底。
 *
 * 修法：wrap 容器改成"每个子项都带 margin"（配合换行），手写类单独补规则。
 */
describe('flex-wrap 与手写 gap 的兜底', () => {
  const GEN = readFileSync(join(__dirname, '..', 'src', 'styles', 'legacy-generated.css'), 'utf8')
  const HAND = readFileSync(join(__dirname, '..', 'src', 'styles', 'legacy-css.css'), 'utf8')

  it('生成物给 flex-wrap 的 gap 工具类兜底（每子项 margin）', () => {
    const wrap = [...GEN.matchAll(/\[class\*="flex-wrap"\]:not\(\[class\*="grid"\]\)\.gap-[^{]*\{[^}]*margin-right/g)]
    expect(wrap.length, 'flex-wrap 的 gap 兜底缺失').toBeGreaterThan(0)
    // 反向：不许退回"相邻兄弟"写法（换行会顶偏整行）
    expect(GEN).not.toMatch(/\[class\*="flex-wrap"\]:not\(\[class\*="grid"\]\)\.gap-[^{]*>\s*\*\s*\+\s*\*/)
  })

  it('手写类 .set-head/.tile/.set-sub/.menu-item 有 gap 兜底', () => {
    for (const cls of ['set-head', 'tile', 'set-sub', 'menu-item']) {
      expect(HAND, `${cls} 缺 gap 兜底`).toContain(`.${cls} > *`)
    }
    // .set-head 是 flex-wrap，必须是"每子项 margin"而不是相邻兄弟
    expect(HAND).toMatch(/\.set-head > \*\s*\{[^}]*margin-right/)
  })
})

/**
 * inset 简写与 aspect-square 的兜底（2026-11-12 第二轮盘点）。
 *
 * - `inset: 0` 是 Chrome 87+ 的简写；Chromium 66 整条丢弃 → fixed 遮罩/弹层
 *   失去定位（铺不满屏）。生成器本轮补了 inset → top/right/bottom/left。
 * - `aspect-square` 只在播放统计用了一次，此前手写层只覆盖了 [2/3] 和 [16/9]。
 */
describe('inset 简写与 aspect-square 兜底', () => {
  it('inset-0 必须展开成四边（不能用 inset 简写打发）', () => {
    const css = readdirSync(DIST)
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(DIST, f), 'utf8'))
      .join(String.fromCharCode(10))
    expect(css).toMatch(/\.inset-0\s*\{[^}]*top:\s*0[^}]*right:\s*0[^}]*bottom:\s*0[^}]*left:\s*0/)
  })

  it('aspect-square 有 padding-top 占位兜底', () => {
    const hand = readFileSync(join(__dirname, '..', 'src', 'styles', 'legacy-css.css'), 'utf8')
    expect(hand).toMatch(/\.aspect-square\s*\{[^}]*padding-top:\s*100%/)
  })
})

/**
 * 运行时 API 补丁（2026-11-12 第三轮：用户问"还有什么缺口"）。
 *
 * esbuild 的 `target: es2017` 只转语法，**不补内置对象**。
 * 投影仪 WebView 66 上这些 API 缺失，调用即 TypeError：
 *   Promise.allSettled(76) / flatMap(69) / Object.fromEntries(73) /
 *   String.matchAll(73) / Array.at(92)
 * 业务影响不是样式，是功能：收藏保存、AI 多源合并、WebDAV 同步、更新中心检查。
 */
describe('运行时 API 补丁', () => {
  const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8')
  const POLY = readFileSync(join(__dirname, '..', 'src', 'compat', 'legacyPolyfills.ts'), 'utf8')

  it('main.ts 在业务模块之前安装补丁（模块评估即生效）', () => {
    const importAt = MAIN.indexOf("import './compat/legacyPolyfills'")
    expect(importAt, 'main.ts 没导入补丁模块').toBeGreaterThan(-1)
    expect(importAt, '补丁导入必须排在业务导入之前').toBeLessThan(MAIN.indexOf("from 'vue'"))
  })

  it('覆盖投影仪实测缺失的 5 个 API', () => {
    for (const api of [
      'allSettled',
      'flatMap',
      "'flat'",
      "'at'",
      'matchAll',
      'fromEntries',
    ]) {
      expect(POLY, `补丁缺少 ${api}`).toContain(api)
    }
  })
})

/**
 * 未来 API 的使用门禁（2026-11-12 用户建议落地）。
 *
 * 背景：polyfill 只补"已经用到"的 API。以后新代码随手用了
 * `structuredClone` / `Object.groupBy` / `toSorted` 这类（都是 Chrome 90+），
 * 在新内核上开发完全无感，到投影仪上才 TypeError。
 *
 * 判据：源码里出现某个"Chromium 66 没有"的 API 调用时，
 * legacyPolyfills.ts 必须有对应实现；没有就红，并告诉开发者版本号。
 * 不想补的，改成等价的老写法即可（比"静默坏在用户机器上"便宜）。
 */
describe('新 API 使用门禁（Chromium 66）', () => {
  const SRC = join(__dirname, '..', 'src')
  const POLY = readFileSync(join(SRC, 'compat', 'legacyPolyfills.ts'), 'utf8')

  const sources: string[] = []
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'compat') continue // 补丁自身不算"使用"
        walk(p)
      } else if (/\.(ts|vue)$/.test(ent.name) && !p.endsWith('legacyPolyfills.ts')) {
        sources.push(readFileSync(p, 'utf8'))
      }
    }
  }
  walk(SRC)
  const all = sources.join('\n')

  /** api：展示名；pattern：源码里的调用形态；marker：补丁里的实现标记；since：起始版本 */
  const WATCH: Array<{ api: string; pattern: RegExp; marker: string; since: number }> = [
    { api: 'Promise.allSettled', pattern: /Promise\.allSettled\s*\(/, marker: 'allSettled', since: 76 },
    { api: 'Object.fromEntries', pattern: /Object\.fromEntries\s*\(/, marker: 'fromEntries', since: 73 },
    { api: 'Array.prototype.flatMap', pattern: /\.flatMap\s*\(/, marker: 'flatMap', since: 69 },
    { api: 'Array.prototype.flat', pattern: /\.flat\s*\(/, marker: "'flat'", since: 69 },
    { api: 'Array.prototype.at', pattern: /\.at\s*\(\s*-?[0-9]/, marker: "'at'", since: 92 },
    { api: 'String.prototype.matchAll', pattern: /\.matchAll\s*\(/, marker: 'matchAll', since: 73 },
    { api: 'Object.hasOwn', pattern: /Object\.hasOwn\s*\(/, marker: 'hasOwn', since: 93 },
    { api: 'String.prototype.replaceAll', pattern: /\.replaceAll\s*\(/, marker: 'replaceAll', since: 85 },
    { api: 'Array.prototype.findLast', pattern: /\.findLast(Index)?\s*\(/, marker: 'findLast', since: 97 },
    { api: 'Promise.any', pattern: /Promise\.any\s*\(/, marker: "'any'", since: 85 },
    { api: 'structuredClone', pattern: /\bstructuredClone\s*\(/, marker: '@@none@@', since: 98 },
    { api: 'Object.groupBy', pattern: /Object\.groupBy\s*\(/, marker: '@@none@@', since: 117 },
    { api: 'Array.prototype.toSorted', pattern: /\.toSorted\s*\(/, marker: '@@none@@', since: 110 },
    { api: 'Array.prototype.toReversed', pattern: /\.toReversed\s*\(/, marker: '@@none@@', since: 110 },
    // globalThis 是 Chrome 71+ 的全局标识符；Chromium 66 上引用即 ReferenceError
    { api: 'globalThis', pattern: /globalThis/, marker: '@@none@@', since: 71 },
  ]

  it('源码用到的每个新 API 都必须在 legacyPolyfills 里有实现', () => {
    const missing: string[] = []
    for (const w of WATCH) {
      if (!w.pattern.test(all)) continue // 没用到就不要求
      if (w.marker === '@@none@@' || !POLY.includes(w.marker)) {
        missing.push(`${w.api}（Chrome ${w.since}+）`)
      }
    }
    expect(
      missing,
      `这些 API 在 Chromium 66 上不存在，先加 polyfill 或换老写法：${missing.join('、')}`,
    ).toEqual([])
  })
})
