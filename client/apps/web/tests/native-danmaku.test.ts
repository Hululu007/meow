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
    // 2026-11-23：交接位置改用 handoffPos()（当前播放位置优先，历史兜底）
    expect(PLAY_VIEW).toContain(
      'openNative(u, title, play.value?.header, handoffPos(), danmakuUrl.value, meta)',
    )
  })

  it('桥与 Activity 的 EXTRA 名字一致', () => {
    expect(TV_BRIDGE).toContain('openNativeWithDanmaku')
    expect(ACTIVITY).toContain('EXTRA_DANMAKU_URL = "danmaku_url"')
    expect(ACTIVITY).toContain('loadDanmaku(dmUrl)')
    expect(ACTIVITY).toContain('parseDanmaku(')
  })

  it('overlay 覆盖滚动/顶底/seek 清场/控制栏让路', () => {
    expect(OVERLAY).toContain('scrollMs = 12_000L')
    expect(OVERLAY).toContain('STATIC_MS = 4_000L')
    expect(OVERLAY).toContain('Math.abs(pos - lastPosMs) > 2_500L')
    expect(OVERLAY).toContain('controllerProbe.visible()')
    expect(ACTIVITY).toContain('isControllerFullyVisible')
    expect(OVERLAY).toContain('public void setItems')
  })
})

describe('原生弹幕：设置/进度/分道（2026-11-20）', () => {
  it('网页把弹幕设置与进度坐标通过 meta 传进原生', () => {
    // 2026-11-23：进度坐标走 handoffPos()（当前播放位置），不再只读历史
    expect(PLAY_VIEW).toContain(
      'openNative(u, title, play.value?.header, handoffPos(), danmakuUrl.value, meta)',
    )
    expect(NATIVE_BRIDGE).toContain('openNativeFull')
    expect(PLAY_VIEW).toContain('opacity: prefs.danmakuOpacity')
    expect(PLAY_VIEW).toContain('block: prefs.danmakuBlock')
    expect(PLAY_VIEW).toContain('offset: getDmOffset(title)')
    expect(PLAY_VIEW).toContain('apiBase: apiBase()')
  })

  it('原生按 meta 初始化弹幕设置，并按段回传进度', () => {
    expect(ACTIVITY).toContain('EXTRA_META = "meta"')
    expect(ACTIVITY).toContain('danmaku.setOptions(dmOpacity, dmScale, dmDuration, dmArea)')
    expect(ACTIVITY).toContain('reportProgress(false)')
    expect(ACTIVITY).toContain('postDelayed(this, 12_000)')
    expect(ACTIVITY).toContain('/api/state/progress')
    expect(ACTIVITY).toContain('dmBlock')
  })

  it('overlay 顶/底预留行 + 同车道最小间隔，不再和滚动抢 0–2 道', () => {
    expect(OVERLAY).toContain('topRows')
    expect(OVERLAY).toContain('bottomRows')
    expect(OVERLAY).toContain('LANE_GAP_MS')
    expect(OVERLAY).toContain('scrollMs')
    expect(OVERLAY).toContain('public void setOptions')
  })
})

describe('原生弹幕续帧与验收通道（2026-11-20 投影仪实锤）', () => {
  it('非播放态必须惰性续帧：起播缓冲时 isPlaying()=false 会断链', () => {
    // 实测两次：只在 true 时续帧 → spawned 停在 0/1，屏上一根弹幕都没有
    expect(OVERLAY).toMatch(/if \(player\.isPlaying\(\)\) postInvalidateOnAnimation\(\);\s*else postInvalidateDelayed\(300\);/)
    // 命中次数必须是 1：多一处"只在 true 时续帧"的独立分支就会再断链
    const repaint = OVERLAY.match(/postInvalidateOnAnimation\(\);/g) || []
    expect(repaint.length).toBeGreaterThan(0)
    expect(OVERLAY).toContain('else postInvalidateDelayed(300);')
  })

  it('adb 验收走 meta_b64（明文 JSON 会被 am 当 intent URI 吃掉）', () => {
    expect(ACTIVITY).toContain('EXTRA_META_B64')
    expect(ACTIVITY).toContain('EXTRA_DEBUG_STATS')
    expect(OVERLAY).toContain('debugStats()')
  })
})
