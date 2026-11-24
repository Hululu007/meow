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

  it('串行由 startFfmpeg 统一执行（硬件任务抢占，软件任务不打断观看者）', () => {
    // 2026-11-23：ensure() 的串行决策下沉到 startFfmpeg（probe 之后才知道要不要硬解）
    const ensure = T.slice(T.indexOf('public static Job ensure('), T.indexOf('public static Job ensureLocal('))
    expect(ensure).toMatch(/startFfmpeg\(j, ff, (sourceUrl|playSrc), false\)/)
    const start = T.slice(T.indexOf('private static void startFfmpeg'), T.indexOf('private static void pump'))
    expect(start).toContain('stopOtherJobs(j.id, hw || j.repair)')
    const stop = T.slice(T.indexOf('private static boolean stopOtherJobs'), T.indexOf('private static Path dirOf'))
    // 不再按"最近播放"永久放行（旧事故根因），但"正在被观看 + 新任务是软件任务"要放行
    expect(stop).not.toContain('recentlyPlayed')
    expect(stop).toContain('newNeedsHw')
    expect(stop).toContain('lastAccess')
  })

  it('两台设备抢 4K：正在看的硬件任务不被杀，新任务明确报 hw_busy', () => {
    // 2026-11-23 用户点单：第二台设备不能把第一台正在看的 4K 硬转杀掉
    const stop = T.slice(T.indexOf('private static boolean stopOtherJobs'), T.indexOf('private static Path dirOf'))
    expect(stop).toContain('reject new hw job')
    expect(stop).toContain('return false')
    expect(T).toContain('hw_busy')
  })

  it('4K 点播源能进 ffmpeg：伪装分片扩展名 + 源站 UA/Referer', () => {
    // 2026-11-23 咕噜4K 实报：TS 分片写成 .png；m3u8 无 UA 直接 404。
    // 两条都必须出现在输入参数里，否则 probe 失败 → 4K 线路被判死。
    expect(T).toContain('-extension_picky')
    expect(T).toContain('-user_agent')
    expect(T).toContain('-headers')
    expect(T).toContain('addHttpInputOptions(cmd, source, header)')
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
