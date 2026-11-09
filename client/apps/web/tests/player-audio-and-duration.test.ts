import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 2026-11-02 用户报的四个问题的结构门禁。
 *
 * 共同点：三个是"状态/时序写错"，不是功能没实现。静态断言锁不住运行时，
 * 但能防止改动时被无意识改回去 —— 前两轮同类问题都是这么回退的。
 */
const WEB = join(__dirname, '..')
const PLAYER = readFileSync(
  join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)
const PLAY_VIEW = readFileSync(join(WEB, 'src', 'views', 'PlayView.vue'), 'utf8')
const TV_NAV = readFileSync(
  join(WEB, '..', 'tv', 'app', 'src', 'main', 'assets', 'tv-nav.js'),
  'utf8',
)

function codeOnly(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('问题1：TV 播放页去掉左上角返回按钮', () => {
  it('返回按钮只在非 TV 环境渲染（真电视不给，手机形态的 TV 壳要给）', () => {
    // 那个按钮是 tv-nav 几何选焦的头号命中目标，按 ok 会直接退出整集。
    // 2026-11-05 起判据收口到 showBackButton：!isTvEnv() 或"手机形态视口"
    // （TV 壳跑在手机模拟器上时也要能返回），真电视（960×540）仍为 false。
    const src = codeOnly(PLAYER)
    expect(src).toMatch(/v-if="showBackButton"[\s\S]{0,200}aria-label="返回"/)
    expect(src).toContain('const showBackButton = computed(() => !isTvEnv() || compactViewport.value)')
    expect(src).toContain('Math.min(window.innerWidth, window.innerHeight) < 480')
  })
})

describe('问题2：下键唤不出控制栏', () => {
  it('控制栏收起时必须 invisible（visibility 会遗传给子孙）', () => {
    const code = codeOnly(PLAYER)
    // 顶栏 + 底栏都要有
    const matches = code.match(/pointer-events-none invisible opacity-0/g) || []
    expect(matches.length).toBeGreaterThanOrEqual(2)
    expect(code).toContain('.meow-ctrl-bar')
  })

  it('播放器的焦点判据要跳过 hidden 的元素', () => {
    const code = codeOnly(PLAYER)
    const i = code.indexOf('const hasTvFocus')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 900)
    // opacity 不遗传，只有 visibility 能反映"整条栏都收起了"
    expect(body).toContain("st.visibility === 'hidden'")
    // 必须遍历全部候选，不能只看第一个（第一个可能是残留的隐形框）
    expect(body).toContain("querySelectorAll('.meow-tv-focus')")
  })

  it('TV 壳的分派判据也要排除不可见焦点', () => {
    // markedEl 是关键：裸 querySelector 会让壳把方向键全部吃掉
    expect(TV_NAV).toContain('function markedEl()')
    const i = TV_NAV.indexOf('var owner = window.__meowTvKeyOwner')
    expect(i).toBeGreaterThan(-1)
    const body = TV_NAV.slice(i, i + 2200)
    expect(body).toContain('markedEl()')
    expect(body).not.toContain("querySelector('.meow-tv-focus')")
  })

  it('聚焦播放/暂停不能依赖已被摘掉的 ctrl scope', () => {
    const code = codeOnly(PLAYER)
    const i = code.indexOf('function focusPlayPauseButton')
    const body = code.slice(i, i + 900)
    expect(body).toContain("querySelector<HTMLElement>('[data-tv-primary]')")
    expect(body).not.toContain('[data-tv-scope="ctrl"]')
  })
})

describe('问题3：切集/切线路/返回重播后音轨重叠', () => {
  it('要有一个统一的 stopMedia（静音 + 摘源 + load）', () => {
    const code = codeOnly(PLAYER)
    const i = code.indexOf('function stopMedia')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 900)
    expect(body).toContain('v.muted = true')
    expect(body).toContain('v.pause()')
    expect(body).toContain("v.removeAttribute('src')")
    expect(body).toContain('v.load()')
  })

  it('换源路径和卸载路径都必须调用它', () => {
    const code = codeOnly(PLAYER)
    // setupSource 里（切线路：同一个 <video> 换源）
    const s = code.indexOf('function setupSource')
    const sBody = code.slice(s, s + 1600)
    expect(sBody).toContain('stopMedia()')
    // 卸载里（切集：整个组件被销毁）
    const u = code.indexOf('onBeforeUnmount(() =>')
    expect(u).toBeGreaterThan(-1)
    const uBody = code.slice(u, u + 1400)
    expect(uBody).toContain('stopMedia()')
  })

  it('stopMedia 的静音不能把用户音量吃掉', () => {
    const code = codeOnly(PLAYER)
    const s = code.indexOf('stopMedia()\n  v.volume')
    // 换源后要按用户偏好恢复，否则新源也是哑的
    expect(s).toBeGreaterThan(-1)
  })

  it('空源触发的 durationchange 不能把时长清零', () => {
    const code = codeOnly(PLAYER)
    const i = code.indexOf('function onLoaded')
    const body = code.slice(i, i + 700)
    expect(body).toContain('Number.isNaN(v.duration)')
  })
})

describe('问题4：历史页统计播放时长', () => {
  it('播放器按墙钟累计 watched，不靠 pos 差值', () => {
    const code = codeOnly(PLAYER)
    expect(code).toContain('watchedSec')
    // timeupdate 里累计，且要排除暂停/seek/长间隔
    const i = code.indexOf('function onTimeUpdate')
    const body = code.slice(i, i + 1600)
    expect(body).toContain('!v.paused')
    expect(body).toContain('!v.seeking')
    expect(body).toContain('dt < 2')
  })

  it('progress 事件带 watched 字段', () => {
    const code = codeOnly(PLAYER)
    const i = code.indexOf('function flushProgress')
    const body = code.slice(i, i + 1200)
    expect(body).toContain('watched: watchedSec')
  })

  it('父组件按 watched 增量入账，门禁不能是 5 秒', () => {
    const code = codeOnly(PLAY_VIEW)
    const i = code.indexOf('function onProgress')
    const body = code.slice(i, i + 1400)
    expect(body).toContain('p.watched')
    // 原来 `delta <= 5` 与 5 秒心跳撞在一起，几乎全部被丢
    expect(body).toContain('delta <= 90')
  })

  it('位置没变但时长在走时，也要能穿过去重', () => {
    const code = codeOnly(PLAYER)
    expect(code).toContain('lastSentWatched')
    const i = code.indexOf('function flushProgress')
    const body = code.slice(i, i + 1200)
    expect(body).toContain('watchedAdvanced')
  })
})
