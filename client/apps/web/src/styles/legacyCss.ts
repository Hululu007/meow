/**
 * 老内核检测：决定是否挂载 legacy-css.css 的降级规则。
 *
 * ## 为什么必须实测，不能用 @supports
 *
 * 实测一台极米投影仪（Android 9 / Chrome 66）：`CSS.supports('gap','1px')`
 * 返回 **true**，但 flex gap 实际完全不生效（measuredDelta = 0）。
 * @supports 只验语法、不验实现 —— 用它做降级会静默失效，而且极难排查：
 * 代码看起来"做了兼容"，用户看到的却还是坏的。
 *
 * ## 判定哪些能力
 *
 * 只测"不可用会导致大范围错乱"的那几个，且都能构造样本量出真实几何：
 *   flex gap      → 全站 178 个容器
 *   aspect-ratio  → 海报卡高度会塌成 0
 *   padding-inline → Tailwind v4 的 px- / mx- 全系间距类都靠它
 *   color-mix     → 主题色/半透明
 *
 * 任一不满足就整体降级（不是逐项开关：这几个总是同时缺失，
 * 因为它们的引入版本接近，而且分批降级会让样式表更难推理）。
 */

let done = false

export function detectLegacyCss(): void {
  if (done) return
  done = true

  const root = document.documentElement
  // 有人显式指定就尊重（便于调试：?legacycss=0 / 1）
  const forced = new URLSearchParams(location.search).get('legacycss')
  if (forced === '0') return
  if (forced === '1') {
    root.dataset.legacyCss = '1'
    return
  }

  const missing: string[] = []

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:400px;pointer-events:none'
  host.setAttribute('aria-hidden', 'true')
  document.body.appendChild(host)

  const cell = '<i style="display:block;width:10px;height:10px;flex:0 0 auto"></i>'

  try {
    // 1) flex gap：真实间距必须接近 30
    const f = document.createElement('div')
    f.style.cssText = 'display:flex;gap:30px'
    f.innerHTML = cell + cell
    host.appendChild(f)
    const [f1, f2] = Array.from(f.children) as HTMLElement[]
    const d1 = f2.getBoundingClientRect().left - f1.getBoundingClientRect().right
    if (d1 < 25) missing.push('flex-gap')
    f.remove()

    // 2) aspect-ratio：200 宽配 2/3 应该得到 300 高
    const a = document.createElement('div')
    a.style.cssText = 'width:200px;aspect-ratio:2/3'
    host.appendChild(a)
    if (a.getBoundingClientRect().height < 250) missing.push('aspect-ratio')
    a.remove()

    // 3) padding-inline：Tailwind v4 的整个间距体系依赖它
    // ★ 这里故意用简写：要探的就是"这个简写认不认"。
    //   行尾的 legacy-disabled 让兼容性测试跳过它（见 tests/legacy-compat.test.ts）。
    const p = document.createElement('div')
    p.style.cssText = 'padding:0;padding-inline:33px;width:100px;height:10px' // legacy-disabled: 探测用
    host.appendChild(p)
    if (getComputedStyle(p).paddingLeft !== '33px') missing.push('padding-inline')
    p.remove()
  } finally {
    host.remove()
  }

  // ★ color-mix 单独判定，且**不参与是否启用降级层的决定**。
  //
  //   原因：本降级层是靠 margin 模拟 gap、靠 padding-top 模拟 aspect-ratio，
  //   这些在"只有 color-mix 缺失"的内核上会与原生能力**叠加**（实测
  //   Chrome 110：gap 本来正常，加了 margin 后间距从 94px 变成 102px）。
  //   而 color-mix 属于"颜色退化"，观感偏差但不会错位，单独记录即可。
  //
  //   目前代码里没有基于 color-mix 的补救（193 处产物用量，逐个降级
  //   风险太高），所以这里只把它挂到 data 属性上，供排障时查询。
  let lacksColorMix = false
  try {
    const c = document.createElement('div')
    c.style.cssText =
      'color:rgb(0,255,0);color:color-mix(in oklab, rgb(255,0,0) 50%, rgb(0,0,255))'
    document.body.appendChild(c)
    lacksColorMix = getComputedStyle(c).color === 'rgb(0, 255, 0)'
    c.remove()
  } catch {
    /* 忽略 */
  }

  if (missing.length) {
    root.dataset.legacyCss = '1'
    root.dataset.legacyCssMissing = missing.join(',')
    if (lacksColorMix) root.dataset.noColorMix = '1'
    // 留一条可查的痕迹：排障时不用再猜"到底降级了没"
    try {
      console.warn(
        '[meow] 老内核降级已启用，缺失特性: ' + missing.join(', ') +
          (lacksColorMix ? '（另缺 color-mix，仅颜色退化）' : '') +
          '（UA: ' + navigator.userAgent + '）',
      )
    } catch {
      /* 忽略 */
    }
  } else if (lacksColorMix) {
    root.dataset.noColorMix = '1'
  }

  // 调试徽标：URL 带 ?cssdiag=1 时在右下角显示探测结果。
  //
  // 为什么要有它：这台投影仪是 release 包、logcat 被系统屏蔽、
  // WebView 调试也关着 —— 除了看屏幕没有任何取证通道。
  // 把"降级启用了吗、缺什么"直接画在画面上，截图就能看到。
  if (new URLSearchParams(location.search).get('cssdiag') === '1') {
    try {
      const el = document.createElement('pre')
      el.id = '__cssdiag__'
      el.style.cssText =
        'position:fixed;left:0;bottom:0;z-index:99999;margin:0;padding:8px 10px;' +
        'background:rgba(0,0,0,.86);color:#0f0;font:12px/1.5 monospace;' +
        'max-width:60vw;white-space:pre-wrap;pointer-events:none'
      el.textContent =
        'UA Chrome/' + (navigator.userAgent.match(/Chrome\/([0-9]+)/) || [])[1] + '\n' +
        'legacy-css = ' + (root.dataset.legacyCss || '(未启用)') + '\n' +
        'missing = ' + (root.dataset.legacyCssMissing || '无') + '\n' +
        'color-mix = ' + (lacksColorMix ? '缺失' : 'OK') + '\n' +
        'body = ' + (document.body ? 'ok' : 'NULL')
      document.body.appendChild(el)
    } catch {
      /* 忽略 */
    }
  }
}
