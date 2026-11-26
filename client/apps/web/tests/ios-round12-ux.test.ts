/**
 * 2026-11-25 第五轮真机反馈的门禁：
 *
 *  1. 竖屏设置页胶囊跳转要算上吸顶胶囊条（iPad 横屏走容器分支，本来就对）
 *  2. 直播「分类-台」面板：底部按安全区算（不再预留已隐藏的 tabbar），
 *     换源失败留在面板里显示错误，成功才关
 *  3. 播放页双击只保留暂停/继续（左右分区快进取消，长按仍在）
 *  4. iOS 倒计时改原生计时（JS interval 切后台被挂起），到点暂停 + 释放音频
 *  5. 导入完成发系统通知
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const ROOT = join(WEB, '..', '..', '..')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const player = read(join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'))
const settings = read(join(WEB, 'src', 'views', 'SettingsView.vue'))
const live = read(join(WEB, 'src', 'views', 'LiveView.vue'))
const home = read(join(WEB, 'src', 'views', 'HomeView.vue'))
const bootstrap = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'Bootstrap.swift'))
const webview = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'WebView.swift'))

describe('设置页胶囊跳转（竖屏）', () => {
  it('让出的高度 = 顶栏 + 吸顶胶囊，且落地后校正一次', () => {
    expect(settings).toContain('function stickyTopOffset(')
    expect(settings).toContain('const offset = stickyTopOffset()')
    // 落地后 480ms 再按真实位置校一次（平滑滚动 + 异步布局会漂）
    expect(settings).toContain('window.setTimeout(apply, 260)')
    expect(settings).not.toContain('window.scrollY - 72')
  })
})

describe('直播面板', () => {
  it('面板底部用安全区，不再预留隐藏的 tabbar', () => {
    expect(live).toContain('bottom-[calc(0.75rem+env(safe-area-inset-bottom))]')
    expect(live).not.toContain('bottom-[calc(0.75rem+var(--tabbar-clear))]')
  })

  it('换源失败留在面板里显示错误，成功才关面板', () => {
    expect(live).toContain('@click="openPlaylist(p)"')
    expect(live).toContain('换源失败要在面板里看得到')
    const fn = live.slice(live.indexOf('async function openPlaylist('))
    const successClose = fn.indexOf('showGuide.value = false')
    expect(successClose).toBeGreaterThan(-1)
    // 失败分支 return 在关闭之前（错误时不关面板）
    const failReturn = fn.indexOf("error.value = r.msg || '该播放列表没有频道'")
    expect(failReturn).toBeGreaterThan(-1)
    expect(failReturn).toBeLessThan(successClose)
  })

  it('台列表列加 min-h-0，避免内容把面板撑出可视区', () => {
    expect(live).toContain('flex min-h-0 min-w-0 flex-1 flex-col')
  })
})

describe('首页分类胶囊偶发为空', () => {
  it('home 返回空 class 但带列表时重拉一次', () => {
    const fn = home.slice(home.indexOf('async function loadHome('))
    expect(fn).toContain('if (retry < 1)')
    expect(fn).toContain('return loadHome(retry + 1)')
  })
})

describe('播放页双击语义', () => {
  it('双击只暂停/继续，不再按左右分区 seek（长按仍在）', () => {
    const fn = player.slice(player.indexOf('function touchDoubleTapAction('),
      player.indexOf('function touchDoubleTapAction(') + 600)
    expect(fn).not.toContain('seekBy(-10)')
    expect(fn).not.toContain('seekBy(10)')
    expect(fn).toContain('toggle()')
    // 长按扫描还在（onStagePointerDown 里的 startKeyScan）
    expect(player).toContain('startKeyScan(zone === \'left\' ? -1 : 1)')
  })
})

describe('iOS 倒计时', () => {
  it('原生计时器 + 到点暂停释放音频，不退出应用', () => {
    const timer = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'PowerTimer.swift'))
    expect(timer).toContain('DispatchSource.makeTimerSource')
    expect(timer).toContain('__meowPowerFire')
    expect(timer).toContain('AudioSession.stopForSleep()')
    // 只断言"没有真的调用 exit"，注释里提到 exit(0) 不算
    expect(timer).not.toMatch(/\n\s*exit\(/)
    expect(bootstrap).toContain('window.meowIos.powerTimer=function')
    expect(webview).toContain('case "powerTimer":')
    expect(player).toContain('iosPowerTimer(minutes * 60)')
    expect(player).toContain('iosPowerTimer(0)')
  })
})

describe('导入完成系统通知', () => {
  it('原生通知 + 导入成功/失败都上报', () => {
    const notifier = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'Notifier.swift'))
    expect(notifier).toContain('UNUserNotificationCenter')
    expect(bootstrap).toContain('window.meowIos.notify=function')
    expect(webview).toContain('case "notify":')
    expect(settings).toContain("iosNotify('导入完成'")
    expect(settings).toContain("iosNotify('导入失败'")
  })
})
