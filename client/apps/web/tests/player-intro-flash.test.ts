import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 片头提示闪屏门禁（2026-11-23 实报）。
 *
 * ⟳ 刷新后先回到 0 秒等 metadata，片头标记在手 → inIntro 立刻为真 →
 * 右下角「跳过片头」在加载阶段闪一下，续播 seek 落地后又消失。
 * 判据必须是"位置可信"（metadata + 刷新续播 seek 完成）之后才允许提示。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const V = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)

describe('片头提示不在加载阶段误闪', () => {
  it('inIntro 以 posReady 为前提', () => {
    const i = V.indexOf('const inIntro = computed')
    expect(i).toBeGreaterThan(-1)
    const line = V.slice(i, i + 200)
    expect(line).toContain('posReady.value')
  })

  it('posReady 在换源时复位、在续播 seek 之后置真', () => {
    expect(V).toContain('posReady.value = false')
    expect(V).toContain('posReady.value = true')
    // 置真必须排在 resumeAfterReload 的 seek 之后
    const seek = V.indexOf('if (resumeAfterReload > 0)')
    const ready = V.indexOf('posReady.value = true', seek)
    expect(seek).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(seek)
  })
})
