import { beforeEach, describe, expect, it } from 'vitest'
import { DanmakuRenderer, type Danmu } from '../src/components/player/danmaku'

const mk = (time: number, text: string): Danmu => ({
  time,
  mode: 1,
  size: 25,
  color: '#ffffff',
  text,
})

/**
 * 缓冲恢复 vs 真拖动。
 *
 * 2026-11-04 用户报的现象：1.25x 播一会儿卡一下，卡完恢复时**满屏弹幕消失、
 * 又从右侧同时打出来**。根因是 sync 的跳转判据跟"插值后的 now"比：
 * 缓冲期间画面时间冻结、rAF 插值仍往前推（最多 0.4s），恢复时 time 比 now
 * 小 0.4 —— 旧阈值是 -0.3，于是每次缓冲停顿都被当成"用户拖回去了"。
 */
describe('弹幕同步：缓冲恢复不清屏', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 450, configurable: true })
    document.body.appendChild(host)
  })

  it('时间小幅后退（缓冲恢复）保留在屏弹幕', () => {
    const r = new DanmakuRenderer(host)
    r.load(Array.from({ length: 20 }, (_, i) => mk(i * 0.5, `D${i}`)))
    r.sync(9.5)
    // 停顿前刚发出的那一条：如果被误判成跳转，游标会退回去，它就被丢了
    expect(r.debugActive().map((a) => a.text)).toContain('D19')
    const before = r.debugActive().length

    // 缓冲恢复：画面时间只比上一次权威时间小 0.4s（插值超前的量）
    r.sync(9.1)

    const after = r.debugActive()
    expect(after.length).toBe(before)
    expect(after.map((a) => a.text)).toContain('D19')
    r.destroy()
  })

  it('真正的后退拖动仍会清屏并从 3 秒窗口重发', () => {
    const r = new DanmakuRenderer(host)
    r.load(Array.from({ length: 20 }, (_, i) => mk(i * 0.5, `D${i}`)))
    r.sync(9.5)
    r.sync(2)
    const texts = r.debugActive().map((a) => a.text)
    // 2 秒附近：0~2s 内全部上屏；9.5 时发的那批必须消失
    expect(texts).toContain('D4')
    expect(texts).not.toContain('D19')
    r.destroy()
  })

  it('seek 事件显式清屏（哪怕时间只差一点）', () => {
    const r = new DanmakuRenderer(host)
    r.load(Array.from({ length: 20 }, (_, i) => mk(i * 0.5, `D${i}`)))
    r.sync(9.5)
    r.sync(9.4, { seek: true })
    // 显式 seek → 游标退到 6.4 秒，只补最近 3 秒
    expect(r.debugActive().length).toBeLessThanOrEqual(8)
    r.destroy()
  })
})
