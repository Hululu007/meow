/**
 * 播放必须把详情里的「线路表」回传给 spider（2026-11-24 真机远程调试定位）。
 *
 * 症状：iOS 上换任何线路都提示「该线路暂不可用」，弹幕却正常。
 * 真因：CatVod 的 `playerContent(flag, id, flags)` 第三参是详情里的线路表，
 *      我们一直传 `new ArrayList<>()`；AppRJ / Jpys / AppGet 这类 spider
 *      用 `flags.indexOf(flag)` 当下标去取 `vod_play_url` 的第 N 组 →
 *      空表得到 -1 → ArrayIndexOutOfBoundsException。
 *
 * 这里锁三件事（少一件就会回退成「全线路播不了」）：
 *   1. detail 时缓存 `vod_play_from`（按 site|id，LRU 有上限）；
 *   2. play 时把这个列表作为第三参传进去；
 *   3. 缓存没热（从历史直接进播放页）时，AIOOBE 后补一次 detail 再重试一次。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', '..')
const host = readFileSync(
  join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
).replace(/\r\n/g, '\n')

describe('播放：CatVod 第三参（线路表）', () => {
  it('detail 响应里抽 vod_play_from 并缓存', () => {
    expect(host).toContain('rememberPlayFlags(site, raw)')
    expect(host).toContain('vod_play_from')
    // 线路表按 $$$ 拆（CatVod 契约）
    expect(host).toContain('from.split("\\\\$\\\\$\\\\$")')
    // 缓存必须有上限，否则 iOS 500MB 堆会被几十个站的详情撑爆
    expect(host).toContain('size() > 256')
  })

  it('play 传缓存而不是空表', () => {
    expect(host).toContain('List<String> flags = playFlagsFor(site, id)')
    expect(host).toContain('.invoke(o, flag, id, flags)')
    // 旧写法（恒空表）不许回来
    expect(host).not.toContain('.invoke(o, flag, id, new ArrayList<String>())')
  })

  it('缓存未命中 + 越界时补 detail 再试一次（历史直进播放页）', () => {
    expect(host).toContain('cause instanceof ArrayIndexOutOfBoundsException')
    expect(host).toContain('rememberPlayFlags(site, raw)')
    expect(host).toContain('List<String> again = playFlagsFor(site, id)')
  })
})
