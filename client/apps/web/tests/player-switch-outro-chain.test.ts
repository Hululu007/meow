import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { __resetPrefsCache } from '../src/stores/prefs'

/**
 * 切集片尾连锁跳的回归门禁（2026-11-20 用户实报）。
 *
 * 场景：第 8 集有手动片尾标记（距结尾 176s），播到标记处切到第 9 集。
 * 切集时 PlayView/VideoPlayer 是**复用**的（App.vue 对 /play/:site 按 path 做 key），
 * 修之前 `currentTime`/`duration` 两个响应式值还停在上一集，新集 metadata 一到
 * `inOutro` 就恒真，起播的 play 事件直接触发"跳过片尾"→ 再 ended → 连跳整季。
 */

function mountPlayer(props: Record<string, unknown> = {}) {
  return mount(VideoPlayer, {
    props: { src: '', site: 'src', vodId: '100', ...props },
    attachTo: document.body,
  })
}

/** jsdom 没有真的媒体管线：把 duration/currentTime 的可观测面补上 */
function fakeMedia(wrapper: ReturnType<typeof mountPlayer>, duration: number) {
  const v = wrapper.find('video').element as HTMLVideoElement
  Object.defineProperty(v, 'duration', { value: duration, configurable: true })
  Object.defineProperty(v, 'paused', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'seeking', { value: false, configurable: true, writable: true })
  Object.defineProperty(v, 'buffered', {
    value: { length: 0, end: () => 0 },
    configurable: true,
  })
  v.load = () => {}
  v.pause = () => {}
  v.play = (() => Promise.resolve()) as unknown as HTMLMediaElement['play']
  return v
}

beforeEach(() => {
  __resetPrefsCache()
  localStorage.clear()
  document.documentElement.removeAttribute('data-tv')
})

describe('切集不因旧集位置触发片尾连锁跳', () => {
  it('换源后旧集的位置/时长被清零，新集起播不会立刻 ended', async () => {
    // 手动片尾标记：距结尾 176s（对应截图里的 44:09 / 47:05）
    localStorage.setItem(
      'meow.skipmarks',
      JSON.stringify({ 'src|100': { intro: 0, outro: 176, at: 1 } }),
    )
    // 用户设置是「立即跳」（0），所以一旦命中片尾区间会当场切集
    localStorage.setItem('meow.prefs', JSON.stringify({ skipCountdown: 0 }))
    __resetPrefsCache()

    const w = mountPlayer({ src: 'https://cdn.example.com/ep8.mp4' })
    const v = fakeMedia(w, 2825) // 47:05
    v.dispatchEvent(new Event('loadedmetadata'))
    await w.vm.$nextTick()

    // 第 8 集播到片尾区间 → 立即跳（这一步是正确行为，产生第一条 ended）
    // play 与 timeupdate 分两拍派发：浏览器里它们来自不同任务，同一拍会让
    // playing / inOutro 两个 watch 在同一轮 flush 里各触发一次
    v.dispatchEvent(new Event('play'))
    await w.vm.$nextTick()
    v.currentTime = 2780
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()
    await Promise.resolve()
    expect((w.emitted('ended') || []).length).toBe(1)

    // 切第 9 集：同一个实例换 src（路由只改 query，不重建组件）
    await w.setProps({ src: 'https://cdn.example.com/ep9.mp4' })
    await w.vm.$nextTick()

    // 新集 metadata 到达（时长短于上一集），再起播
    Object.defineProperty(v, 'duration', { value: 2700, configurable: true })
    v.currentTime = 0
    v.dispatchEvent(new Event('loadedmetadata'))
    v.dispatchEvent(new Event('play'))
    await w.vm.$nextTick()
    await new Promise((r) => setTimeout(r, 20))
    await w.vm.$nextTick()

    // 旧实现这里会再发一条（连跳下一集）
    expect((w.emitted('ended') || []).length).toBe(1)
    w.unmount()
  })

  it('新集自己播到片尾时仍会正常发 ended（不要修成永不再跳）', async () => {
    localStorage.setItem(
      'meow.skipmarks',
      JSON.stringify({ 'src|100': { intro: 0, outro: 176, at: 1 } }),
    )
    localStorage.setItem('meow.prefs', JSON.stringify({ skipCountdown: 0 }))
    __resetPrefsCache()

    const w = mountPlayer({ src: 'https://cdn.example.com/ep8.mp4' })
    const v = fakeMedia(w, 2825)

    await w.setProps({ src: 'https://cdn.example.com/ep9.mp4' })
    Object.defineProperty(v, 'duration', { value: 2700, configurable: true })
    v.currentTime = 0
    v.dispatchEvent(new Event('loadedmetadata'))
    v.dispatchEvent(new Event('play'))
    await w.vm.$nextTick()
    expect((w.emitted('ended') || []).length).toBe(0)

    // 播到新集自己的片尾（2700 - 176 = 2524）
    v.currentTime = 2600
    v.dispatchEvent(new Event('timeupdate'))
    await w.vm.$nextTick()
    await Promise.resolve()
    expect((w.emitted('ended') || []).length).toBe(1)
    w.unmount()
  })
})
