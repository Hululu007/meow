import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TV 端专属样式的生效条件。
 *
 * 两个坑都是"代码看着对、电视上完全没效果"，普通单测和 typecheck 都抓不到：
 *
 * 1. **CSS 必须在 `@layer` 外面**。Tailwind v4 把工具类放进 utilities 层，
 *    层与层的优先级固定（utilities > components），跟选择器特异性无关。
 *    一开始把 `html[data-tv='1'] .app-header .text-sm` 写进 `@layer components`，
 *    特异性明明更高，实测顶栏仍是 14px。
 *
 * 2. **电视壳必须在 UA 里带 MeowTV**。前端 `isTvEnv()` 靠 UA 或
 *    `data-tv` 判定电视环境，而 `MainActivity` 原先两者都没设，
 *    于是整套 10-foot 适配（卡宽 76px、海报标题放大、顶栏字号）静默失效。
 *    注意正则大小写不敏感、但不认连字符：写 `meow-tv` 匹配不上。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const TOKENS = join(REPO, 'client', 'apps', 'web', 'src', 'styles', 'tokens.css')
const MAIN_ACTIVITY = join(
  REPO,
  'client',
  'apps',
  'tv',
  'app',
  'src',
  'main',
  'java',
  'com',
  'meow',
  'tv',
  'MainActivity.java',
)
const TV_NAV = join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js')

/**
 * 取一个顶层函数的函数体（按大括号配平）。
 *
 * 为什么不用固定长度窗口：函数里补一段注释，窗口就切不到末尾，
 * 测试会从"检查逻辑"退化成"检查注释长度"（已踩过一次）。
 */
function fnBody(src: string, signature: string): string {
  const at = src.indexOf(signature)
  if (at < 0) throw new Error(`找不到 ${signature}`)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${signature} 的大括号没有闭合`)
}

/** 把 CSS 按 @layer 块切分，返回「在某个 layer 内」的文本区间 */
function layerRanges(css: string): Array<{ start: number; end: number; name: string }> {
  const out: Array<{ start: number; end: number; name: string }> = []
  const re = /@layer\s+([\w-]+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ start: m.index, end: i + 1, name: m[1] })
  }
  return out
}

describe('TV 顶栏样式的生效条件', () => {
  const css = readFileSync(TOKENS, 'utf8')

  it('TV 顶栏规则写在所有 @layer 之外', () => {
    const at = css.indexOf("html[data-tv='1'] .app-header {")
    expect(at, '找不到 TV 顶栏规则').toBeGreaterThan(-1)
    const inLayer = layerRanges(css).find((r) => at > r.start && at < r.end)
    expect(
      inLayer,
      `TV 顶栏规则落在 @layer ${inLayer?.name} 里 —— utilities 层的 .text-sm 会盖掉它，` +
        '电视上字号不会变。必须放到层外。',
    ).toBeUndefined()
  })

  it('覆盖的是顶栏里真实使用的字号类（text-sm / text-[13px] / text-xs）', () => {
    expect(css).toContain("html[data-tv='1'] .app-header .text-sm")
    expect(css).toContain('html[data-tv=\'1\'] .app-header .text-\\[13px\\]')
  })

  it('字号大于 Web 端基准（14px），否则"调大"是空话', () => {
    const m = /html\[data-tv='1'\] \.app-header \.text-sm\s*\{\s*font-size:\s*([\d.]+)rem/.exec(css)
    expect(m, '找不到 text-sm 的 TV 字号').toBeTruthy()
    expect(Number(m![1]) * 16).toBeGreaterThan(16)
  })
})

describe('电视壳必须让前端认得出这是 TV', () => {
  const java = readFileSync(MAIN_ACTIVITY, 'utf8')

  it('MainActivity 的 UA 带 MeowTV 标记', () => {
    // isTvEnv() 的正则是 /MeowTV/i（不认 meow-tv 这种连字符写法）
    // 用行匹配而非 `setUserAgentString\([^)]*` —— 内层 getUserAgentString() 还有括号，
    // [^)]* 会在第一个 ) 处截断，永远匹配不到后面的字符串。
    const line = java.split('\n').find((l) => l.includes('setUserAgentString') && l.includes('"'))
    expect(line, 'UA 没带 MeowTV，isTvEnv() 返回 false，整套电视适配失效').toBeTruthy()
    expect(line).toContain('MeowTV')
  })

  it('标记写法与 isTvEnv 的正则一致（大小写不敏感，但不能有连字符）', () => {
    // 实际代码：s.setUserAgentString(s.getUserAgentString() + " MeowTV");
    // 简单贪婪到行尾更稳（内层还有一对括号，[^)]* 会提前截断）
    const line = java
      .split('\n')
      .find((l) => l.includes('setUserAgentString') && l.includes('+' ) && !l.includes('*'))
    expect(line, '找不到 UA 追加语句').toBeTruthy()
    const m = /"([^"]*)"/.exec(line!)
    expect(m, `这一行没有字符串字面量：${line}`).toBeTruthy()
    expect(/MeowTV/i.test(m![1]), `UA 追加的是 "${m![1]}"，isTvEnv 的 /MeowTV/i 匹配不上`).toBe(
      true,
    )
  })
})

describe('遥控焦点框', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('焦点样式有可见的描边（不是只加 class）', () => {
    expect(nav).toContain('meow-tv-focus')
    /*
     * 2026-10-29 从 outline 改成双层 box-shadow：
     *   · outline 不跟随元素圆角（药丸被改成圆角矩形）
     *   · box-shadow 自动跟随自身圆角
     * 所以断言改成"有可见的 3px 描边"，不再钉死 outline 语法。
     */
    /*
     * 2026-11-04 定稿形态：`inset 1px 半透明白 + 2px accent + 12px accent 辉光`。
     *   · 纯 accent 环画在实心 accent 按钮上同色连成一片，等于没有焦点提示；
     *   · 纯白 2px 硬环又太扎眼（用户反馈）。
     * 所以内沿给一条 1px 高光、外面 accent 环 + accent 辉光（blur 自带渐变，
     * 也顺带解决了原来 halo 兜底写死青色、换肤不跟随的问题）。
     */
    // 2026-11-06：内线改成主题感知 token（深色白线 / 浅色深线），
    // 白线作为 var() 的兜底值仍然要在
    expect(nav).toMatch(/box-shadow:inset 0 0 0 \d+px var\(--tv-focus-inner,rgba\(255,255,255/)
    expect(nav).toMatch(/0 0 0 \d+px var\(--color-accent/)
    expect(nav, '辉光应当是 accent 的模糊影（渐变），不是另外写死的颜色').toMatch(
      /0 0 \d+px \d+px var\(--color-accent/,
    )
    // 不能写死圆角：那会把 rounded-full 的药丸改成圆角矩形
    const css = nav.slice(nav.indexOf('FOCUS_CSS'), nav.indexOf('FOCUS_CSS') + 1400)
    expect(css, '焦点样式写死了 border-radius').not.toMatch(/\.meow-tv-focus\{[^}]*border-radius/)
  })

  it('进页面就自动给第一个元素焦点（电视上没有任何别的输入方式）', () => {
    expect(nav, '缺初始聚焦：用户面对"没有选中框"的界面').toContain('initialFocus')
    expect(nav).toMatch(/setTimeout\(initialFocus/)
  })

  it('注入样式时兜底 document.head 可能还没解析出来', () => {
    // onPageFinished 可能在 readyState='interactive' 时触发，此时 head 可能为 null，
    // 直接 document.head.appendChild 会静默失败 → 焦点逻辑对但看不见框
    expect(nav).toMatch(/document\.head \|\| document\.documentElement/)
  })
})

describe('电视遥控焦点（实测踩过的三处）', () => {
  const nav = readFileSync(TV_NAV, 'utf8')
  const INDEX_HTML = join(REPO, 'client', 'apps', 'web', 'index.html')
  const html = readFileSync(INDEX_HTML, 'utf8')

  it('重复注入时重建整套逻辑（reload 后旧闭包的 observer 是死的）', () => {
    /*
     * 2026-10-30 订正：原断言是"补装样式 + return"。那个做法在 WebView reload
     * 之后会让整套导航**静默失效**——window 上的函数还在（旧闭包），
     * 但它的 MutationObserver 绑在旧 documentElement 上，收不到新文档变化。
     * 症状：弹层不聚焦当前值、关闭不还焦点、初始落点不生效，
     * 而手动调一次 __meowTvNav 就全好了（极易误判成"逻辑没写对"）。
     * 现在改成 dispose 旧闭包再重建全部。
     */
    expect(nav, '没有 dispose 入口').toContain('window.__meowTvDispose')
    const head = nav.slice(0, nav.indexOf('var FOCUSABLE'))
    const codeLines = head
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    expect(
      codeLines.some((l) => l.includes('if (window.__meowTvNav)')),
      '还留着旧守卫：reload 后 observer 会绑在旧 documentElement 上',
    ).toBe(false)
    // 样式仍要有幂等安装（重复注入不该产生两份 <style>）
    expect(nav).toContain("document.getElementById('meow-tv-focus-style')")
  })

  it('首个焦点落在内容区，不是顶栏', () => {
    expect(nav).toContain('firstContentItem')
    // 顶栏 logo/豆瓣 是 DOM 第一个可聚焦元素，按 DOM 顺序取会命中它。
    // 两处都要走 firstContentItem（initialFocus 与 MutationObserver 兜底）。
    const uses = nav.match(/firstContentItem\(all\)/g) || []
    expect(uses.length, 'firstContentItem 没被实际调用').toBeGreaterThanOrEqual(2)
  })

  it('路由切换重新落焦点（pushState 也要，不只是 hashchange）', () => {
    /*
     * 踩过：重置只挂在 window 的 hashchange 上。Vue Router 用
     * history.pushState，**不触发 hashchange** —— 于是"点顶栏/点卡片换页"
     * 不重置焦点，只有手动改地址栏/浏览器后退才生效。
     *
     * 更隐蔽的是这个 bug 用 location.hash=… 测不出来（那正好走 hashchange），
     * 所以必须有这条源码契约锁着。
     */
    expect(nav, '没有包 pushState').toMatch(/history\.pushState\s*=/)
    expect(nav, '没有包 replaceState').toMatch(/history\.replaceState\s*=/)
    expect(nav, 'popstate 没接（前进/后退会漏）').toContain("'popstate'")
    // 同 URL 的 replaceState 不能重置，否则滚动位置更新会把焦点抢回第一个
    expect(nav, '没有做 URL 变化判断').toContain('lastHref')
  })

  it('用户按过键之后不再抢焦点', () => {
    expect(nav).toContain('userMoved')
    // 方向键与确认键都要置位。
    // ★ 按函数体边界切片，不要用固定长度窗口：函数里补一段注释就会让
    //   窗口切不到末尾，测试变成"注释长度检测"（已经踩过一次）。
    const moveBody = fnBody(nav, 'function move(')
    expect(moveBody, 'move() 里没有置位 userMoved').toContain('userMoved = true')
    const enterBody = fnBody(nav, 'function enter(')
    expect(enterBody, 'enter() 里没有置位 userMoved').toContain('userMoved = true')
  })

  it('首帧脚本按 UA 落 data-tv（CSS 的电视样式全靠它）', () => {
    // 踩过：只有 isTvEnv() 读 UA，而 html[data-tv='1'] 属性从未被设置，
    // 于是顶栏字号、cursor:none 全部静默失效。
    expect(html).toMatch(/\/MeowTV\/i\.test\(navigator\.userAgent\)/)
    expect(html).toContain("setAttribute('data-tv', '1')")
  })

  it('电视上禁用鼠标指针', () => {
    const css = readFileSync(TOKENS, 'utf8')
    expect(css).toMatch(/html\[data-tv='1'\][\s\S]{0,80}cursor:\s*none/)
  })

  /*
   * 下面三条锁的是同一类症状：**焦点走不到用户想去的元素**。
   * 它们都只在 TV 上出现（web 用滚轮/鼠标），只靠单测跑不到，所以按
   * 源码契约锁住——改坏了测试先红。
   */
  it('上键不因顶栏 sticky 而永远跳顶栏（滚不回页面顶部）', () => {
    // 顶栏 sticky 常驻，中心 y≈32；焦点卡片滚到顶上后 y≈114，
    // 差 82 → 上键永远选顶栏，胶囊分类够不到。
    expect(nav, '缺少钉住层判定').toContain('function pinned(')
    const findBody = fnBody(nav, 'function find(')
    expect(findBody, 'find() 没把钉住层排除在几何竞争之外').toContain('includePinned')
    // 页面到顶时才允许带上钉住层再扫一次
    const moveBody = fnBody(nav, 'function move(')
    expect(moveBody, '没有"到边界才允许进顶栏"的二次扫描').toMatch(/find\(dir, true\)/)
  })

  it('滚进视口时让出顶栏高度（否则焦点框被顶栏盖住）', () => {
    expect(nav).toContain('stickyTopHeight')
    expect(nav).toContain('padTop')
    // 焦点本身在顶栏里时不能让，否则每次移动都 window.scrollBy 把页面往上顶
    expect(nav).toMatch(/header\.contains\(el\)/)
  })

  it('无内聚元素的滚动区可被遥控器翻页（data-tv-scroll）', () => {
    expect(nav).toContain('data-tv-scroll')
    expect(nav).toContain('scrollStep')
    // 滚到头必须把按键还回去，否则焦点被困在这块区域里出不来
    const moveBody = fnBody(nav, 'function move(')
    expect(moveBody).toMatch(/scrollStep\(marked, dir\)/)
  })

  it('菜单键打开卡片操作（hover 按钮遥控器够不到）', () => {
    const mainActivity = readFileSync(MAIN_ACTIVITY, 'utf8')
    expect(mainActivity, '壳没有把 KEYCODE_MENU 转给页面').toContain('KEYCODE_MENU')
    expect(mainActivity).toContain('__meowTvMenu')
  })

  it('输入框可借原生对话框打字（WebView 不对合成点击弹输入法）', () => {
    const mainActivity = readFileSync(MAIN_ACTIVITY, 'utf8')
    // 原生输入框弹出时必须把按键交还系统，否则方向键/确认键被吞，卡在对话框里
    expect(mainActivity).toContain('NativeInput.active()')
    const enterBody = fnBody(nav, 'function enter(')
    expect(enterBody, 'tv-nav 没调用原生输入').toContain('inputText')
    // 标了 data-tv-input-owner 的要退回 click，交给页面自己"输入 + 提交"。
    // 否则顶栏/搜索页打完字不搜索，用户要再按一次 ok。
    expect(enterBody).toContain('data-tv-input-owner')
  })

  it('只在会被输入法遮住的输入框上弹原生框（上方就地打字）', () => {
    // 判据是几何位置：输入框底部越过视口中线才算"可能被遮"。
    // 搜索页/顶栏的框在上方（实测 bottom 162 / vh 720），弹原生框纯属多一步。
    const enterBody = fnBody(nav, 'function enter(')
    expect(enterBody, 'tv-nav 没有位置判断').toContain('needsNativeInput')
    expect(nav).toContain('function needsNativeInput(')
    expect(enterBody, '就地输入没弹系统输入法，用户会看到"有框打不了字"').toContain('showIme')

    // 页面侧两条路径（tv-nav 接管 / 页面接管）必须用同一个判据
    const bridge = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'api', 'nativeBridge.ts'),
      'utf8',
    )
    expect(bridge).toContain('export function shouldUseNativeInput')
    expect(bridge).toContain('export function beginInlineInput')
    // 搜索页里那个框照旧走公共判据（它确实可能被输入法遮住）
    const searchView = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SearchView.vue'),
      'utf8',
    )
    expect(searchView, 'SearchView 没走公共判据').toContain('shouldUseNativeInput')
    expect(searchView, 'SearchView 没做就地输入').toContain('beginInlineInput')

    /*
     * 顶栏搜索框不再自己扛输入（2026-11-04 用户要求：点击/OK 直接进搜索页）。
     * 它曾经也走 shouldUseNativeInput + beginInlineInput，结果是"点一下就在
     * 顶栏原地打字"，而顶栏既窄、遥控器又打不了几个字，用户要的是进搜索页
     * （那里有输入框、范围切换、最近搜索回看）。
     */
    const header = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'components', 'layout', 'AppHeader.vue'),
      'utf8',
    )
    expect(header, '顶栏没跳搜索页').toContain("router.push({ name: 'search' })")
    expect(header, '顶栏还在自己接输入').not.toContain('beginInlineInput')
  })

  it('原生输入框跟随主题配色（系统默认灰底和深色 UI 不像一套）', () => {
    const bridge = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'api', 'nativeBridge.ts'),
      'utf8',
    )
    // 页面把**当前生效**的 CSS 变量值传给原生，四套主题自动跟随
    expect(bridge).toContain('getComputedStyle')
    expect(bridge).toContain('--color-base')
    const tvBridge = readFileSync(
      join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'TvBridge.java'),
      'utf8',
    )
    expect(tvBridge, 'inputText 没接收 theme 参数').toMatch(/inputText\(String title, String initial, boolean mask, String themeJson\)/)
    expect(tvBridge).toContain('InputTheme')
  })
})

/**
 * 2026-10-29 实测修复的三条（MuMu 上逐条验证过）。
 *
 * 共同点：都是"代码看着对、电视上行为不对"，普通单测抓不到，只能锁源码契约。
 */
describe('电视焦点与深链（2026-10-29 实测）', () => {
  const nav = readFileSync(TV_NAV, 'utf8')
  const mainActivity = readFileSync(MAIN_ACTIVITY, 'utf8')

  it('顶栏上键到顶后停住，不再回内容区形成自环', () => {
    /*
     * 2026-11-03 验收：原逻辑在滚不动时回 `firstContentItem`（设置页是
     * 左栏「置顶」），从「置顶」再按 ↑ 又被钉住层送回顶栏「直播」，
     * 形成 `片库 → 置顶 → 直播 → 置顶…` 自环。
     * 新口径：顶栏到顶后直接停住；回内容区走 ↓。
     */
    const lines = nav.split(/\r?\n/)
    const i = lines.findIndex((l) => l.trim().startsWith("if (dir === 'up'"))
    expect(i, '找不到顶栏上键分支').toBeGreaterThan(-1)
    const block = lines.slice(i, i + 24).join('\n')
    expect(block, '滚不动时仍在回内容区').not.toContain('firstContentItem')
    expect(block, '滚不动时没有 return false 停住').toMatch(/userMoved = true\s*return false/)
  })

  it('顶栏 ↓ 优先回主内容滚动区第一项，不落到左栏「置顶」', () => {
    /*
     * 2026-11-03 验收：设置页从顶栏「片库」按 ↓，几何上左栏「置顶」
     * （y≈97）比右栏第一个输入框（y≈140）更近，会进左导航。
     * 新口径：header ↓ 先取主内容滚动区第一个可聚焦项。
     */
    const at = nav.indexOf("if (dir === 'down' && marked && marked.closest('.app-header')")
    expect(at, '找不到顶栏下键分支').toBeGreaterThan(-1)
    const block = nav.slice(at, at + 700)
    expect(block, '顶栏↓没有走主内容滚动区').toContain('firstContentInScrollHost')
  })

  it('设置页首焦点落在左侧导航（data-tv-first），不是「置顶」', () => {
    /*
     * 设置页是两栏布局，导航 <nav> 在 <main> 外面，firstContentItem 抓不到，
     * 于是回落到 all[0] = 顶栏豆瓣。用 data-tv-first 显式指定。
     */
    const settings = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    expect(settings, '设置页没标 data-tv-first').toContain('data-tv-first')
    expect(nav, 'tv-nav 没实现 preferredItem').toContain('preferredItem')
  })

  it('焦点框颜色跟随主题，不写死颜色', () => {
    // 硬编码 #ffcc4d 时，换主题后焦点框仍是黄色，与整体配色不搭。
    expect(nav).toContain('--color-accent')
    // 窗口放宽到 1400：FOCUS_CSS 之前有一段解释环形态的注释（2026-11-04）
    const focusCss = nav.slice(nav.indexOf('FOCUS_CSS'), nav.indexOf('FOCUS_CSS') + 1400)
    expect(focusCss, '焦点框颜色写死了').not.toMatch(/#ffcc4d/i)
    expect(focusCss).toMatch(/var\(--color-accent/)
  })

  it('intent 带的深链 hash 必须拼进 loadUrl', () => {
    /*
     * 踩过：loadBuiltin 里硬编码 `http://meow.local/index.html`，而
     * `K_URL` 只写不读 —— 外部 `am start -a VIEW -d '...#/play/...'`
     * 进来后 hash 被重置成 `#/`，用户停在首页。表现为"深链不生效"，
     * 但路由和播放本身都是好的（会话内直接写 hash 能播）。
     */
    expect(mainActivity, '没有解析 intent 的 hash').toContain('hashOf')
    expect(mainActivity, 'hash 没拼进 loadUrl').toMatch(/pendingHash/)
    expect(mainActivity, '没有从 Intent.getData() 取 fragment').toContain('getFragment')
  })
})
