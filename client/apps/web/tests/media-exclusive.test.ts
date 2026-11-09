import { beforeEach, describe, expect, it } from 'vitest'
import { installMediaExclusivity } from '../src/utils/mediaExclusive'

/**
 * 全局媒体互斥的运行时验证。
 *
 * 这层是"旧片音轨 + 新片画面重叠"的结构性保险：不管哪条代码路径漏了清理，
 * 只要页面上出现第二个媒体开始播放，就把其它正在播的停掉。
 *
 * jsdom 不实现真实媒体播放，所以这里打桩 paused/play/pause，
 * 只验"事件捕获 → 停掉别人"这条逻辑本身。
 */

interface FakeMedia extends HTMLMediaElement {
  __plays: number
  __pauses: number
}

function makeMedia(tag: 'video' | 'audio' = 'video'): FakeMedia {
  const el = document.createElement(tag) as FakeMedia
  let paused = true
  el.__plays = 0
  el.__pauses = 0
  // 真实播放中的元素一定有源；恢复逻辑靠它判断"这个元素还活着"
  el.setAttribute('src', 'http://example.test/a.m3u8')
  Object.defineProperty(el, 'paused', { get: () => paused, configurable: true })
  el.play = () => {
    el.__plays++
    paused = false
    // 真实浏览器里 play() 会派发 play 事件；这里手动模拟同一时序
    el.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  el.pause = () => {
    el.__pauses++
    paused = true
  }
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ''
  // installMediaExclusivity 是幂等的（模块级 installed），
  // 多个用例共享同一次安装即可 —— 监听挂在 document 上，清除 body 不影响
  installMediaExclusivity()
})

describe('全局媒体互斥', () => {
  it('第二个 <video> 开始播放时，第一个被暂停并静音', async () => {
    const a = makeMedia()
    const b = makeMedia()

    await a.play()
    expect(a.paused).toBe(false)

    await b.play()
    expect(b.paused).toBe(false)
    expect(a.paused).toBe(true)
    // 出声是问题本身，所以必须同时静音（pause 在部分元素上不生效）
    expect(a.muted).toBe(true)
  })

  it('三个元素依次播放，只有最后一个在播', async () => {
    const els = [makeMedia(), makeMedia(), makeMedia()]
    for (const el of els) await el.play()
    const playing = els.filter((e) => !e.paused)
    expect(playing).toHaveLength(1)
    expect(playing[0]).toBe(els[2])
  })

  it('<audio> 也受约束（弹幕音效/提示音不能盖住正片）', async () => {
    const v = makeMedia('video')
    const a = makeMedia('audio')
    await v.play()
    await a.play()
    expect(v.paused).toBe(true)
  })

  it('被互斥静音后，用户重新点播放会还原声音', async () => {
    const a = makeMedia()
    const b = makeMedia()
    await a.play()
    await b.play()
    expect(a.muted).toBe(true)

    // 用户切回 a
    await a.play()
    expect(a.paused).toBe(false)
    expect(a.muted).toBe(false)
    // 同时 b 被停掉
    expect(b.paused).toBe(true)
  })

  it('TV 壳的 onPause 钩子会暂停所有在播元素，onResume 恢复', async () => {
    const a = makeMedia()
    await a.play()
    const w = window as unknown as Record<string, () => void>

    w.__meowWebviewPause()
    expect(a.paused).toBe(true)

    w.__meowWebviewResume()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.paused).toBe(false)
  })

  it('用户自己暂停后，系统 onResume 不会擅自恢复', async () => {
    const a = makeMedia()
    await a.play()
    a.pause() // 用户自己按的暂停（不经过 __meowWebviewPause）
    const w = window as unknown as Record<string, () => void>

    w.__meowWebviewPause() // 此时没有在播的元素
    w.__meowWebviewResume()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.paused).toBe(true)
  })
})
