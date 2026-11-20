/**
 * 从构建产物里提取"用了新特性"的类，自动生成降级 CSS。
 *
 * 为什么必须自动生成而不是手写：手写过一版，凭印象列了 px-0.5 到 px-8，
 * 结果漏掉了 -mx-6、inset-x-2 这类，而且 Tailwind 到底生成了哪些档位
 * 只有产物里才知道。手写清单 = 猜。
 *
 * 用法：
 *   node scripts/gen-legacy-css.mjs                  # 写回 src/styles/legacy-generated.css
 *   node scripts/gen-legacy-css.mjs --out tmp/x.css  # 写到指定位置（调试用，别写源文件）
 * 产物：src/styles/legacy-generated.css
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const distDir = join(webRoot, 'dist', 'assets')

// ★ 必须支持 --out：这个脚本默认直写源文件，调试时误跑会污染已提交的
//   legacy-generated.css（踩过：在 tmp 里复制一份跑，结果写回的仍是源文件）。
const outArgIdx = process.argv.indexOf('--out')
const outFile = outArgIdx > 0 && process.argv[outArgIdx + 1]
  ? process.argv[outArgIdx + 1]
  : join(webRoot, 'src', 'styles', 'legacy-generated.css')

/*
 * ★ 扫**全部** *.css，不只 index-*.css（2026-11-13）：懒加载页面（设置/播放统计）
 *   的类只出现在各自的 chunk 里。只读 index 时 aspect-square 这类"只在一个页面用"
 *   的类会被漏掉，手写层又已并入生成物，结果就是那块彻底没有降级。
 */
const cssFiles = readdirSync(distDir).filter((n) => n.endsWith('.css'))
if (!cssFiles.length) {
  console.error('dist/assets 里没有 .css，先跑 vite build')
  process.exit(1)
}
const css = cssFiles.map((f) => readFileSync(join(distDir, f), 'utf8')).join(String.fromCharCode(10))

/** 括号配对 */
function matchBrace(src, from) {
  let depth = 1
  for (let j = from; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return j }
  }
  return src.length
}

/**
 * 解析产物 CSS 为 { media, sel, body } 列表。
 *
 * ★ 必须真正下钻 @media：响应式变体（.sm\:gap-2）全在 @media 里，
 *   旧版按"最后一个 { 之后取选择器"的线性扫描会把 @media 头当成选择器、
 *   把块内第一条规则当成 body，导致响应式类**一条都提不出来**——
 *   表现为"窄屏正常、宽屏上间距归零"，比全坏更难查。
 *
 * 只下钻 @media；@keyframes / @font-face / @property / @supports 整块跳过：
 *   @supports 里的规则在老内核上本来就整块不生效，给它做替代没有意义
 *   （条件是 color-mix 之类的探测，老内核恒假）。
 */
function parseCss(src) {
  const out = []
  function walk(i, end, media) {
    while (i < end) {
      const open = src.indexOf('{', i)
      if (open < 0) return
      const semi = src.indexOf(';', i)
      // @import / @charset 这类无块语句
      if (semi >= 0 && semi < open) { i = semi + 1; continue }

      const head = src.slice(i, open).trim()
      const close = matchBrace(src, open + 1)
      const body = src.slice(open + 1, close)

      if (head.startsWith('@')) {
        const name = head.split(/[\s(]/)[0]
        if (name === '@media') {
          const cond = head.slice('@media'.length).trim()
          walk(open + 1, close, media ? `${media} and ${cond}` : cond)
        }
        // 其余 at-rule 整块跳过
      } else {
        out.push({ media, sel: head, body })
      }
      i = close + 1
    }
  }
  walk(0, src.length, null)
  return out
}

const rules = parseCss(css)

/**
 * 类名白名单：字母数字下划线横线、点、方括号、**转义冒号**、圆括号百分号。
 *
 * ★ 三轮踩坑，每次症状都是"静默漏一半档位"：
 *   1. 没放行反斜杠 → py-1.5 / px-2.5（产物里是 .py-1\.5）全被跳过
 *   2. 没放行方括号 → py-[7px] 这类任意值被跳过（设置页导航按钮内边距为 0）
 *   3. 没放行 \:      → 所有响应式变体（.sm\:px-6）被跳过（宽屏间距归零）
 *   4. 没放行 \/      → aspect-\[2\/3\] 这类含斜杠的任意值被跳过
 * 共同点：正则不匹配就 continue，没有任何报错。
 */
const CLASS_RE = /^\.([A-Za-z0-9_.\[\]:()%\\/-]+)$/

/** calc(var(--spacing) * N) → rem。--spacing 默认 0.25rem。 */
function toRem(v) {
  const m = /calc\(\s*var\(--spacing\)\s*\*\s*(-?[0-9.]+)\s*\)/.exec(v)
  if (m) return Number(m[1]) * 0.25 + 'rem'
  if (v === 'var(--spacing)') return '0.25rem'
  return null // auto 等原样保留
}

// 命名比例（aspect-video → var(--aspect-video)）：从产物里的 --aspect-* 定义读出来。
// 不硬编码 16/9 —— Tailwind 改默认值时这里自动跟随。
const namedAspect = new Map()
for (const m of css.matchAll(/--aspect-([a-z0-9-]+)\s*:\s*([0-9.]+)\s*\/\s*([0-9.]+)/g)) {
  namedAspect.set(m[1], { w: Number(m[2]), h: Number(m[3]) })
}

const logical = []   // 逻辑属性 → 物理属性
const gaps = []      // gap（单值，双向）
const axisGaps = []  // gap-x / gap-y（单向）
const aspects = []   // aspect-ratio → padding-top
const spaces = []    // space-x / space-y
const rotates = []   // rotate 独立属性 → transform

for (const r of rules) {
  const cm = CLASS_RE.exec(r.sel)
  if (!cm) continue
  const cls = cm[1]

  // 逻辑属性
  // ★ inset 简写（inset:0）是 Chrome 87+，Chromium 66 整条丢弃 → 弹层/遮罩定位全丢。
  const lm = /(^|[;{\s])(padding-inline|padding-block|margin-inline|margin-block|inset-inline|inset-block|inset)\s*:\s*([^;]+)/.exec(r.body)
  if (lm) logical.push({ cls, media: r.media, prop: lm[2], value: lm[3].trim() })

  // gap 单值（双向）
  const gm = /(?:^|;)\s*gap\s*:\s*([^;]+)/.exec(r.body)
  if (gm) gaps.push({ cls, media: r.media, value: gm[1].trim() })

  // gap-x / gap-y（单向，产物是 column-gap / row-gap）
  const cg = /(?:^|;)\s*column-gap\s*:\s*([^;]+)/.exec(r.body)
  if (cg) axisGaps.push({ cls, media: r.media, axis: 'x', value: cg[1].trim() })
  const rg = /(?:^|;)\s*row-gap\s*:\s*([^;]+)/.exec(r.body)
  if (rg) axisGaps.push({ cls, media: r.media, axis: 'y', value: rg[1].trim() })

  // aspect-ratio：字面分数
  const am = /aspect-ratio\s*:\s*([0-9.]+)\s*\/\s*([0-9.]+)/.exec(r.body)
  if (am) aspects.push({ cls, media: r.media, w: Number(am[1]), h: Number(am[2]) })
  else {
    // aspect-ratio：命名值（aspect-video）
    const an = /aspect-ratio\s*:\s*var\(--aspect-([a-z0-9-]+)\)/.exec(r.body)
    if (an && namedAspect.has(an[1])) {
      const a = namedAspect.get(an[1])
      aspects.push({ cls, media: r.media, w: a.w, h: a.h })
    } else {
      /*
       * aspect-ratio：裸数字（`aspect-square` 产物是 `aspect-ratio:1`，不是 `1/1`）。
       * 2026-11-13 踩过：只认分数写法时 aspect-square 被静默跳过，
       * 而手写层已并入生成物 → 播放统计的色块彻底没有降级。
       */
      const ab = /aspect-ratio\s*:\s*([0-9.]+)\s*(?:;|$)/.exec(r.body)
      if (ab) aspects.push({ cls, media: r.media, w: Number(ab[1]), h: 1 })
    }
  }


  // space-y / space-x：产物用 margin-block-start / margin-inline-start（Chrome 87+）。
  // 项目里没有用 *-reverse，按"正向"简化即可。
  const sm2 = /space-([xy])-([0-9.]+)/.exec(cls)
  if (sm2) {
    const mm = /calc\(\s*var\(--spacing\)\s*\*\s*([0-9.]+)\s*\)/.exec(r.body)
    if (mm) spaces.push({ cls, media: r.media, axis: sm2[1], v: Number(mm[1]) * 0.25 + 'rem' })
  }

  // rotate 独立属性（Chrome 104）→ transform: rotate()。
  // ★ 只处理"没有其它 transform 类"的情形：Tailwind v3 时代的 transform
  //   是多个类拼一条 transform（translate/scale 都写同一个属性），
  //   若元素同时带 translate-x-*，用 transform 兜底会**覆盖**掉位移。
  //   这里按产物判断：同一条规则里只有 rotate，且类名以 rotate- 开头。
  const rm = /(?:^|;)\s*rotate\s*:\s*(-?[0-9.]+)deg/.exec(r.body)
  if (rm && /^-?rotate-[0-9]+$/.test(cls)) {
    rotates.push({ cls, media: r.media, deg: rm[1] })
  }
}

const P = "html[data-legacy-css='1']"
const lines = []
lines.push('/* 自动生成，勿手改。生成器：scripts/gen-legacy-css.mjs')
lines.push(' *')
lines.push(' * 来源：构建产物里所有用逻辑属性 / gap / aspect-ratio 的类')
lines.push(' * （对应的 Chrome 版本依次是 87 / 84 / 88）。')
lines.push(' * 手写清单会漏档位——这份是从产物里抠出来的，产物有的一定覆盖。')
lines.push(' *')
lines.push(' * ★ 响应式变体（.sm\:px-6）的兜底必须包在**同样的 @media** 里。')
lines.push(' *   展开到全局会让窄屏上拿到宽屏的间距，方向反着错。')
lines.push(' */')
lines.push('')

/** 有 media 就包一层，保证只在原本生效的断点区间内起作用 */
function emit(line, media) {
  lines.push(media ? `@media ${media} { ${line} }` : line)
}

/** 去掉零填充的百分比：150.0000 → 150，56.2500 → 56.25 */
function pct(h, w) {
  return ((h / w) * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

lines.push('/* ── 逻辑属性 → 物理属性 ── */')
for (const it of logical) {
  const v = toRem(it.value) ?? it.value
  // ★ 类名从产物里取来时**已经带转义**（如 py-1\.5），不能再补一层反斜杠，
  //   否则写出 py-1\\.5（两个反斜杠），浏览器匹配不到 —— 表现为
  //   "带小数的档位静默不生效"，而整数档正常，极难归因。
  const pair = {
    'padding-inline': ['padding-left', 'padding-right'],
    'padding-block': ['padding-top', 'padding-bottom'],
    'margin-inline': ['margin-left', 'margin-right'],
    'margin-block': ['margin-top', 'margin-bottom'],
    'inset-inline': ['left', 'right'],
    'inset-block': ['top', 'bottom'],
    inset: ['top', 'right', 'bottom', 'left'],
  }[it.prop]
  if (pair) {
    /*
     * margin 简写展开必须避让**同轴的显式工具类**。
     *
     * 层外规则恒胜 @layer 里的 utilities，所以 `-my-3` 展开出来的
     * `margin-bottom:-.75rem` 会压掉同元素上的 `.mb-3{+.75rem}`。
     *
     * ★ 踩过（2026-11-20 投影仪）：首页分类胶囊
     *   `-mx-6 mb-3 py-3 -my-3`，新内核 mb-3 写在后面赢了 → 12px 下间距；
     *   老内核被降级层压成 -12px → hero 直接压到胶囊上（实测顶部重叠 12~13px）。
     * 判据用属性选择器：class 里出现 mt-/mb-（ml-/mr-）就不展开该轴，
     * 交给 utilities 自己处理 —— 与「新内核谁后写谁赢」的结果对齐。
     */
    const axis = { 'margin-block': ['margin-top', 'mt-'], 'margin-inline': ['margin-left', 'ml-'] }[it.prop]
    if (axis) {
      const [first, fcls] = axis
      const second = pair[1]
      const scls = fcls.replace('t-', 'b-').replace('l-', 'r-')
      emit(`${P} .${it.cls}:not([class*="${fcls}"]) { ${first}: ${v}; }`, it.media)
      emit(`${P} .${it.cls}:not([class*="${scls}"]) { ${second}: ${v}; }`, it.media)
    } else {
      emit(`${P} .${it.cls} { ${pair[0]}: ${v}; ${pair[1]}: ${v}; }`, it.media)
    }
  }
}

lines.push('')
lines.push('/* ── flex gap → 后代 margin ──')
lines.push(' * ★ 容器判定用属性选择器（[class*="flex"] 等），不能用 .flex 工具类：')
lines.push(' *   2026-11-12 投影仪实测——详情页容器是 `sm:flex sm:flex-row lg:gap-5`，')
lines.push(' *   display 来自**带断点前缀的** sm:flex，`.flex` 根本不在 class 里，')
lines.push(' *   所以 `.flex.gap-*` 的选择器一条都不匹配 → 间距照样是 0。')
lines.push(' *   改成 [class*="flex"] 后，sm:flex / md:flex / flex-col / flex-wrap 全覆盖。')
lines.push(' * 排除 grid：grid 的 gap 在 Chromium 66 是支持的，加 margin 会叠加双倍间距。')
lines.push(' * flex-wrap 容器：换行后相邻兄弟会把每行首元素顶偏，改为"每子项都带 margin"。')
lines.push(' */')
const FLEX_ANY = '[class*="flex"]:not([class*="flex-col"]):not([class*="flex-wrap"]):not([class*="grid"])'
const FLEX_COL = '[class*="flex-col"]:not([class*="grid"])'
const FLEX_WRAP = '[class*="flex-wrap"]:not([class*="grid"])'
for (const it of gaps) {
  const v = toRem(it.value) ?? it.value
  emit(`${P} ${FLEX_ANY}.${it.cls} > * + * { margin-left: ${v}; }`, it.media)
  emit(`${P} ${FLEX_COL}.${it.cls} > * + * { margin-top: ${v}; }`, it.media)
  emit(`${P} ${FLEX_WRAP}.${it.cls} > * { margin-right: ${v}; margin-bottom: ${v}; }`, it.media)
}

lines.push('')
lines.push('/* ── gap-x / gap-y（产物是 column-gap / row-gap）──')
lines.push(' * ★ 只按主轴补：gap-x 只给 flex-row 的 margin-left，gap-y 只给 flex-col 的 margin-top。')
lines.push(' *   交叉轴（flex-col 的横向 gap）与换行后的行间距用 margin 表达不了，跳过。')
// ★ 注释必须在这里闭合：漏一个 */ 会把下面整段规则当成注释吞掉，
//   而且完全不报错（踩过：gap-x/y 共 9 条一条都没进产物，测试报
//   "gap-x 的兜底缺失"，但源文件里看着是对的）。
lines.push(' */')
for (const it of axisGaps) {
  const v = toRem(it.value) ?? it.value
  if (it.axis === 'x') {
    emit(`${P} ${FLEX_ANY}.${it.cls} > * + * { margin-left: ${v}; }`, it.media)
    emit(`${P} ${FLEX_WRAP}.${it.cls} > * { margin-right: ${v}; }`, it.media)
  } else {
    emit(`${P} ${FLEX_COL}.${it.cls} > * + * { margin-top: ${v}; }`, it.media)
    emit(`${P} ${FLEX_WRAP}.${it.cls} > * { margin-bottom: ${v}; }`, it.media)
  }
}

lines.push('')
lines.push('/* ── space-y / space-x（margin-block/inline-start，需 Chrome 87）── */')
for (const it of spaces) {
  const prop = it.axis === 'y' ? 'margin-bottom' : 'margin-right'
  emit(`${P} .${it.cls} > :not(:last-child) { ${prop}: ${it.v}; }`, it.media)
}

lines.push('')
lines.push('/* ── aspect-ratio → padding-top 占位 ──')
lines.push(' * 只给"未定位"的子元素补，避免把底部渐变（h-16）拉满整图 ——')
lines.push(' * 那样会让所有海报发暗（实测踩过）。')
lines.push(' *')
lines.push(' * ★★ 这条降级对「固定宽的 flex 子项」是错的，必须另给固定高度。')
lines.push(' *   `padding-top: 56.25%` 的百分比相对**父容器宽度**算，不是自身宽度。')
lines.push(' *   实测（2026-10-30 投影仪 Chrome 66）：壁纸卡片是 `w-[8.5rem]` 的')
lines.push(' *   flex 子项、父容器宽 900px+ → padding-top 算出 510px，')
lines.push(' *   卡片被拉成 153×511（应 153×86），底部文字被推出屏幕。')
lines.push(' *   判据：元素若带 `w-[Nrem]` 这类固定宽，直接在模板里补')
lines.push(' *   `h-[N×比例]`，不要只依赖本文件的 padding-top 占位。')
lines.push(' */')
for (const it of aspects) {
  const p = pct(it.h, it.w)
  const esc = it.cls
  /*
   * ★ 排除"自己带固定高"的元素（`h-[4.78rem]` 这类）。
   *
   * 这些元素已经在模板里算好了自身高度，padding-top 占位对它们是**错的**：
   * 百分比按父容器宽度算，会把卡片拉高数倍（实测 153×86 → 153×511）。
   * 用 `:not([class*="h-["])` 让它们完全跳过这条降级，
   * 保留模板里写的固定高度。
   */
  const skipFixedH = ':not([class*="h-["])'
  emit(`${P} .${esc}${skipFixedH} { position: relative; height: 0; padding-top: ${p}%; }`, it.media)
  // ★ 必须排除 .poster-badge：角标的 position:absolute 写在 tokens.css（没有 .absolute
  //   工具类），只写 :not(.absolute) 会把 0.375rem 的胶囊拉成 100%×100%，
  //   它的 rgba(0,0,0,.78) 底色盖满整张海报（2026-11-13 投影仪实测）。
  emit(`${P} .${esc}${skipFixedH} > :not(.absolute):not(.fixed):not(.poster-badge) { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }`, it.media)
}

lines.push('')
lines.push('/* ── rotate 独立属性 → transform（Chrome 104 才有 rotate）──')
lines.push(' * ★ 用 transform 而不是重写 rotate：老内核只认 transform。')
lines.push(' *   只对"纯 rotate 类"生成——若元素还带 translate / scale，')
lines.push(' *   它们也走 transform，这里的兜底会把位移/缩放一起覆盖掉。')
lines.push(' */')
// ★★ 注释里绝不能出现"星号紧跟斜杠"（星号与斜杠相邻）：
//   那会**提前闭合 CSS 注释**，后面整段规则被当作注释吞掉。
//   实测：写了 translate 的通配写法后，产物少了 32 条规则（gap-x/y、
//   aspect-video、全部响应式变体），而构建只报一句 `Unexpected "*"`。
//   凡是要表达通配的地方，一律用文字（"translate 类"）不要拼星号。
for (const it of rotates) {
  emit(`${P} .${it.cls} { transform: rotate(${it.deg}deg); }`, it.media)
}

lines.push('')
lines.push('/* ── inset 简写 ── */')
emit(`${P} .inset-0 { top: 0; right: 0; bottom: 0; left: 0; }`, null)

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, lines.join('\n') + '\n')

const withMedia = [...logical, ...gaps, ...axisGaps, ...aspects, ...spaces, ...rotates].filter((x) => x.media).length
console.log(
  '逻辑属性: %d, gap: %d, gap轴: %d, space: %d, aspect: %d, rotate: %d（其中响应式 %d）',
  logical.length, gaps.length, axisGaps.length, spaces.length, aspects.length, rotates.length, withMedia,
)
console.log('已写入 ' + outFile)

// ── 自检：注释必须配对 ──────────────────────────────────────
// ★ 踩过三次：给某段规则补"为什么"的注释时漏写闭合标记，于是从那里到
//   下一个 */ 之间的全部规则被当成注释吞掉，产物静默少几十条规则
//   （gap-x/y 9 条、aspect-video、响应式变体都这么丢过），而构建不报错。
//   这里直接数开合数量，少一个就退出非零。
const emitted = lines.join('\n')
const openN = (emitted.match(/\/\*/g) || []).length
const closeN = (emitted.match(/\*\//g) || []).length
if (openN !== closeN) {
  console.error(
    `★ 生成的 CSS 注释不配对（/* ${openN} 个，*/ ${closeN} 个）。` +
      '检查是不是某段 lines.push 注释后漏了 lines.push(\' */\')。'
  )
  process.exit(1)
}

// ── 自检：各段规则数不能凭空归零 ─────────────────────────────
// 数量由产物决定，所以不强求具体值；但"产物里有这类类、生成结果却是 0"
// 一定意味着正则/注释出了问题。
const zeroWarn = []
if (logical.length === 0) zeroWarn.push('逻辑属性')
if (axisGaps.length === 0) zeroWarn.push('gap-x/y')
if (zeroWarn.length) {
  console.error(`★ 这些类别生成了 0 条规则：${zeroWarn.join('、')}（检查注释闭合与 CLASS_RE）`)
  process.exit(1)
}

// ── 告警：aspect + 固定宽度 = padding-top 兜底算错十倍 ──────────
/*
 * padding-top 的百分比按**包含块宽度**解析。只有当元素宽度撑满父容器
 * （网格卡片）时它才等于「自身宽 × 比例」；固定宽度的 flex 子项会被按
 * 父容器宽度放大 —— 首页 hero 海报（w-20 放在 900px 宽的卡片里）被算成
 * 1350px 高，整屏只剩一块拉爆的海报（2026-11-20 投影仪真机）。
 *
 * 这类元素必须在 legacy-css.css 里给**显式高度**。这里扫源码把新增的
 * 组合喊出来，避免下一次又是真机才发现。
 */
function scanFixedWidthAspects() {
  const srcRoot = join(webRoot, 'src')
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      if (name.isDirectory()) walk(p)
      else if (name.name.endsWith('.vue')) {
        const text = readFileSync(p, 'utf8')
        for (const m of text.matchAll(/class="([^"]*)"/g)) {
          const cls = m[1]
          if (!/(^|\s)aspect-/.test(cls)) continue
          if (/(^|\s)w-full(\s|$)/.test(cls) || /(^|\s)w-auto(\s|$)/.test(cls)) continue
          // 固定宽度档：w-20 / sm:w-28 / w-[8.5rem]
          if (!/(^|\s|:)w-(\d|\[)/.test(cls)) continue
          // 自带固定高（h-[...]）的已被 aspect 兜底排除，不用告警
          if (/(^|\s)h-\[/.test(cls)) continue
          hits.push(p.slice(webRoot.length + 1) + '：' + cls.trim().slice(0, 90))
        }
      }
    }
  }
  walk(srcRoot)
  return hits
}

const fixedAspect = scanFixedWidthAspects()
if (fixedAspect.length) {
  console.warn(
    '\n★ 以下元素是「aspect-* + 固定宽度」：老内核的 padding-top 兜底会按父容器\n' +
      '  宽度放大它们（实测 hero 海报 168px → 1290px）。必须在 src/styles/legacy-css.css\n' +
      '  §11 给显式 height，并与其宽度档位（w-* / 响应式）对齐：\n' +
      fixedAspect.map((x) => '    ' + x).join('\n') + '\n'
  )
}

