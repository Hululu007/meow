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
    expect(body).toContain('repairEncoder(ff)')
    // 不能加缩放滤镜：4K 必须还是 4K（缩到 1080p 等于降画质）。
    // 注意注释里会出现 zscale（HDR 说明），所以只检查真正的滤镜参数。
    expect(body).not.toContain('cmd.add("-vf")')
    expect(body).not.toContain('scale=')
    // 码率按源高度给（4K 16M），且 NVENC 要强制关键帧才能 2 秒分片
    expect(body).toContain('repairBitrate(p == null ? 0 : p.height)')
    expect(body).toContain('forced-idr')
  })

  it('模式参与幂等键：copy / repair 不复用普通转码产物', () => {
    expect(T).toContain('public static String idFor(String source, boolean copy, boolean repair)')
    expect(T).toContain('idFor(sourceUrl, preferCopy, repair)')
    expect(T).toContain('idFor(key, preferCopy, repair)')
  })

  it('没有硬件编码器时明确失败，不偷偷缩到 1080p', () => {
    expect(T).toContain('no_repair_encoder')
    const i = T.indexOf('if (repair && (probe == null || repairEncoder(ff) == null))')
    expect(i).toBeGreaterThan(-1)
    const body = T.slice(i, i + 700)
    expect(body).toContain('无法在不降分辨率的前提下修复')
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
    const body = PLAY.slice(i, i + 3200)
    expect(body).toContain('tryTranscode(level || u, false, true)')
    expect(body).toContain('tryLibraryTranscode(libraryLib.value, libraryFile.value, false, true)')
    expect(body).not.toContain('tryTranscode(level || u, true)')
  })

  it('修复失败时恢复原样播放并说明原因（不丢到错误页）', () => {
    expect(PLAY).toContain("r.code === 'no_repair_encoder'")
    expect(PLAY).toContain('无法在不降画质的前提下修复')
    // 前端还有第二道门槛：修复输出高度低于源画面就取消
    expect(PLAY).toContain('修复输出被降了分辨率，已停止并保持原样播放')
  })
})
