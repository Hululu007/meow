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
    const fn = player.slice(player.indexOf('function resumeAfterVisibility('))
    expect(fn).toContain('Date.now() - userPausedAt < 2500')
    expect(fn).toContain('resumeTimers.push(id)')
  })

  it('进度兜底不依赖 playingBeforeHide（后台暂停过也要拉回）', () => {
    const fn = player.slice(player.indexOf('function resumeAfterVisibility('))
    const restoreAt = fn.indexOf('beginRestoreWindow(reason)')
    const earlyReturn = fn.indexOf('if (!playingBeforeHide) return')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(earlyReturn).toBeGreaterThan(restoreAt)
  })

  it('回前台开 15s 恢复窗口，由 timeupdate/canplay 持续校正', () => {
    expect(player).toContain('function beginRestoreWindow(')
    expect(player).toContain('restoreUntil = Date.now() + 15_000')
    expect(player).toContain('function applyRestoreSeek(')
    // 元数据没到不能 seek（会被内核丢掉）
    expect(player).toContain('if (el.readyState < 1) {')
    expect(player).toContain("addEventListener('loadedmetadata', onRestoreTick)")
    // onTimeUpdate 里也要跑（内核可能在我们判定"已到位"之后才重置）
    const tick = player.slice(player.indexOf('function onTimeUpdate()'))
    expect(tick.slice(0, 400)).toContain('onRestoreTick()')
  })

  it('恢复窗口只在真 seek / 用户暂停时关闭，点屏不关', () => {
    expect(player).toContain('function clearRestoreWindow()')
    const down = player.slice(player.indexOf('function onStagePointerDown('))
    expect(down.slice(0, 400)).not.toContain('clearRestoreWindow()')
    const bar = player.slice(player.indexOf('function onBarDown('))
    expect(bar.slice(0, 300)).toContain('clearRestoreWindow()')
    const toggle = player.slice(player.indexOf('function toggle()'), player.indexOf('function toggle()') + 1300)
    expect(toggle).toContain('clearRestoreWindow()')
  })

  it('恢复目标取 max(current, lastGoodPos)：内核回退到后台起点也能纠回', () => {
    const fn = player.slice(player.indexOf('function beginRestoreWindow('))
    expect(fn).toContain('Math.max(restorePos, posBeforeHide, lastGoodPos, el?.currentTime || 0)')
  })

  it('双击检测走 pointerdown：切回前台 click 合成会延迟/丢失', () => {
    expect(player).toContain('function maybeTouchPointerDouble(')
    const down = player.slice(player.indexOf('function onStagePointerDown('))
    expect(down.slice(0, 400)).toContain('maybeTouchPointerDouble(e)')
    // click 侧要吞掉 pointer-dbl 带来的迟到 click
    expect(player).toContain('Date.now() - pointerDblAt < 700')
  })

  it('恢复窗口不因"当前位置看起来正常"提前关闭（内核会稍后才重置）', () => {
    const fn = player.slice(player.indexOf('function applyRestoreSeek('), player.indexOf('function onRestoreTick()'))
    const at = fn.indexOf('if (el.currentTime >= restorePos - 5)')
    expect(at).toBeGreaterThan(-1)
    // 这一支必须只 return，不能顺手关窗（否则内核稍后重置就没人管了）
    const branch = fn.slice(at, at + 90)
    expect(branch).not.toContain('clearRestoreWindow')
  })

  it('切后台的位置取 max(currentTime, lastGoodPos)：先重置再发 hidden 也能拿到', () => {
    expect(player).toContain('posBeforeHide = Math.max(v?.currentTime || 0, lastGoodPos)')
    expect(player).toContain('if (!v.paused && v.currentTime > lastGoodPos) lastGoodPos = v.currentTime')
  })

  it('双击暂停按"看起来在播"判断，不只信 paused', () => {
    expect(player).toContain('function mediaLooksPlaying(')
    const toggle = player.slice(player.indexOf('function toggle()'), player.indexOf('function toggle()') + 600)
    expect(toggle).toContain('if (mediaLooksPlaying(v))')
  })

  it('用户刚暂停的 1.2s 内，任何 play 事件都被压回去（首次切回的媒体状态最乱）', () => {
    const play = player.slice(player.indexOf("addEventListener('play'"), player.indexOf("addEventListener('play'") + 900)
    expect(play).toContain('Date.now() - userPausedAt < 2500')
    expect(play).toContain('v.pause()')
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
