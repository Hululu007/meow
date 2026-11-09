import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 2026-10-30 用户在 MuMu 上点单的四条：
 *
 *   1. 顶栏右键落点不稳（从「AI」按右键有时落搜索框、有时掉进内容区并切了分类）
 *   2. 左导航右键进不去右栏（焦点在「01 连接」按右键落回左栏「置顶」）
 *   A. 弹框/下拉框打开时，返回键优先关它，并聚焦回原位置
 *   B. 弹框/下拉框打开时，聚焦框内第一个元素或当前值（首页源下拉没聚焦当前源）
 *
 * 这四条都只在电视上暴露（web 用鼠标），普通单测跑不到。
 * 所以按源码契约锁住，改坏了测试先红。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const TV_NAV = join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js')

/** 取一个顶层函数的函数体（按大括号配平）。 */
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

describe('问题 1：顶栏左右键不许掉进内容区', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('起点在钉住层（顶栏）时，左右键只在钉住层内找', () => {
    /*
     * 踩过：几何竞争里顶栏右侧 AI 图标的下方也可能有内容区元素在 dx>4
     * 范围内，一旦争赢焦点就掉进海报墙，用户要按好几下上键才回得来。
     * 顶栏是一维的（只有左右有意义），所以候选范围直接收窄到顶栏内。
     */
    const findBody = fnBody(nav, 'function find(')
    expect(findBody, '没有"顶栏内一维移动"分支').toMatch(/pinned\(from\)[\s\S]{0,80}dir === 'left'/)
    expect(findBody, '没有把候选收窄到钉住层').toMatch(/all\.filter\(function \(x\) \{ return pinnedCached\(x\) \}\)/)
  })

  it('顶栏里走到头就停住（返回 false），不许放行到内容区', () => {
    const findBody = fnBody(nav, 'function find(')
    // 找到顶栏分支里的 "找不到就停住"
    const at = findBody.indexOf('barOnly')
    expect(at).toBeGreaterThan(-1)
    const tail = findBody.slice(at, at + 900)
    expect(tail, '顶栏到头没有 return false 停住').toMatch(/userMoved = true[\s\S]{0,120}return false/)
  })

  it('上下键不受这条影响（离开顶栏的正常出口）', () => {
    /*
     * 只按"真实代码行"找（行首是 if），不按 indexOf ——
     * 注释里也写着 pinned(from) 和 dir === 'left'，按 indexOf 会命中注释。
     */
    const findBody = fnBody(nav, 'function find(')
    const line = findBody
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('if (pinned(from)'))
    expect(line, '找不到顶栏左右键分支的 if 行').toBeTruthy()
    expect(line).toMatch(/dir === 'left' \|\| dir === 'right'/)
  })
})

describe('问题 2：左导航右键要进得去右栏', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('左右键会排除"横向被包住且不在同一行"的候选', () => {
    /*
     * 踩过：设置页左导航「置顶」按钮靠右对齐，横向区间被当前导航项完全
     * 包住 → 主轴区间距离 0（满分），垂直只差 30px → 总分 60；
     * 右栏元素横向要走 32+32=64 → 「置顶」赢，焦点跳回本栏。
     * 按几下 ↓ 后「置顶」垂直拉开，右栏才终于胜出 —— 正是"按几下才进得去"。
     */
    const impl = fnBody(nav, 'function scanImpl(')
    expect(impl, '没有横向包含判据').toContain('strict')
    expect(impl, '判据里没有横向包含的比较').toMatch(
      /b\.left >= a\.left - 4 && \(b\.left \+ b\.width\) <= \(a\.left \+ a\.width\) \+ 4/,
    )
    // 纵向不重叠才算"不同行"，同一行的行内子控件（角标、清除按钮）要留着
    expect(impl, '没有排除"同一行"的情况').toMatch(/b\.top < a\.top \+ a\.height - 4/)
  })

  it('严格轮没找到候选时放开重扫（避免"按右键没反应"）', () => {
    /*
     * 严格轮会连弹层里全宽输入框下方的「确定/取消」一起滤掉，
     * 那是"按右键毫无反应"——比落点不准更糟。
     */
    const scanBody = fnBody(nav, 'function scan(')
    expect(scanBody).toContain('scanStrict')
    expect(scanBody, '严格轮无候选时没有放开兜底').toMatch(/return scanImpl\(all, from, dir, skipPinned, false, regionMode, rowFree\)/)
  })

  it('上下键不走严格判据（表单里紧邻的下一行必须够得到）', () => {
    const scanBody = fnBody(nav, 'function scan(')
    expect(scanBody).toMatch(/dir === 'up' \|\| dir === 'down'/)
  })
})

describe('弹层上拉列表：上键不能用整屏滚动', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('顶栏"滚页面"分支必须排除弹层内的元素', () => {
    /*
     * 踩过（用户反馈「源下拉框，聚焦位于最低处时下键能显示完整聚焦，
     * 上键时聚焦被遮挡到下面了」，2026-10-30 MuMu 实测）：
     * 站点下拉是 `absolute` 定位、**DOM 上嵌在 .app-header 里面**，
     * 每个下拉项都满足 closest('.app-header')。于是上键走"滚页面"分支，
     * 按下拉自身 clientHeight×0.6（446×0.6=268px）整块滚动，
     * 焦点一步没动却被推出可视区。
     * 实测：scrollTop 856→588→320→52→0，焦点 top 461→729→997→1265→1317。
     * 下键不走这个分支，所以症状只在向上时出现。
     */
    const moveBody = fnBody(nav, 'function move(')
    /*
     * 条件跨两行（`&& !marked.closest(...)` 另起一行），按"首个 if 行 + 后一行"取。
     */
    const lines = moveBody.split(String.fromCharCode(10)).map((l) => l.trim())
    const at = lines.findIndex((l) => l.startsWith("if (dir === 'up' && marked"))
    expect(at, '找不到顶栏上键分支').toBeGreaterThan(-1)
    const cond = lines.slice(at, at + 3).join(' ')
    expect(cond, '顶栏上键没排除弹层内的元素').toContain("!marked.closest('[data-tv-scope]')")
  })

  it('scrollIntoViewWithin 也不把弹层元素当"在顶栏里"', () => {
    // 同一个坑的第二处：命中 header.contains(el) 就 return，弹层不做最小滚动
    expect(nav).toContain("header.contains(el) && !el.closest('[data-tv-scope]')")
  })

  it('下键没有对称的整屏滚动分支（header↓ 只回内容区）', () => {
    const moveBody = fnBody(nav, 'function move(')
    /*
     * 2026-11-03：header↓ 新增了“回主内容滚动区第一项”的落点分支，
     * 但它不能像 header↑ 那样 scrollPageUp() 整屏滚。只校验这一点，
     * 不要再用“出现 dir === 'down'”作为失败判据。
     */
    const at = moveBody.indexOf("if (dir === 'down' && marked && marked.closest('.app-header')")
    if (at >= 0) {
      const block = moveBody.slice(at, at + 500)
      expect(block, 'header↓ 走了整屏滚动').not.toContain('scrollPageUp')
    }
  })
})

describe('弹层关闭后的"一瞬跳走"与旧闭包定时器', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('dispose 后旧闭包的异步回调必须直接退出', () => {
    /*
     * 踩过（用户原话「关闭弹框后，似乎有一瞬是从添加片库 聚焦到 本地片库
     * 去了」，2026-10-30 抓栈定位）：只 observer.disconnect() 不够 ——
     * 旧闭包已排好的 setTimeout(initialFocus, 120/700) 和 observer 的
     * 300ms 防抖仍会跑，它们读的是**旧闭包的** userMoved / pinUntil
     * （永远停在旧值），于是把新闭包刚恢复的焦点改掉。
     * 抓栈证据：highlight ← initialFocus，t=2344 落焦、t=2429 被覆盖。
     */
    expect(nav).toContain('var disposed = false')
    expect(nav, 'dispose 没置位').toMatch(/window\.__meowTvDispose = function \(\) \{\s*disposed = true/)
    // 所有异步/公开入口都要判
    const initBody = fnBody(nav, 'function initialFocus(')
    expect(initBody, 'initialFocus 没判 disposed').toContain('if (disposed) return')
    expect(nav, 'observer 回调没判 disposed').toMatch(/new MutationObserver\(function \(\) \{\s*if \(disposed\) return/)
  })

  it('pin 落点有不受路由重置影响的时间窗', () => {
    /*
     * onRouteChange() 会 userMoved = false，正好晚于 useReturnRestore 的
     * 落焦（pushState 被 Vue 推到 DOM 更新之后），单靠 userMoved 挡不住。
     */
    expect(nav).toContain('pinUntil')
    const onRoute = fnBody(nav, 'function onRouteChange(')
    expect(onRoute, 'onRouteChange 无条件重置 userMoved').toContain('pinUntil')
    const initBody = fnBody(nav, 'function initialFocus(')
    expect(initBody, 'initialFocus 没让路给 pin 窗口').toContain('pinUntil')
  })
})

describe('返回兜底判据 + TV 钩子不该挂到 Web 上', () => {
  const APP = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'App.vue'), 'utf8')

  it('RouteBack 的兜底判据是"路由变了没"，不是"到没到首页"', () => {
    /*
     * 踩过（用户反馈「电视剧榜单 进入详情页后，返回直接回首页了。
     * 胶囊选中失效了」）：原来写 `if (!isHomeRoute()) router.push('/')`。
     * 分类页 → 详情页 → 返回时 back() 成功退到分类页（`/category/xxx`），
     * 它不是首页 → 260ms 后又强推首页 → 中间那层被跳过、胶囊选中也没了。
     */
    const at = APP.indexOf('W.__meowTvRouteBack = ')
    expect(at, '找不到 __meowTvRouteBack').toBeGreaterThan(-1)
    const body = APP.slice(at, at + 2200)
    expect(body, '没记住 back 前的路径').toContain('const before = route.fullPath')
    expect(body, '兜底没判"路由有没有变"').toContain('route.fullPath !== before')
    // 不能再是"不在首页就 push"
    expect(body, '仍是"不在首页就 push 首页"').not.toMatch(
      /if \(!isHomeRoute\(\)\) router\.push\(\{ name: 'home' \}\)/,
    )
  })

  it('TV 专属返回链必须先判"是不是电视壳"', () => {
    /*
     * 2026-10-30 无头 Edge 实测：Web 端 `__meowTvRouteBack` 也被挂上了
     * （typeof 是 function）。浏览器永远不调它所以无害，但语义上它是
     * TV 壳的钩子，出现在 Web 上会误导后来人。
     */
    expect(APP, '没有 TV 环境判据').toContain('function isTvShell(')
    const body = APP.slice(APP.indexOf('function shouldOwnBackKey('), APP.indexOf('function syncTvBackOwnership('))
    // 跳过函数签名行与注释，取第一条真实语句
    const stmts = body
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('function ') && l !== '{')
    expect(stmts[0], 'shouldOwnBackKey 第一句不是 isTvShell 判断').toContain('isTvShell()')
    // onMounted 里不能再无条件 install：只允许出现在 syncTvBackOwnership 内部
    const mountedCall = APP.split(String.fromCharCode(10))
      .filter((l) => l.trim() === 'installTvBackHandler()')
    expect(
      mountedCall.length,
      '还有"无条件 installTvBackHandler()"的调用（浏览器也会挂上 TV 钩子）',
    ).toBeLessThanOrEqual(1)
  })
})

describe('页面内弹框的层叠上下文（会被顶栏盖住）', () => {
  it('站点明细弹框必须 Teleport 到 body', () => {
    /*
     * 踩过（用户原话「弹框会被顶栏遮挡啊。其他弹框也这样吗？」）：机理是
     * 层叠上下文，不是 z-index 数字大小 ——
     *   · App.vue 的 `<main class="relative z-10">` 创建了层叠上下文；
     *   · 不 Teleport 的弹框是 main 的后代，它自己的 z-40 只在 main 内比较；
     *   · 顶栏 `sticky z-30` 是 main 的**兄弟** → 30 > 10，整体压住弹框。
     * 所以把 z 调到 10000 也没用，必须跳出 main。
     * 其他弹框（连接设置 / CenterDialog / UpdateDialog）有同样隐患，
     * 只是中央内容恰好没压到 y<72，暂时没暴露。
     */
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    // 用弹层注释的独有标题定位，避免命中 closeSites 的 JSDoc
    const at = src.indexOf('为什么用弹框而不是原地展开')
    expect(at, '找不到站点明细弹层').toBeGreaterThan(-1)
    /*
     * ★ 不能用"固定 6000 字符窗口"。
     * 踩过（2026-10-30）：给这个弹框加了筛选/批量操作 UI 之后，
     * 从注释到 `</Teleport>` 跨了 222 行、超过 6000 字符，
     * 窗口截断导致断言失败 —— 看起来像"弹框没 Teleport"，实际是有的。
     * 改成取到**第一个** `</Teleport>` 为止，长度由内容决定。
     */
    const tail = src.slice(at)
    const close = tail.indexOf('</Teleport>')
    expect(close, '注释之后找不到 </Teleport>').toBeGreaterThan(-1)
    const block = tail.slice(0, close + '</Teleport>'.length)
    expect(block, '没有 Teleport，会被顶栏盖住').toContain('<Teleport to="body">')
    expect(block, '弹框没排除在 main 内').toMatch(/z-\[120\]/)
  })

  it('站点明细两行布局（一行塞不下会横向溢出）', () => {
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    expect(src, '没有两行布局').toContain('两行布局，不要挤成一行')
    // api 必须可截断，否则长 URL 会把整行顶宽
    expect(src).toMatch(/min-w-0 max-w-\[22rem\] shrink truncate/)
  })
})

describe('弹框关闭后的焦点归还：fallback 优先', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('调用方给的选择器优先于自动记录的打开者', () => {
    /*
     * 踩过（2026-10-30 站点明细，逐帧追踪）：关闭瞬间 t=20ms 焦点在弹框内，
     * t=40ms 直接变成左导航「01 连接」——从未经过触发按钮，而函数返回 true。
     * 原因：`scopeReturnEl` 存着一个不可用元素（鼠标打开时没有 enterOpener，
     * 第三级兜底抓到 document.activeElement，多半是别的东西）。
     * 旧代码只在 `!back` 时才用 fallback，于是永远轮不到兜底。
     */
    const body = fnBody(nav, 'window.__meowTvScopeClosed = function')
    expect(body).toContain('fallbackSelector')
    // 不能再是 `if (!back && fallbackSelector)`
    expect(body, 'fallback 仍只在 back 为空时生效').not.toContain('if (!back && fallbackSelector)')
  })

  it('归还焦点后要钉住（否则又被 observer 抢走）', () => {
    const body = fnBody(nav, 'window.__meowTvScopeClosed = function')
    expect(body, '没设 userMoved').toContain('userMoved = true')
    expect(body, '没设 pinUntil').toContain('pinUntil = Date.now()')
  })

  it('closeSites 把触发按钮作为兜底选择器传下去', () => {
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    expect(src).toContain('data-tv-key="settings-sites"')
    const call = '__meowTvScopeClosed(' + String.fromCharCode(39) + '[data-tv-key="settings-sites"]' + String.fromCharCode(39) + ')'
    expect(src, 'closeSites 没传兜底选择器').toContain(call)
  })
})

describe('返回落点：设置页回当前分区 / 片库回原按钮', () => {
  it('设置页返回落到左侧菜单当前高亮项（不是第一项）', () => {
    /*
     * 用户原话（2026-10-30 第二次纠正）：「设置页 配置区的返回，聚焦从第一位
     * 置 调整到左侧菜单栏 竖条处（定位处）」。
     * 左栏每项左侧有一根 active 竖条 = `aria-current="true"` 那一项。
     * 原来固定取第一个 `button.group`，用户在「播放设置」按返回会跳回最上面的
     * 「01 连接」，还得再按十几下才能回原位。
     */
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    const at = src.indexOf('function focusSettingsNavFirst(')
    expect(at, '找不到 focusSettingsNavFirst').toBeGreaterThan(-1)
    const body = src.slice(at, at + 900)
    expect(body, '没有按当前高亮项取落点').toContain('aria-current="true"')
    // 优先用当前项，兜底才是第一项
    const curAt = body.indexOf('aria-current="true"')
    const firstAt = body.indexOf("nav.querySelector('button.group')")
    expect(curAt).toBeGreaterThan(-1)
    expect(firstAt).toBeGreaterThan(-1)
    expect(curAt, '先取第一项再取当前项 → 当前项永远轮不到').toBeLessThan(firstAt)
  })

  it('片库「添加片库」按钮有稳定锚点（nth-child 路径太脆）', () => {
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'LibraryView.vue'),
      'utf8',
    )
    expect(src, '添加片库按钮没有稳定标识').toContain('data-tv-key="library-add"')
  })

  it('焦点恢复失败要重试（不能因滚动到位就停）', () => {
    /*
     * 踩过（实测「片库页添加弹框返回没聚焦到原位置」）：
     * 原来只判 window 滚动量，top=0 时首帧就判定"完成"并停止重试，
     * 可那一刻目标按钮还没渲染出来，querySelector 命中不到。
     * 表现：sessionStorage 记录被正常消费了，焦点却落在别处。
     */
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'composables', 'useReturnRestore.ts'),
      'utf8',
    )
    expect(src, '焦点没单独判完成').toContain('focusDone')
    expect(src, '重试条件没带 focusDone').toMatch(/\(!scrollDone \|\| !focusDone\)/)
  })

  it('恢复焦点走 __meowTvFocus（手动加 class 会丢 current 索引）', () => {
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'composables', 'useReturnRestore.ts'),
      'utf8',
    )
    expect(src).toContain('__meowTvFocus')
    // pin=true 挡住 initialFocus 的 60ms/1200ms 兜底落点
    expect(src, '没传 pin，恢复完会被 initialFocus 覆盖').toContain('__meowTvFocus(target, true)')
  })
})

describe('WebView reload 后必须重新接管（否则 observer 是死的）', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('重复注入时先 dispose 旧闭包，不能只补样式就 return', () => {
    /*
     * 踩过（2026-10-30，症状极难定位）：
     * 原守卫是 `if (window.__meowTvNav) { 补样式; return }`。
     * WebView reload 之后 window 上的函数还在（同一 JS 上下文），
     * 但 document / documentElement 已经换了新的 —— 于是：
     *   · __meowTvNav 来自旧闭包，按键时照样能跑（看着"导航正常"）
     *   · 旧闭包的 MutationObserver 绑在**旧 documentElement** 上，
     *     收不到新文档任何变化 → activeScope() 永远不被调用
     *   · 结果：弹层不聚焦当前值、关闭不还焦点、初始落点不生效
     * 实测判据：往 body 插一个 [data-tv-scope] 假弹层，焦点不动、
     * hasLastScope 恒 false；而手动调一次 __meowTvNav 立刻全好。
     */
    const head = nav.slice(0, nav.indexOf('var FOCUSABLE'))
    expect(head, '注入头部没有调用 dispose').toContain('window.__meowTvDispose')
    // 不能残留"只样式就 return" 的老守卫（那个守卫会让 reload 后的闭包彻底失效）
    // 只查真实代码行：注释里参考了旧写法，indexOf 会命中注释
    const codeLines = head
      .split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    expect(
      codeLines.some((l) => l.includes('if (window.__meowTvNav)')),
      '还留着 if (window.__meowTvNav) 的提前返回',
    ).toBe(false)
  })

  it('dispose 会断开 observer 并清掉记住的弹层状态', () => {
    const body = fnBody(nav, 'window.__meowTvDispose = function')
    expect(body, 'dispose 没断开 observer').toContain('observer.disconnect()')
    expect(body, 'dispose 没清 lastScopeEl').toContain('lastScopeEl = null')
    expect(body, 'dispose 没清 scopeReturnEl').toContain('scopeReturnEl = null')
  })

  it('dispose 会摘掉 window 上的全局监听', () => {
    // 同一文档重复注入时，多份 onRouteChange 各拿过期 DOM 引用跑（必乱）
    expect(nav).toContain("window.removeEventListener('popstate', onRouteChange)")
    expect(nav).toContain("window.removeEventListener('hashchange', onRouteChange)")
  })
})

describe('追加 A：关弹框后焦点回原位', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('打开弹层前记下当时的焦点元素', () => {
    const body = fnBody(nav, 'function activeScope(')
    expect(body, '没有记录打开者').toContain('scopeReturnEl')
    // 必须在 focusIntoScope 之前取，否则拿到的是弹层内的新焦点
    const rec = body.indexOf('scopeReturnEl = opener')
    const mov = body.indexOf('focusIntoScope(top)')
    expect(rec).toBeGreaterThan(-1)
    expect(mov).toBeGreaterThan(-1)
    expect(rec, '先搬焦点再记录打开者 → 记到的是弹层内的元素').toBeLessThan(mov)
  })

  it('弹层全部关闭时把焦点还回去', () => {
    const body = fnBody(nav, 'function activeScope(')
    // scope 为空的分支里要还焦点
    const zero = body.indexOf('if (!scopes.length)')
    expect(zero).toBeGreaterThan(-1)
    const block = body.slice(zero, zero + 1600)
    /*
     * 归还逻辑统一委托给 __meowTvScopeClosed（它内部校验存在于 DOM、
     * 可见、可用，并延后一拍等 Vue 摘干净弹层节点）。
     * 两条路径各自实现过一遍时，先跑的那条会把 scopeReturnEl 清掉。
     */
    expect(block, '弹层关闭时没有委托归还').toContain('window.__meowTvScopeClosed()')
    const closedBody = fnBody(nav, 'window.__meowTvScopeClosed = function')
    expect(closedBody, '归还前没校验元素还在 DOM 里').toContain('document.contains(back)')
    expect(closedBody, '归还前没校验可见/可用').toMatch(/visible\(back\)[\s\S]{0,40}usable\(back\)/)
  })

  it('提供同步入口，组件关闭时可以立刻归还（不用等 MutationObserver）', () => {
    expect(nav).toContain('window.__meowTvScopeClosed')
    const body = fnBody(nav, 'window.__meowTvScopeClosed = function')
    expect(body).toContain('scopeReturnEl = null')
    expect(body).toContain('highlight(back)')
  })

  it('记打开者靠 enterOpener，不能只靠事后取 .meow-tv-focus', () => {
    /*
     * 踩过（MuMu 实测，逐轮排查）：弹层出现的那次 MutationObserver 回调里，
     * `.meow-tv-focus` 往往已经在弹层内（Vue 同一次 patch 既插节点又搬焦点），
     * 于是 opener 取不到 → scopeReturnEl 为 null → 关闭后焦点彻底消失。
     * 唯一可靠的取样点是"按下 OK 的那一刻"。
     */
    const enterBody = fnBody(nav, 'function enter(')
    expect(enterBody, 'enter() 没记 enterOpener').toContain('enterOpener = el')
    // 必须在 click 之前赋值
    const setAt = enterBody.indexOf('enterOpener = el')
    const clickAt = enterBody.lastIndexOf('el.click()')
    expect(clickAt).toBeGreaterThan(-1)
    expect(setAt, 'enterOpener 记在 click 之后，那时弹层已经开了').toBeLessThan(clickAt)

    const scopeBody = fnBody(nav, 'function activeScope(')
    expect(scopeBody, 'activeScope 没用 enterOpener 优先').toContain('enterOpener ||')
    // 每次按键清一次，避免一次没开弹层的 OK 污染后续
    const navBody = fnBody(nav, 'window.__meowTvNav = function')
    expect(navBody, '按键入口没清 enterOpener').toContain('enterOpener = null')
  })

  it('归还焦点延后一拍（等 Vue 把弹层节点摘干净）', () => {
    const body = fnBody(nav, 'window.__meowTvScopeClosed = function')
    expect(body, '没有延后还焦点').toContain('setTimeout')
    expect(body, '弹层又开了还去抢焦点').toContain("querySelectorAll('[data-tv-scope]').length")
  })

  it('TileSelect / AppHeader 关闭时调用它', () => {
    for (const f of [
      join('components', 'common', 'TileSelect.vue'),
      join('components', 'layout', 'AppHeader.vue'),
    ]) {
      const src = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', f), 'utf8')
      expect(src, `${f} 关闭后没归还焦点`).toContain('__meowTvScopeClosed')
    }
  })
})

describe('追加 B：弹框打开聚焦第一个元素或当前值', () => {
  const nav = readFileSync(TV_NAV, 'utf8')

  it('focusIntoScope 的优先级含"当前值"', () => {
    const body = fnBody(nav, 'function focusIntoScope(')
    // 优先级：data-tv-first > 当前值 > input > 第一个
    expect(body).toMatch(/aria-selected="true"/)
    expect(body).toContain('data-tv-current')
    const atFirst = body.indexOf("scope.querySelector('[data-tv-first]')")
    const atCur = body.indexOf('aria-selected="true"')
    const atInput = body.indexOf("t === 'input'")
    expect(atFirst).toBeGreaterThan(-1)
    expect(atCur).toBeGreaterThan(atFirst)
    expect(atInput).toBeGreaterThan(atCur)
  })

  it('当前值必须在候选集内（避免焦点落到按不出反应的节点）', () => {
    const body = fnBody(nav, 'function focusIntoScope(')
    expect(body, '没校验当前值是否可聚焦').toContain('candidates.indexOf(declared) >= 0')
  })

  it('弹层打开时不能等按键宽限期（否则焦点搬不进去）', () => {
    /*
     * 踩过：MutationObserver 的 300ms 回调开头就是
     * `if (now - lastKeyAt < 1200) return`。而"按 OK 打开下拉框"本身
     * 就是一次按键 —— 打开瞬间一定在宽限期内，于是 activeScope() 从未
     * 被调用，焦点框留在触发按钮上。这正是"首页源下拉没聚焦当前源"。
     */
    const at = nav.indexOf('var observer = new MutationObserver(')
    expect(at).toBeGreaterThan(-1)
    const block = nav.slice(at, at + 2200)
    /*
     * 按真实代码行定位：宽限期的注释里也写着 lastKeyAt，
     * 用 indexOf('lastKeyAt < 1200') 会命中注释，判据失真。
     */
    const lines = block.split(String.fromCharCode(10))
    const callIdx = lines.findIndex((l) => l.includes('var scopeNow = activeScope()'))
    const graceIdx = lines.findIndex(
      (l) => l.trim().startsWith('if (now - lastKeyAt') && l.includes('1200'),
    )
    expect(callIdx, 'activeScope 没提到宽限期之前').toBeGreaterThan(-1)
    expect(graceIdx, '找不到宽限期判断的真实代码行').toBeGreaterThan(-1)
    expect(
      callIdx,
      'activeScope 仍在宽限期之后 → 弹层打开瞬间搬不动焦点',
    ).toBeLessThan(graceIdx)
  })

  it('弹层内的兜底落点也走 focusIntoScope（不能挑 all[0]）', () => {
    const at = nav.indexOf('var scope = scopeNow')
    expect(at).toBeGreaterThan(-1)
    const block = nav.slice(at, at + 600)
    expect(block, '弹层兜底还在用页面级落点 firstContentItem').not.toContain('firstContentItem')
    expect(block).toContain('focusIntoScope(scope)')
  })

  it('站点下拉把当前源标成 aria-selected（TV 打开就落在那儿）', () => {
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'components', 'layout', 'AppHeader.vue'),
      'utf8',
    )
    expect(src).toContain(':aria-selected="s.key === store.current')
  })

  it('TileSelect 的当前项标 data-tv-current', () => {
    const src = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'components', 'common', 'TileSelect.vue'),
      'utf8',
    )
    expect(src).toContain(':data-tv-current="o.value === modelValue')
  })
})
