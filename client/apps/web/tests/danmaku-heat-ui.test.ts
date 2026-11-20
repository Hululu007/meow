import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 密度带的三种显示模式与悬停条数（2026-11-19） */
const PLAYER = readFileSync(
  join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)
const PREFS = readFileSync(join(__dirname, '..', 'src', 'stores', 'prefs.ts'), 'utf8')

describe('时间轴密度带：双条 / 内嵌 / 关闭', () => {
  it('prefs 有 danmakuHeat 三态，默认双条', () => {
    expect(PREFS).toContain("danmakuHeat: 'bar' | 'inline' | 'off'")
    expect(PREFS).toContain("danmakuHeat: 'bar'")
    expect(PREFS).toContain("!['bar', 'inline', 'off'].includes(out.danmakuHeat)")
  })

  it('双条模式是进度条上方的独立峰谷图', () => {
    expect(PLAYER).toContain("showCtrl && prefs.danmakuHeat === 'bar' && dmHeat")
    expect(PLAYER).toContain('heatBarPx(c)')
    // 不能再退回等高色条
    expect(PLAYER).not.toContain(':style="{ backgroundImage: dmHeat }"')
  })

  it('双条可点击/拖动跳转，松手才 seek', () => {
    expect(PLAYER).toContain('@pointerdown.stop.prevent="onHeatDown"')
    expect(PLAYER).toContain('@pointerup.stop="onHeatUp"')
    expect(PLAYER).toContain('function onHeatDown')
    expect(PLAYER).toContain('function onHeatUp')
    const i = PLAYER.indexOf('function onHeatUp')
    expect(PLAYER.slice(i, i + 300)).toContain('seekTo(t)')
  })

  it('内嵌模式画在进度条内部、播放/缓冲之上仍保留', () => {
    expect(PLAYER).toContain("showCtrl && prefs.danmakuHeat === 'inline' && dmHeatInline")
    const i = PLAYER.indexOf("prefs.danmakuHeat === 'inline'")
    const body = PLAYER.slice(i, i + 600)
    expect(body).toContain('absolute inset-0 rounded-full')
    // 内嵌层必须在“已缓冲”之前
    expect(PLAYER.indexOf('已缓冲', i)).toBeGreaterThan(i)
  })

  it('底栏隐藏时密度带不渲染（双条与内嵌都受 showCtrl 控制）', () => {
    expect(PLAYER).toContain("showCtrl && prefs.danmakuHeat === 'bar'")
    expect(PLAYER).toContain("showCtrl && prefs.danmakuHeat === 'inline'")
  })

  it('悬停时间气泡附带该时间桶的条数', () => {
    expect(PLAYER).toContain('dmHeatTipCount')
    expect(PLAYER).toContain('{{ dmHeatTipCount }} 条')
  })

  it('弹幕设置面板有三档切换', () => {
    expect(PLAYER).toContain('时间轴密度条')
    expect(PLAYER).toContain("label: '双条'")
    expect(PLAYER).toContain("label: '内嵌'")
    expect(PLAYER).toContain("label: '关闭'")
  })
})
