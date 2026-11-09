import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VideoPlayer from '../src/components/player/VideoPlayer.vue'
import { shouldTranscode, type PlayErrorKind } from '../src/components/player/playError'

function mountPlayer() {
  return mount(VideoPlayer, { props: { src: '' }, attachTo: document.body })
}

function fireMediaError(w: ReturnType<typeof mountPlayer>, code: number) {
  const v = w.find('video').element as HTMLVideoElement
  Object.defineProperty(v, 'currentSrc', { value: 'blob:x', configurable: true })
  Object.defineProperty(v, 'error', { value: { code }, configurable: true })
  v.dispatchEvent(new Event('error'))
}

/**
 * 播放失败必须带类别。
 *
 * 父组件的兜底顺序依赖它：只有解码/容器类失败值得转码，网络/超时/403
 * 换线才有用。只传一句话的话，一次网络抖动会被送去转码——PC 白等 90 秒，
 * TV 网关直接弹"找不到 ffmpeg"（用户看到的是跟影片无关的报错）。
 */
describe('播放失败分类', () => {
  it('MediaError 3（解码）→ media', () => {
    const w = mountPlayer()
    fireMediaError(w, 3)
    const e = w.emitted('error')?.[0]?.[0] as { kind: PlayErrorKind; msg: string }
    expect(e.kind).toBe('media')
    expect(e.msg).toContain('解码失败')
    w.unmount()
  })

  it('MediaError 2（网络）→ network', () => {
    const w = mountPlayer()
    fireMediaError(w, 2)
    expect((w.emitted('error')?.[0]?.[0] as { kind: PlayErrorKind }).kind).toBe('network')
    w.unmount()
  })

  it('MediaError 4（格式不支持）→ src', () => {
    const w = mountPlayer()
    fireMediaError(w, 4)
    expect((w.emitted('error')?.[0]?.[0] as { kind: PlayErrorKind }).kind).toBe('src')
    w.unmount()
  })

  it('只有 media / src / fake 触发转码', () => {
    for (const k of ['media', 'src', 'fake'] as PlayErrorKind[]) {
      expect(shouldTranscode(k), k).toBe(true)
    }
    for (const k of ['network', 'timeout', 'stall', 'http', 'unknown'] as PlayErrorKind[]) {
      expect(shouldTranscode(k), k).toBe(false)
    }
  })
})
