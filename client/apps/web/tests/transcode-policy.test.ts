import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transcodeErrorMessage, transcodePhaseText } from '../src/api/library'

/**
 * 转码策略的“说人话”门禁（2026-11-20）。
 *
 * 背景：点播等待只有 90 秒、4K 无硬解也照转、取消直接判失败、失败只回
 * ffmpeg 原文——四条都按场景重做后，用纯函数锁住文案与语义。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const LIB = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'api', 'library.ts'), 'utf8')
const TRANSCODE = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'core', 'Transcode.java'),
  'utf8',
)

describe('转码失败文案（按 code）', () => {
  it('4K 无硬解：必须指向原生播放器/1080p，而不是丢 ffmpeg 原文', () => {
    const s = transcodeErrorMessage({ ok: false, code: 'slow_4k', error: 'x' })
    expect(s).toContain('原生播放器')
    expect(s).toContain('1080p')
  })

  it('其它 code 各自有可执行建议', () => {
    expect(transcodeErrorMessage({ ok: false, code: 'no_ffmpeg' })).toContain('ffmpeg')
    expect(transcodeErrorMessage({ ok: false, code: 'cancelled_by_other' })).toContain('另一台设备')
    expect(transcodeErrorMessage({ ok: false, code: 'job_lost' })).toContain('重启')
    expect(transcodeErrorMessage({ ok: false, code: 'source_timeout' })).toContain('源站')
    expect(transcodeErrorMessage({ ok: false, code: 'source_http' })).toContain('过期')
  })

  it('没有 code 的旧后端退回 error 原文', () => {
    expect(transcodeErrorMessage({ ok: false, error: 'boom' })).toBe('boom')
    expect(transcodeErrorMessage({ ok: false })).toBe('转码失败')
  })
})

describe('等待中的进度文案', () => {
  it('有秒数优先显示增量', () => {
    expect(transcodePhaseText(12, 'transcode')).toContain('已就绪 12 秒')
  })
  it('0 秒区分 probe / 已启动 / 停滞', () => {
    expect(transcodePhaseText(0, 'probe')).toContain('读取源信息')
    expect(transcodePhaseText(0, 'transcode')).toContain('等待首片')
    expect(transcodePhaseText(0, 'transcode', true)).toContain('停滞')
  })
  it('已有分片后停滞也要提示（不能一直挂着"已就绪 X 秒"）', () => {
    const s = transcodePhaseText(30, 'transcode', true)
    expect(s).toContain('停滞')
    expect(s).toContain('30')
  })
  it('等待文案不再写死 3 分钟（实际是 120s 起、有进展续到 10 分钟）', () => {
    expect(transcodePhaseText(0, 'transcode')).toContain('10 分钟')
    expect(transcodePhaseText(0, 'transcode')).not.toContain('3 分钟')
  })
})

describe('等待循环契约', () => {
  it('基础 120 秒 + 有进展续 60 秒 + 总上限 600 秒', () => {
    expect(LIB).toContain('TRANSCODE_BASE_MS = 120_000')
    expect(LIB).toContain('TRANSCODE_EXTEND_MS = 60_000')
    expect(LIB).toContain('TRANSCODE_CAP_MS = 600_000')
  })
  it('串行取消有分片 → partial 成功；任务丢失 → job_lost', () => {
    expect(LIB).toContain('partial: true')
    expect(LIB).toContain("code: 'job_lost'")
  })
})

describe('4K 预判必须按真实硬解能力（2026-11-20 复核）', () => {
  it('有 rkmpp 的设备不能被 slow_4k 误杀', () => {
    // 原实现传死 false：RK3566 明明能硬解 4K 降 1080p（首片 13.6s）也被拒
    expect(TRANSCODE).toContain('boolean hwCapable = probe != null && hwTranscode(ff, probe);')
    expect((TRANSCODE.match(/slow4kHopeless\(probe, hwCapable\)/g) || []).length).toBe(2)
  })

  it('硬解失败后的软解重试仍按"无硬解"判（该拒就拒）', () => {
    expect(TRANSCODE).toContain('slow4kHopeless(j.probeSnap, false)')
  })
})

describe('取消语义：切集/换线/离开页面要真的停掉后端任务', () => {
  const PLAY = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'), 'utf8')
  const API = readFileSync(join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')

  it('等待有 epoch，旧等待回来不能回写新集', () => {
    expect(PLAY).toContain('let playEpoch = 0')
    expect(PLAY).toContain('if (myEpoch !== playEpoch) {')
    expect(PLAY).toContain('playEpoch++')
  })

  it('切集/卸载时按 src 或 lib+path 取消（前端拿不到 job id）', () => {
    expect(PLAY).toContain('cancelTranscode({ src })')
    expect(PLAY).toContain('cancelTranscode({ lib, path: file })')
    expect(PLAY).toContain('if (pendingTranscode) {')
    expect(LIB).toContain('export async function cancelTranscode')
  })

  it('后端 DELETE 接受 src / lib+path，按幂等键反推 id', () => {
    expect(API).toContain('core.Transcode.idFor(src)')
    expect(API).toContain('core.Transcode.idFor("lib|" + delLib + "|" + delPath)')
  })
})

describe('重试成功后不能残留上一次的失败码', () => {
  it('startFfmpeg 起进程时清空 code/error', () => {
    const TRANSCODE2 = readFileSync(
      join(REPO, 'server', 'host', 'src', 'shared', 'core', 'Transcode.java'),
      'utf8',
    )
    const i = TRANSCODE2.indexOf('private static void startFfmpeg')
    expect(i).toBeGreaterThan(-1)
    const body = TRANSCODE2.slice(i, i + 1600)
    expect(body).toContain('j.code = "";')
    expect(body).toContain('j.error = "";')
  })
})

describe('手动取消等待的 UI 契约', () => {
  const PLAY = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'), 'utf8')
  it('加载遮罩有「停止等待并取消转码」，TV 首焦点可落到它', () => {
    expect(PLAY).toContain('停止等待并取消转码')
    expect(PLAY).toContain('function cancelTranscodeWait')
    expect(PLAY).toContain('data-tv-first')
  })
  it('取消后有可读反馈，不是静默回首页', () => {
    expect(PLAY).toContain('已停止等待，后端转码任务已取消')
    expect(PLAY).toContain('已取消转码等待')
  })
})
