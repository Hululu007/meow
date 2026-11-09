import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 播放失败兜底与看门狗的接线回归。
 *
 * 这几处都是"删掉一行就静默退化"的形态（不会报错，只是行为变差），
 * 所以用源码断言锁住，而不是靠人记。
 */
const play = readFileSync(resolve(__dirname, '../src/views/PlayView.vue'), 'utf8')
const player = readFileSync(resolve(__dirname, '../src/components/player/VideoPlayer.vue'), 'utf8')

describe('PlayView 错误兜底', () => {
  it('只有解码/容器类失败才尝试转码', () => {
    expect(play).toContain('shouldTranscode(kind)')
    // 先探测后端有没有 ffmpeg：没有就不走 90 秒白等
    expect(play).toContain('await ensureTranscodeProbe()')
  })

  it('转码失败不覆盖播放器给的原因', () => {
    expect(play).toContain('hopError.value')
    expect(play).toContain('error.value = playError.value')
    // 旧写法：把 r.error 直接当主文案（"找不到 ffmpeg" 盖掉真实原因）。
    // 只匹配真正的赋值行，注释里提到旧代码不算。
    expect(play).not.toMatch(/^\s*error\.value = r\.error/m)
  })

  it('错误页把"我们这一跳"的原因单独显示', () => {
    expect(play).toContain('v-if="hopError"')
  })
})

describe('VideoPlayer 看门狗 / 弹幕同步接线', () => {
  it('缓冲时冻结弹幕引擎', () => {
    expect(player).toContain("addEventListener('waiting', onBufferStart)")
    expect(player).toContain('dm.value?.pause()')
    expect(player).toContain('dm.value?.start()')
  })

  it('seek 走显式标志，不靠时间差猜', () => {
    expect(player).toContain('sync(v.currentTime, { seek: true })')
  })

  it('清单到手放宽起播预算；有分片就续假死窗口', () => {
    expect(player).toContain('extendStartupForManifest()')
    expect(player).toContain('extendStallForFragment()')
    expect(player).toContain('WATCHDOG_MAX_MS')
  })

  it('倍速联动限制最高档', () => {
    expect(player).toContain('autoLevelCapping')
    expect(player).toContain('applyAbrForRate')
  })

  it('引擎选择走 looksLikeHls，且猜错能回退原生', () => {
    // 判据不能只写在播放器里：TV 有原生 HLS、PC 没有，规则不同
    expect(player).toContain('looksLikeHls(url, nativeHls)')
    // hls.js 拿到非清单内容 → 回退 <video>（只一次）
    expect(player).toContain("manifestParsingError")
    expect(player).toContain('nativeSrcFallbackTried')
    expect(player).toContain('armWatchdogs()')
  })
})
