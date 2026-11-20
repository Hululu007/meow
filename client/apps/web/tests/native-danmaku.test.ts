import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TV 原生播放器带弹幕的接线门禁（2026-11-20）。
 *
 * 背景：media3 没有官方 danmaku 模块（1.8/1.9 的 media3-ui 里都没有），
 * 所以原生弹幕是自绘 overlay；这里只锁「Web → 桥 → Activity」三处接线，
 * 免得以后重构把第 5 个参数或 EXTRA 名字改丢——丢一个就静默没弹幕。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const NATIVE_BRIDGE = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'api', 'nativeBridge.ts'),
  'utf8',
)
const PLAY_VIEW = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
  'utf8',
)
const TV_BRIDGE = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'TvBridge.java'),
  'utf8',
)
const ACTIVITY = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'NativePlayerActivity.java'),
  'utf8',
)
const OVERLAY = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'DanmakuOverlay.java'),
  'utf8',
)

describe('TV 原生播放器弹幕接线', () => {
  it('Web 侧 openNative 支持第 5 参，且优先走显式方法名', () => {
    expect(NATIVE_BRIDGE).toContain('danmakuUrl?: string')
    expect(NATIVE_BRIDGE).toContain('openNativeWithDanmaku')
    // 老壳没有这个方法 → 必须退回 4 参，不能赌重载
    expect(NATIVE_BRIDGE).toContain("typeof b.openNativeWithDanmaku === 'function'")
  })

  it('PlayView 把弹幕地址交给原生播放器', () => {
    expect(PLAY_VIEW).toContain('openNative(u, title, play.value?.header, resumePos(), danmakuUrl.value)')
  })

  it('桥与 Activity 的 EXTRA 名字一致', () => {
    expect(TV_BRIDGE).toContain('openNativeWithDanmaku')
    expect(ACTIVITY).toContain('EXTRA_DANMAKU_URL = "danmaku_url"')
    expect(ACTIVITY).toContain('loadDanmaku(dmUrl)')
    expect(ACTIVITY).toContain('parseDanmaku(')
  })

  it('overlay 覆盖滚动/顶底/seek 清场/控制栏让路', () => {
    expect(OVERLAY).toContain('SCROLL_MS = 12_000L')
    expect(OVERLAY).toContain('STATIC_MS = 4_000L')
    expect(OVERLAY).toContain('Math.abs(pos - lastPosMs) > 2_500L')
    expect(OVERLAY).toContain('controllerProbe.visible()')
    expect(ACTIVITY).toContain('isControllerFullyVisible')
    expect(OVERLAY).toContain('public void setItems')
  })
})
