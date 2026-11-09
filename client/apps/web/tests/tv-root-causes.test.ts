import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-11-02 第二轮四个问题的门禁。
 *
 * 这一轮的共同点是「多条独立路径导致同一个现象」和「几何/滚动约定」，
 * 静态断言只能锁住"那条路径还在不在"，运行时行为另有专门测试
 * （media-exclusive / tv-nav-dispatch / player-runtime-fixes）。
 */
const WEB = join(__dirname, '..')
const REPO = join(WEB, '..', '..', '..')

const PLAYER = readFileSync(
  join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)
const MAIN = readFileSync(join(WEB, 'src', 'main.ts'), 'utf8')
const MEDIA = readFileSync(join(WEB, 'src', 'utils', 'mediaExclusive.ts'), 'utf8')
const TOKENS = readFileSync(join(WEB, 'src', 'styles', 'tokens.css'), 'utf8')
const TV_NAV = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)
const MAIN_ACTIVITY = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'MainActivity.java'),
  'utf8',
)

function codeOnly(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('问题0：旧片音轨 + 新片画面重叠的根源', () => {
  it('全局媒体互斥已安装到入口', () => {
    expect(MAIN).toContain('installMediaExclusivity')
    expect(MEDIA).toContain("document.addEventListener(\n    'play'")
    // 必须是捕获阶段：play 不冒泡
    expect(MEDIA).toMatch(/true,\s*\)/)
  })

  it('互斥会停掉页面上其它正在播的媒体', () => {
    expect(MEDIA).toContain("querySelectorAll('video,audio')")
    expect(MEDIA).toContain('el.pause()')
    expect(MEDIA).toContain("if (!el.muted)")
  })

  it('★ TV 壳 onPause 必须暂停 WebView 媒体（原生播放器盖上来时页面没卸载）', () => {
    // 这是最容易漏的一条：NativePlayerActivity 是另一个 Activity，
    // onBeforeUnmount / stopMedia 一次都跑不到
    expect(MAIN_ACTIVITY).toContain('protected void onPause()')
    const i = MAIN_ACTIVITY.indexOf('protected void onPause()')
    const body = MAIN_ACTIVITY.slice(i, i + 900)
    expect(body).toContain('__meowWebviewPause')
  })

  it('onResume 按需恢复，不打断用户自己的暂停', () => {
    expect(MAIN_ACTIVITY).toContain('__meowWebviewResume')
    // 只有"被我们暂停过"才恢复
    expect(MEDIA).toContain('pausedBySystem')
  })

  it('壳层钩子与页面钩子同名（改名会静默失效）', () => {
    expect(MAIN_ACTIVITY).toContain('__meowWebviewPause')
    expect(MAIN_ACTIVITY).toContain('__meowWebviewResume')
    expect(MEDIA).toContain('w.__meowWebviewPause')
    expect(MEDIA).toContain('w.__meowWebviewResume')
  })
})

describe('问题1：弹幕搜索弹框必须限高且可滚', () => {
  // 弹框的说明都在 HTML 注释里，所以这里用全文定位（不用 codeOnly）
  const raw = PLAYER

  it('弹框外层是 tv-nav 的模态作用域', () => {
    const i = raw.indexOf('<!-- 弹幕搜索弹框 -->')
    expect(i).toBeGreaterThan(-1)
    const body = raw.slice(i, i + 900)
    expect(body).toContain('data-tv-scope')
  })

  it('弹框本体限高 + flex 纵向（否则内容超出 TV 视口且不可滚）', () => {
    const i = raw.indexOf('<!-- 弹幕搜索弹框 -->')
    const body = raw.slice(i, i + 1600)
    expect(body).toMatch(/max-h-\[\d+vh\]/)
    expect(body).toContain('flex-col')
  })

  it('结果列表是可滚区，但不是焦点停靠点', () => {
    const i = raw.indexOf('结果列表：唯一可滚区')
    expect(i).toBeGreaterThan(-1)
    // 切片从注释中间开始：先切到第一个 --> 之后，再去掉其余整段注释，
    // 只对真实标签做断言（注释里会写"不标 data-tv-scroll"）
    const body = raw
      .slice(i, i + 900)
      .replace(/^[\s\S]*?-->/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
    // 可滚：父级 flex 限高，这里 min-h-0 才能收缩
    expect(body).toContain('min-h-0')
    expect(body).toContain('flex-1')
    expect(body).toContain('overflow-y-auto')
    /*
     * 2026-11-04 审计：列表项全是可聚焦的 <button>，容器再当停靠点会抢焦点
     * （容器矩形包住所有结果，primary=0）。滚动跟着焦点走；
     * 列表为空时 autoScrollAnchor 会自动补停靠点。
     */
    expect(body).not.toContain('data-tv-scroll')
    expect(body).not.toContain('tabindex="0"')
  })

  it('★ 打开时的落点：TV 聚焦「搜索」按钮，PC 聚焦输入框', () => {
    /*
     * 2026-11-04 用户要求改了落点：TV 默认聚焦「搜索」按钮（一次 OK 即搜），
     * 原来落输入框，输入框的 focus 边框和 tv-nav 焦点环同时亮 ——
     * 看起来"搜索框和按钮都有焦点"（用户截图报的问题）。
     *
     * 不变的两条：整个弹框里**只有一个** data-tv-first（两个会打架），
     * 且 TV 上必须显式画 tv-nav 的环（focus() 只动 DOM 焦点）。
     */
    // 只在这个弹框范围内计数（整个文件里其它面板也有各自的 data-tv-first）
    const dlgStart = raw.indexOf('v-if="showDmSearch"')
    const dlgEnd = raw.indexOf('父级浮层插槽', dlgStart)
    expect(dlgStart).toBeGreaterThan(-1)
    expect(dlgEnd).toBeGreaterThan(dlgStart)
    const dlg = raw.slice(dlgStart, dlgEnd)
    // 只数真正的属性行（注释里也会提到 data-tv-first，不能算）
    const firstMarks = dlg.match(/^\s*data-tv-first\s*$/gm) || []
    expect(firstMarks.length, '弹框里 data-tv-first 只能有一个（多个落点会打架）').toBe(1)

    const btnIdx = raw.indexOf('ref="dmSubmitEl"')
    expect(btnIdx).toBeGreaterThan(-1)
    expect(raw.slice(btnIdx, btnIdx + 260)).toContain('data-tv-first')

    // 输入框本身不能再标 data-tv-first
    const inputIdx = raw.indexOf('ref="dmInputEl"')
    expect(inputIdx).toBeGreaterThan(-1)
    expect(raw.slice(inputIdx, inputIdx + 200)).not.toContain('data-tv-first')

    const code = codeOnly(PLAYER)
    const open = code.slice(code.indexOf('function openDmSearch'), code.indexOf('function closeDmSearch'))
    expect(open).toContain('isTvEnv()')
    expect(open).toContain('dmSubmitEl.value')
    expect(open).toContain('__meowTvFocus')
    // 非 TV 仍然聚焦输入框，能直接打字
    expect(open).toContain('focus({ preventScroll: true })')
  })

  it('打开时先关同级面板（两个 data-tv-scope 会让焦点归属打架）', () => {
    const code = codeOnly(PLAYER)
    expect(code).toContain('function openDmSearch')
    const i = code.indexOf('function openDmSearch')
    const body = code.slice(i, i + 300)
    expect(body).toContain('openPanel(null)')
  })

  it('关闭必须走统一出口（撤焦点 + 交还 scope）', () => {
    const code = codeOnly(PLAYER)
    expect(code).toContain('function closeDmSearch')
    // 模板里不该再有直接赋值
    expect(code).not.toContain('@click.self="showDmSearch = false"')
    expect(code).not.toContain('@click="showDmSearch = false"')
  })

  it('★ 返回键必须先关弹框，且不能击穿到"暂停/退出"（用户追加要求）', () => {
    const code = codeOnly(PLAYER)
    /*
     * 2026-11-04：播放器改成「包裹上一任返回链」（ownConsumeBack + prevConsumeBack），
     * 真正的层级链条现在叫 ownConsumeBack。断言的内容不变。
     */
    const i = code.indexOf('ownConsumeBack = () =>')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 1800)

    // 弹框分支必须排在全屏之前（弹框 z-50 盖在全屏之上，谁在上面谁先退）
    const dmIdx = body.indexOf('if (showDmSearch.value)')
    const fsIdx = body.indexOf('if (pseudoFs.value || document.fullscreenElement)')
    expect(dmIdx).toBeGreaterThan(-1)
    expect(fsIdx).toBeGreaterThan(-1)
    expect(dmIdx).toBeLessThan(fsIdx)

    // 弹框分支必须"关了就 return true"，绝不能落到后面的暂停/退出
    const dmBlock = body.slice(dmIdx, fsIdx)
    expect(dmBlock).toContain('closeDmSearch()')
    expect(dmBlock).toContain('return true')
    // 不能出现 pause / toggle 这类会打断播放的动作
    expect(dmBlock).not.toContain('.pause()')
    expect(dmBlock).not.toContain('toggle()')

    // 全分支里 showDmSearch 只能出现这一次判断（重复判断会让顺序被改回去）
    expect(body.split('showDmSearch.value').length - 1).toBe(1)
  })
})

describe('问题2：首页第一行右键不能跳到上方分类胶囊', () => {
  it('左右键有「同行优先」这一轮', () => {
    expect(TV_NAV).toContain('rowBest')
    const i = TV_NAV.indexOf('function scanImpl')
    const end = TV_NAV.indexOf('function scrollStep', i)
    const body = TV_NAV.slice(i, end)
    /*
     * 同行判据：候选**中心**落在当前元素的纵向带内（2026-11-05 收紧）。
     *
     * 原判据是"两段区间有交集 + 8px 容差"，字体放大后胶囊行的下边缘能蹭进
     * 容差带，于是又被当成同一行（用户复报「首页第一行右键跳到分类胶囊」）。
     */
    expect(body).toMatch(/var candCy = b\.top \+ b\.height \/ 2/)
    expect(body).toMatch(/candCy >= bandLo && candCy <= bandHi/)
  })

  it('横向同行无候选必须停住，不能回退全量 best', () => {
    /*
     * 2026-11-03 验收：首页首列 ← 跳到分类胶囊、设置行尾 → 跳到「保存」、
     * 详情集数行尾 → 跳到上一行，都是 scanImpl 结尾的 `return best` 兜底。
     * 新口径：横向只在本行内走，同行没有候选就返回 null；纵向在上方
     * `if (vertical)` 已先返回，不受这条影响。
     */
    const i = TV_NAV.indexOf('function scanImpl')
    const end = TV_NAV.indexOf('function scrollStep', i)
    const body = TV_NAV.slice(i, end)
    const code = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('*') && !l.startsWith('//'))
    expect(code.some((l) => l === 'return best'), '横向仍在回退 best').toBe(false)
    /*
     * 2026-11-04：加了一个**显式**的跨列兜底（详情页 101 左键到左栏按钮）。
     * 默认仍只认同行；只有 find() 传 rowFree=true（且目标在另一列）时
     * 才会用 freeBest。没有 data-tv-col 的页面（首页海报墙）行为不变。
     */
    expect(body, '横向同行无候选没有停住').toMatch(
      /return rowBest \|\| \(rowFree \? freeBest : null\)/,
    )
    expect(TV_NAV, '跨列兜底必须只在列标记页面里走').toMatch(
      /scan\(otherCol, from, dir, skipPinned, regionMode, true\)/,
    )
  })
})

describe('问题3：TV WebView 性能设置', () => {
  it('硬件层 + 预光栅化（遥控器跳转时不闪空白）', () => {
    expect(MAIN_ACTIVITY).toContain('LAYER_TYPE_HARDWARE')
    expect(MAIN_ACTIVITY).toContain('setOffscreenPreRaster(true)')
  })

  it('固定文字缩放（部分固件默认 130% 会让整站错位）', () => {
    expect(MAIN_ACTIVITY).toContain('setTextZoom(100)')
  })

  it('★ 缓存模式必须是 LOAD_DEFAULT（LOAD_CACHE_ELSE_NETWORK 会缓存 API）', () => {
    // 实测踩过：该模式下弹幕搜索永远返回第一次那 1 条（后端有 58 条），
    // 加随机参数才正常。这是拿正确性换性能，不能再加回来。
    expect(MAIN_ACTIVITY).toContain('WebSettings.LOAD_DEFAULT')
    expect(MAIN_ACTIVITY).not.toMatch(/setCacheMode\(WebSettings\.LOAD_CACHE_ELSE_NETWORK\)/)
  })

  it('★ 后端 API 响应声明不可缓存（防中间层自作主张）', () => {
    const API = readFileSync(
      join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
      'utf8',
    )
    const i = API.indexOf('private static void sendText')
    expect(i).toBeGreaterThan(-1)
    const body = API.slice(i, i + 1400)
    expect(body).toContain('no-store')
    expect(body).toContain('Pragma')
  })

  it('渲染进程优先级（TV 内存小，后台别被优先杀）', () => {
    expect(MAIN_ACTIVITY).toContain('setRendererPriorityPolicy')
    expect(MAIN_ACTIVITY).toContain('RENDERER_PRIORITY_IMPORTANT')
  })

  it('CSS 层关掉电视上纯亏的动效', () => {
    const i = TOKENS.indexOf("html[data-tv='1'] {")
    expect(i).toBeGreaterThan(-1)
    const tail = TOKENS.slice(TOKENS.indexOf('合成/滚动优化'))
    expect(tail).toContain('scroll-behavior: auto')
    expect(tail).toContain('overscroll-behavior: none')
    expect(tail).toContain('-webkit-tap-highlight-color: transparent')
    expect(tail).toContain('text-rendering: optimizeSpeed')
  })
})
