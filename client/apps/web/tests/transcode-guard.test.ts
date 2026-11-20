import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 转码防呆门禁（2026-11-20 OECT 双 ffmpeg 空转事故）。
 *
 * 三个根因，任何一个回退都会让"僵尸 ffmpeg 各占 575MB"重现：
 * 1. ffmpeg/ffprobe 没有网络超时 → 源站半死不活时永久阻塞；
 * 2. pump 先 readLine 到 EOF 才 waitFor(30s) → 保护永远执行不到；
 * 3. ensure()（在线源兜底）不起串行化，且 stopOtherJobs 会因 .access
 *    宽限把旧任务保下来 → 两路并发。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const T = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'core', 'Transcode.java'),
  'utf8',
)
const LAYOUT = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'res', 'layout', 'activity_native_player.xml'),
  'utf8',
)
const OVERLAY = readFileSync(
  join(REPO, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'DanmakuOverlay.java'),
  'utf8',
)

describe('转码不再卡死/并发', () => {
  it('http 输入统一带 -rw_timeout（ffmpeg 与 ffprobe）', () => {
    expect(T).toContain('addHttpInputOptions')
    expect(T).toContain('-rw_timeout')
    expect(T).toContain('15000000')
    // 三处 ffprobe（v/a/d）都要加
    const probe = T.slice(T.indexOf('private static Probe probe('), T.indexOf('private static String runCapture'))
    expect(probe.match(/addHttpInputOptions\(/g)?.length).toBe(3)
  })

  it('pump 用独立 reader 线程 + 无分片超时，不再先 readLine 到 EOF', () => {
    expect(T).toContain('HANG_NO_SEGMENT_MS')
    expect(T).toContain('transcode-log-')
    expect(T).toContain('proc.waitFor(1, TimeUnit.SECONDS)')
    // 旧的"读到 EOF 才 waitFor(30s)"必须消失
    expect(T).not.toContain('exited = j.proc.waitFor(30, TimeUnit.SECONDS);')
  })

  it('在线源 ensure() 也串行，且不再用 recentlyPlayed 放行旧任务', () => {
    const ensure = T.slice(T.indexOf('public static Job ensure('), T.indexOf('public static Job ensureLocal('))
    expect(ensure).toContain('stopOtherJobs(j.id)')
    const stop = T.slice(T.indexOf('private static void stopOtherJobs'), T.indexOf('private static Path dirOf'))
    expect(stop).not.toContain('recentlyPlayed')
  })
})

describe('原生播放器弹幕层能显示', () => {
  it('PlayerView 必须用 texture_view（SurfaceView 会盖住弹幕）', () => {
    expect(LAYOUT).toContain('surface_type="texture_view"')
  })

  it('自绘 View 必须有 XML 构造器', () => {
    expect(OVERLAY).toContain('DanmakuOverlay(Context context, AttributeSet attrs)')
  })
})
