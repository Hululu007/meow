import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  freshDanmakuUrl,
  isBetterDanmaku,
  isSafeDanmakuSwap,
  pickSameSourceCandidate,
} from '../src/components/player/dmUpgrade'

/**
 * 弹幕后台补全 / 跨集沿用的回归门禁（2026-11-09）。
 *
 * 背景：首屏 8000 条写进 IndexedDB 后，服务端后台补全的 12000 条永远
 * 取不到；手动选源切集后 dmOverrideUrl 还挂着，面板误显示「已手动指定」。
 */
const ROOT = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('isBetterDanmaku', () => {
  it('明显更全才换（1.2 倍阈值）', () => {
    expect(isBetterDanmaku(8000, 12000)).toBe(true)
    expect(isBetterDanmaku(8000, 9600)).toBe(true) // 刚好 1.2
    expect(isBetterDanmaku(8000, 9000)).toBe(false)
    expect(isBetterDanmaku(8000, 8000)).toBe(false)
    expect(isBetterDanmaku(0, 100)).toBe(false)
  })
})

describe('isSafeDanmakuSwap', () => {
  const now = 1_000_000
  it('15 秒内可以直接换', () => {
    expect(isSafeDanmakuSwap(0, 0, now)).toBe(true)
    expect(isSafeDanmakuSwap(14.9, 0, now)).toBe(true)
  })
  it('超过 15 秒只有刚 seek 才换', () => {
    expect(isSafeDanmakuSwap(20, 0, now)).toBe(false)
    expect(isSafeDanmakuSwap(20, now - 1000, now)).toBe(true)
    expect(isSafeDanmakuSwap(20, now - 5000, now)).toBe(false)
  })
})

describe('pickSameSourceCandidate', () => {
  const list = [
    { source: '360', episode: 3, url: '/x/360:3', label: '采集站' },
    { source: '360', episode: 4, url: '/x/360:4', label: '采集站' },
    { source: 'tencent', episode: 4, url: '/x/tx:4', label: '腾疼' },
  ]
  it('同源同集', () => {
    expect(pickSameSourceCandidate(list, '360', 4)?.url).toBe('/x/360:4')
  })
  it('集数/来源对不上就返回 undefined', () => {
    expect(pickSameSourceCandidate(list, '360', 5)).toBeUndefined()
    expect(pickSameSourceCandidate(list, 'iqiyi', 4)).toBeUndefined()
    expect(pickSameSourceCandidate(list, '', 4)).toBeUndefined()
  })
})

describe('freshDanmakuUrl', () => {
  it('保留原参数并追加 fresh=1', () => {
    expect(freshDanmakuUrl('/api/proxy/danmaku?name=a&episode=1')).toBe(
      '/api/proxy/danmaku?name=a&episode=1&fresh=1',
    )
    expect(freshDanmakuUrl('/x')).toBe('/x?fresh=1')
    expect(freshDanmakuUrl('')).toBe('')
  })
})

describe('源码门禁', () => {
  const player = read('src/components/player/VideoPlayer.vue')
  const settings = read('src/views/SettingsView.vue')
  const backend = readFileSync(
    join(ROOT, '..', '..', '..', 'server', 'host', 'src', 'shared', 'ApiServer.java'),
    'utf8',
  )

  it('后台补全用 fresh 绕过本地缓存，并只应用一次', () => {
    expect(player).toContain("loadDanmaku(url, { fresh: true })")
    expect(player).toContain('scheduleDmUpgrade')
    expect(player).toContain('dmPendingUpgrade')
    expect(player).toContain('已切换到更全的弹幕源')
    expect(player).toContain('freshDanmakuUrl(url)')
    expect(player).toContain("{ cache: 'no-store' }")
  })

  it('后端 fresh=1 跳过 30 分钟缓存重抓，且不误删 inflight 标记', () => {
    expect(backend).toContain('boolean fresh = "1".equals(q.getOrDefault("fresh", ""))')
    expect(backend).toContain('fetchDanmakuAuto(clean, epNo, src, fresh)')
    expect(backend).toContain('if (!fresh) DANMAKU_INFLIGHT.remove(cacheKey)')
  })

  it('手动源切集：同源同集沿用，否则恢复自动并提示', () => {
    expect(player).toContain('dmManualSource')
    expect(player).toContain('pickSameSourceCandidate(dmResults.value')
    expect(player).toContain('手动弹幕源仅对当前集有效，已恢复自动')
  })

  it('弹幕搜索弹框不再全屏压暗', () => {
    expect(player).toContain('bg-black/45')
    expect(player).toContain('max-w-md')
    expect(player).toContain('max-h-[72vh]')
    expect(player).not.toContain('bg-black/70 px-4 py-4 backdrop-blur-sm')
  })

  it('设置页：已配 danmu_api 且无显式顺序时默认聚合优先', () => {
    expect(settings).toContain('else if (typeof p.danmakuApi === \'string\' && p.danmakuApi.trim())')
    expect(settings).toContain("orderFirst.value = 'aggregator'")
  })

  it('后端裸 host 聚合按片名打分，不再直接取 animes[0]', () => {
    expect(backend).toContain('pickAnimeOrder')
    expect(backend).toContain('animeTitleScore')
    expect(backend).not.toContain('animeId = animes.optJSONObject(0)')
  })

  it('后端多个自定义 host 并发试，先成功先用', () => {
    expect(backend).toContain('List<String> customHosts')
    expect(backend).toContain('customHosts.toArray(new String[0])')
    expect(backend).toContain('if (!fs.get(idx).isDone()) continue;')
  })
})
