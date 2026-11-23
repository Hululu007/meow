import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * token 中途过期 → 换新地址续播（2026-11-23 用户点单）。
 *
 * 403 发生在已经播过分片之后，不能当"地址写错"直接判死：
 * 播放器发 stale-src，父组件重新调 play 拿新 token，并按原位置续播。
 * 每条源只试一次，失败落回换线。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const V = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)
const P = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
  'utf8',
)
const E = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'api', 'playerEvents.ts'),
  'utf8',
)

describe('token 过期热替换', () => {
  it('播放器只在"已播过分片 + 403/401"时请求刷新，且每条源一次', () => {
    expect(V).toContain('fragLoadedCount > 0 && !staleTried')
    expect(V).toContain("emit('stale-src'")
    expect(V).toContain('staleTried = false')
  })

  it('父组件重新取地址并用 seekAt 回到原位置', () => {
    expect(P).toContain('function onStaleSrc')
    expect(P).toContain('fetchPlay(site, flag.value, rawId.value)')
    expect(P).toContain(':seek-at="refreshSeekAt"')
    // 播放器应用后清零点，避免下一集又跳
    expect(V).toContain("emit('seek-applied')")
    expect(P).toContain('@seek-applied="refreshSeekAt = 0"')
  })

  it('上报有节流，且不上报完整 URL', () => {
    expect(E).toContain('THROTTLE_MS')
    expect(E).not.toContain('JSON.stringify({ ...ev, url')
  })
})
