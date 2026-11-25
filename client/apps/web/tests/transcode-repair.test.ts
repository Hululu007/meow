import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 4K 丢帧修复（repair）门禁（2026-11-24 用户实报「pc 端播 4k 一顿一顿」）。
 *
 * 实测根因：某 4K 源整段 GOP 全是 B 帧（125 帧里 124 个 B、has_b_frames=5），
 * Chromium/WebView2 解得出但渲染器稳定丢 28% 帧（25fps→17fps）；同一画面用
 * NVENC 重编一遍（仍是 4K HEVC）丢帧 0。
 *
 * 因此修复只能"保持原分辨率 + 显卡重编"：
 *   - copy（原画转封装）保留码流结构，修不好；
 *   - 缩到 1080p 是用户明确拒绝的降级。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const T = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'core', 'Transcode.java'),
  'utf8',
)
const PLAY = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
  'utf8',
)

describe('4K 丢帧修复：原分辨率显卡重编', () => {
  it('repair 分支只用显卡编码，且不做任何缩放', () => {
    const i = T.indexOf('} else if (repair) {')
    expect(i).toBeGreaterThan(-1)
    // 只取 repair 分支本体：后面紧跟的 rkmpp 分支里有 scale_rkrga，别算进来
    const body = T.slice(i, T.indexOf('} else if (hw) {', i))
    expect(body).toMatch(/repairEncoder\(ff, p == null \? "" : p\.vcodec, allowHevc\)/)
    // 不能加缩放滤镜：4K 必须还是 4K（缩到 1080p 等于降画质）。
    // 注意注释里会出现 zscale（HDR 说明），所以只检查真正的滤镜参数。
    expect(body).not.toContain('cmd.add("-vf")')
    expect(body).not.toContain('scale=')
    // 码率按源高度给（4K 16M），且 NVENC 要强制关键帧才能 2 秒分片
    expect(body).toContain('repairBitrate(p, enc)')
    expect(body).toContain('forced-idr')
  })

  it('模式参与幂等键：copy / repair 不复用普通转码产物', () => {
    expect(T).toContain('public static String idFor(String source, boolean copy, boolean repair)')
    // 起点也参与幂等键（issue #17：从 20:00 重转的产物不能和从 0 转的共用目录）
    expect(T).toContain('public static String idFor(String source, boolean copy, boolean repair, int startSec)')
    expect(T).toContain('idFor(sourceUrl, preferCopy, repair, startSec)')
    expect(T).toContain('idFor(key, preferCopy, repair, startSec)')
  })

  it('探测失败与"没有硬件编码器"分开报，且不偷偷缩到 1080p', () => {
    // 2026-11-24 实报：探测超时被报成"没有硬件编码器"，用户看到的提示完全错
    expect(T).toContain('probe_failed')
    expect(T).toContain('no_repair_encoder')
    const i = T.indexOf('if (repair && repairEncoder(ff, probe == null ? "" : probe.vcodec, allowHevc) == null)')
    expect(i).toBeGreaterThan(-1)
    const body = T.slice(i, i + 700)
    expect(body).toContain('无法在不降分辨率的前提下修复')
  })

  it('中途修复：-ss 快进 + 黑场填充 + 合并清单（时间轴保持绝对）', () => {
    // 用户看到第 10 分钟才丢帧：从头转要等几分钟才追上播放点
    expect(T).toContain('ensureFiller')
    expect(T).toContain('composeMerged')
    expect(T).toContain('#EXT-X-DISCONTINUITY')
    expect(T).toContain('raw.m3u8')
    const i = T.indexOf('if (startSec > 1)')
    expect(i).toBeGreaterThan(-1)
    expect(T.slice(i, i + 120)).toContain('"-ss"')
  })

  it('自愈失败可重试（probe_failed 最多 3 次、间隔 15 秒）', () => {
    expect(PLAY).toContain('canRetryRepair')
    expect(PLAY).toContain('scheduleHealRetry')
    expect(PLAY).toContain("code === 'probe_failed'")
    expect(PLAY).toContain('healAttempts < 3')
  })

  it('输出高度按源分辨率上报（前端拿它做"不许降画质"的硬门槛）', () => {
    const i = T.indexOf('} else if (j.repair) {')
    expect(i).toBeGreaterThan(-1)
    const body = T.slice(i, i + 500)
    expect(body).toContain('o.put("outHeight", p.height)')
  })

  it('高丢帧自愈走 repair，不再走 copy 转封装', () => {
    const i = PLAY.indexOf('async function onHighDrop')
    expect(i).toBeGreaterThan(-1)
    const body = PLAY.slice(i, i + 4200)
    expect(body).toMatch(/tryTranscode\(level \|\| u, false, true/)
    expect(body).toMatch(/tryLibraryTranscode\(libraryLib\.value, libraryFile\.value, false, true/)
    expect(body).not.toContain('tryTranscode(level || u, true)')
  })

  it('修复失败时恢复原样播放并说明原因（不丢到错误页）', () => {
    expect(PLAY).toContain("r.code === 'no_repair_encoder'")
    expect(PLAY).toContain('无法在不降画质的前提下修复')
    // 前端还有第二道门槛：修复输出高度低于源画面就取消
    expect(PLAY).toContain('修复输出被降了分辨率，已停止并保持原样播放')
  })
})

describe('低端设备收敛（2026-11-24）', () => {
  const API = readFileSync(
    join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
    'utf8',
  )
  const LIB = readFileSync(
    join(REPO, 'server', 'host', 'src', 'shared', 'routes', 'LibraryRoutes.java'),
    'utf8',
  )
  const VP = readFileSync(
    join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
    'utf8',
  )

  it('修复码率跟随源（1.5x，按高度夹上下限），不再固定 16M', () => {
    expect(T).toContain('repairTargetBps')
    expect(T).toContain('src * 1.5')
    expect(T).toContain('p.bitRate = srcBitRate')
    // H.264 4K 封 12M
    expect(T).toContain('enc.startsWith("h264")')
    // 旧的写死 16M/24M 分支必须消失
    expect(T).not.toContain('if (h >= 2000) return "16M"')
    expect(T).not.toContain('if (h >= 2000) return "24M"')
  })

  it('同编码优先 + 客户端 HEVC 能力门禁', () => {
    expect(T).toContain('H264_ENCS')
    expect(T).toContain('HEVC_ENCS')
    expect(T).toContain('allowHevc')
    expect(T).toContain('if (!allowHevc && c.startsWith("hevc")) continue;')
    expect(API).toContain('allowHevc')
    expect(API).toContain('q.get("hev")')
    expect(LIB).toContain('q.get("hev")')
    expect(PLAY).toContain('clientCanHevc')
    expect(PLAY).toContain('allowHevc')
  })

  it('丢帧判定收紧：15 秒起判 + 连续两窗 + 缓冲垫 <4s 不判', () => {
    expect(VP).toContain('dropBadStreak')
    expect(VP).toContain('ahead < 4')
    expect(VP).toContain('v.currentTime < 15')
    expect(VP).toContain('dropBadStreak >= 2')
    expect(VP).toContain('setInterval(checkVideoDrops, 3000)')
  })
})
