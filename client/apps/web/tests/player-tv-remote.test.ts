import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 播放器 TV 遥控门禁（2026-10-31 用户报的四个问题）。
 *
 * 这些问题的共同点：都是**状态机分支写错**，功能本身是实现了的。
 * 静态断言只能锁住"代码长什么样"，真正验证要上真机按遥控；
 * 但把判据写死在这里，至少能拦住改回去。
 */
const WEB = join(__dirname, '..')
const PLAYER = readFileSync(
  join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)
const PLAY_VIEW = readFileSync(join(WEB, 'src', 'views', 'PlayView.vue'), 'utf8')

/** 去掉注释，避免注释里描述"原来有这个问题"把断言骗过去。 */
function codeOnly(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('问题1：控制栏唤不出 / 唤出后要聚焦播放键', () => {
  const code = codeOnly(PLAYER)

  it('焦点判据必须排除"不可见/已脱离文档"的残留焦点框', () => {
    // 原来只 querySelector('.meow-tv-focus')，残留 class 会让所有键被放行。
    // 2026-11-02 再改一层：必须扫全部候选（不只第一个），且判 visibility ——
    // 控制栏收起后 opacity 不遗传给子孙，光判 opacity 仍然会把隐形按钮当焦点。
    expect(code).toContain("querySelectorAll('.meow-tv-focus')")
    expect(code).toContain('isConnected')
    expect(code).toContain('offsetParent')
    expect(code).toContain("st.visibility === 'hidden'")
    // 必须有尺寸判断（宽高至少 2px）
    expect(code).toMatch(/r\.width\s*<\s*2\s*\|\|\s*r\.height\s*<\s*2/)
  })

  it('控制栏收起时必须真正不可见（visibility，不是只有 opacity）', () => {
    // opacity:0 不遗传，tv-nav 的候选集仍会收进那排隐形按钮
    expect(code).toMatch(/:class="showCtrl \? 'opacity-100' : 'pointer-events-none invisible opacity-0'"/)
    expect(code).toContain('.meow-ctrl-bar')
  })

  it('控制栏从隐藏变显示时聚焦播放/暂停按钮', () => {
    expect(code).toContain('focusPlayPauseButton')
    // 只在状态翻转时聚焦，不能每次 wake 都抢焦点
    expect(code).toContain('wasHidden')
    // 播放按钮要有稳定标记（文案会随状态变，不能按顺序取）
    expect(code).toContain('data-tv-primary')
  })
})

describe('问题2：控制栏隐藏时 ok 键明确控制暂停/播放', () => {
  const code = codeOnly(PLAYER)

  it('面板没开且控制栏隐藏时，Enter 由播放器 toggle', () => {
    expect(code).toMatch(/e\.key === 'Enter' && isTvEnv\(\) && !panelOpen && !showCtrl\.value/)
    expect(code).toContain('toggle()')
  })
})

describe('问题4：「立即播放」+ 片尾跳过也要连播', () => {
  const code = codeOnly(PLAYER)

  it('跳过片尾直接触发 ended，而不是只 seek 到 duration-1', () => {
    const i = code.indexOf('function skipOutroNow')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 900)
    // 关键：必须 emit('ended')，否则 onEnded 永不执行
    expect(body).toContain("emit('ended')")
    // 也要 flush 进度（记录"看到片尾了"）
    expect(body).toContain('flushProgress(true)')
  })

  it('PlayView 的 immediate 分支确实换集', () => {
    expect(PLAY_VIEW).toMatch(/case 'immediate':[\s\S]{0,80}switchEpisode/)
  })
})

describe('问题3：弹幕搜索面板', () => {
  const code = codeOnly(PLAYER)

  it('胶囊选中态有实心+描边+勾号（原来只换底色，深色背景上看不出）', () => {
    expect(code).toContain('ring-2 ring-accent')
    expect(code).toContain('ring-2 ring-violet-300')
    // 勾号直接写在标签内容里（>✓</span>），不是字符串字面量
    expect(code).toContain('✓</span>')
    expect(code).toContain('font-semibold')
  })

  it('候选标题抽集数徽标，且去掉来源/年份/类型后缀', () => {
    expect(code).toContain('epBadgeOf')
    expect(code).toContain('cleanDmTitle')
    // 模板里要用上这两个（不能只定义不调用）
    expect(code).toContain('{{ epBadgeOf(r) }}')
    expect(code).toContain('{{ cleanDmTitle(r.name) }}')
  })
})
