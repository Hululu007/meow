/**
 * 后台播放 / 回前台续播契约（2026-11-25 真机第四轮）。
 *
 * 现场三条：
 *  1. 播放中切后台不继续播 —— 声明了 UIBackgroundModes 只是"允许"，
 *     会话没激活 + 媒体被系统暂停，必须由我们拉回来；
 *  2. 用系统播放条恢复后回前台，双击暂停被 250ms/1.2s 的续播重试拉回播放；
 *  3. 同上，进度不回到切后台的位置。
 *
 * 这里锁的是"判断链"：谁负责补播、什么时候不许补播、原生何时激活会话。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const ROOT = join(WEB, '..', '..', '..')

/** 统一换行：工作区（autocrlf）里是 CRLF，直接 toContain('\n') 会假红 */
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const player = read(join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'))
const audio = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'AudioSession.swift'))
const app = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'MeowApp.swift'))
const webview = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'WebView.swift'))
const bootstrap = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'Bootstrap.swift'))

describe('iOS 后台保播', () => {
  it('切后台只记意图、不暂停，且系统先暂停时补一次 play', () => {
    const branch = player.slice(player.indexOf('if (isMobileForm() && !isTvShell()) {'))
    expect(branch).toContain('bgKeepPlaying = playingBeforeHide')
    expect(branch).toContain('hiddenAt = Date.now()')
    // 先暂停再发 visibilitychange 的机型：pause 事件已经错过，这里补
    expect(branch).toContain('if (v?.paused) maybeKeepPlayingInBackground()')
    expect(branch).toContain('notifyIosPlaying(true)')
  })

  it('后台 pause 区分系统与用户：3s 内补播，之后尊重用户暂停', () => {
    expect(player).toContain('function handleBackgroundPause()')
    expect(player).toContain('Date.now() - hiddenAt < 3000')
    // 窗口外（锁屏/播放条暂停）→ 清续播意图，回前台不许自动播
    expect(player).toContain('playingBeforeHide = false\n  notifyIosPlaying(false)')
  })

  it('补播窗口受 hiddenAt 限制，不会和用户抢控制权', () => {
    const fn = player.slice(player.indexOf('function maybeKeepPlayingInBackground()'))
    expect(fn).toContain('if (!hiddenAt || Date.now() - hiddenAt > 3000) return')
    expect(fn).toContain("document.visibilityState !== 'hidden'")
  })
})

describe('回前台续播 / 双击暂停', () => {
  it('用户暂停时撤掉挂起的补播定时器', () => {
    const toggle = player.slice(player.indexOf('function toggle()'), player.indexOf('function toggle()') + 800)
    expect(toggle).toContain('userPausedAt = Date.now()')
    expect(toggle).toContain('cancelResumeTimers()')
    expect(player).toContain('function cancelResumeTimers()')
  })

  it('续播重试自身也要让位给刚发生的用户暂停', () => {
    const fn = player.slice(player.indexOf('function resumeAfterVisibility()'))
    expect(fn).toContain('Date.now() - userPausedAt < 2000')
    expect(fn).toContain('resumeTimers.push(id)')
  })

  it('进度兜底不依赖 playingBeforeHide（后台暂停过也要拉回）', () => {
    const fn = player.slice(player.indexOf('function resumeAfterVisibility()'))
    const restoreAt = fn.indexOf('restorePositionFromHide(v0)')
    const earlyReturn = fn.indexOf('if (!playingBeforeHide) return')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(earlyReturn).toBeGreaterThan(restoreAt)
    expect(player).toContain('function restorePositionFromHide(')
  })
})

describe('原生音频会话时机', () => {
  it('只在进后台且页面报告在播时激活，不在 play 路径上 setActive', () => {
    expect(audio).toContain('static func appDidEnterBackground()')
    expect(audio).toContain('guard configured, wantPlayback else { return }')
    expect(audio).toContain('try session.setActive(true)')
    expect(app).toContain('} else if phase == .background {')
    expect(app).toContain('AudioSession.appDidEnterBackground()')
    // 前台 active 分支不许再碰 category/setActive（上一版 1s 自停的根因）
    const active = app.slice(app.indexOf('if phase == .active {'), app.indexOf('} else if phase == .background {'))
    expect(active).not.toContain('AudioSession.configure()')
    expect(active).not.toContain('setActive')
  })

  it('页面→原生的播放状态桥存在', () => {
    expect(webview).toContain('case "playing":')
    expect(webview).toContain('AudioSession.setPlaying(')
    expect(bootstrap).toContain('window.meowIos.setPlaying=function(on)')
  })
})
