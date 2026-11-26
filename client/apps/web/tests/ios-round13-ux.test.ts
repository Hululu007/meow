/**
 * 2026-11-26 真机反馈门禁（第十三/十四轮）：
 *
 *  1. 倒计时动作必须落在能力表里（iOS 只有"仅暂停"，不能带 quit 文案）
 *  2. 倒计时展开后分钟选项要自动滚进可视区
 *  3. 音量 HUD 只在播放/直播页接管；其它页面摘掉 MPVolumeView，恢复系统音量条
 *  4. 首页分类胶囊：转屏后不 reset 同一站点、resize 后把激活胶囊拉回可视区
 *  5. 设置页胶囊跳转：滚动锁覆盖二次校正（spy 不许中途改高亮）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const ROOT = join(WEB, '..', '..', '..')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const player = read(join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'))
const live = read(join(WEB, 'src', 'views', 'LiveView.vue'))
const home = read(join(WEB, 'src', 'views', 'HomeView.vue'))
const settings = read(join(WEB, 'src', 'views', 'SettingsView.vue'))
const bridgeTs = read(join(WEB, 'src', 'api', 'nativeBridge.ts'))
const bootstrap = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'Bootstrap.swift'))
const webview = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'WebView.swift'))
const sysvol = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'SystemVolume.swift'))

describe('倒计时动作/菜单', () => {
  it('预选动作必须在 powerOptions 里，setPower 再兜一次', () => {
    expect(player).toContain('powerOptions.includes(currentDefaultPowerAction())')
    expect(player).toContain('if (!powerOptions.includes(act)) act = \'pause\'')
  })

  it('展开倒计时菜单后把分钟选项滚进可视区', () => {
    expect(player).toContain('const sleepMinEl = ref<HTMLElement | null>(null)')
    expect(player).toContain('function toggleSleepMenu()')
    expect(player).toContain('scrollIntoView({ block: \'nearest\'')
    expect(player).toContain('@click.stop="toggleSleepMenu"')
    expect(player).toContain('ref="sleepMinEl"')
  })
})

describe('音量 HUD 只在播放页接管', () => {
  it('原生：读音量不再触发 attach，且可 detach', () => {
    // current() 用会话音量，不能走 slider getter（那会 attach）
    const cur = sysvol.slice(sysvol.indexOf('static func current()'),
      sysvol.indexOf('static func detach()'))
    expect(cur).toContain('AVAudioSession.sharedInstance().outputVolume')
    expect(cur).not.toMatch(/guard let s = slider/)
    expect(sysvol).toContain('static func detach()')
    expect(sysvol).toContain('removeFromSuperview()')
    // 桥
    expect(bootstrap).toContain('window.meowIos.volumeHud=function')
    expect(webview).toContain('case "volumeHud":')
    expect(bridgeTs).toContain('export function setIosVolumeHud(')
  })

  it('播放页/直播页进入时接管、离开时归还', () => {
    for (const src of [player, live]) {
      expect(src).toContain('setIosVolumeHud(true)')
      expect(src).toContain('setIosVolumeHud(false)')
    }
  })
})

describe('首页分类胶囊转屏', () => {
  it('站点没变不 reset；resize 后把激活胶囊拉回可视区', () => {
    expect(home).toContain('if (prev && cur && cur === prev) return')
    expect(home).toContain('function onChipsResize()')
    expect(home).toContain('data-chip-active=')
    expect(home).toContain("centerChip(active, 'auto')")
  })
})

describe('设置页胶囊跳转', () => {
  it('锁覆盖二次校正，并在校正后把高亮钉回目标', () => {
    expect(settings).toContain('navLock = Date.now() + 1800')
    expect(settings).toContain('for (const at of [900, 1500])')
  })
})
