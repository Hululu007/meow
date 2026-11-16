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
  it('开头 60 秒可以直接换（2026-11-16 从 15 秒放宽）', () => {
    expect(isSafeDanmakuSwap(0, 0, now)).toBe(true)
    expect(isSafeDanmakuSwap(59.9, 0, now)).toBe(true)
  })
  it('暂停时任意位置都安全（替换无感）', () => {
    expect(isSafeDanmakuSwap(1800, 0, now, true)).toBe(true)
  })
  it('播放中段只有 10 秒内 seek 才换（续播用户靠这条）', () => {
    expect(isSafeDanmakuSwap(120, 0, now)).toBe(false)
    expect(isSafeDanmakuSwap(120, now - 5000, now)).toBe(true)
    expect(isSafeDanmakuSwap(120, now - 15000, now)).toBe(false)
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

  it('后台补全走 serverOnly 三次检查，手动选源才用 fresh', () => {
    // 12/30/60 秒三次只读后端缓存（serverOnly）；fresh 会触发真抓，
    // 播放中反复真抓纯属浪费，所以只留给"手动选源"这一条路径。
    expect(player).toContain("loadDanmaku(url, { serverOnly: true })")
    expect(player).toContain("loadDanmaku(proxyDanmakuByUrl(item.url), { fresh: true })")
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

describe('截断总数（X-Danmaku-Total）全链路', () => {
  // 这个 describe 在「源码门禁」之外，常量要自己读
  const player = read('src/components/player/VideoPlayer.vue')
  const backend = readFileSync(
    join(ROOT, '..', '..', '..', 'server', 'host', 'src', 'shared', 'ApiServer.java'),
    'utf8',
  )

  it('后端：入口清空 ThreadLocal，避免上一请求的残留当成本集总数', () => {
    // 底层 fetchTencentXml/fetchIqiyiBulletXml 还有直连调用点（手动搜索、
    // loadDanmakuById），那些路径 set 完没人 remove。不清的话同线程下一次
    // 抓取若没触顶就会读到别人的总数（X-Danmaku-Total 报错数）。
    const i = backend.indexOf('private static String runDanmakuSource')
    expect(i).toBeGreaterThan(-1)
    const body = backend.slice(i, i + 2600)
    const clear = body.indexOf('DANMAKU_TOTAL_TL.remove()')
    const firstFetch = Math.min(
      ...['fetchDanmakuFromAggregators(', 'fetchIqiyiByTitle(', 'fetchDanmakuFromTencent(']
        .map((k) => body.indexOf(k)),
    )
    expect(clear).toBeGreaterThan(-1)
    expect(clear).toBeLessThan(firstFetch)
  })

  it('后端：触顶后响应头带截断前总数', () => {
    expect(backend).toContain('DANMAKU_CAP = 60_000')
    expect(backend).toContain('set("X-Danmaku-Total"')
    expect(backend).toMatch(/capDanmakuList\([^)]*\)/)
  })

  it('前端：升级后的那份也要带 total，否则 "N+" 会退化成 "N"', () => {
    expect(player).toContain('total: totalHeader')
    expect(player).toMatch(/applyDmUpgrade\(up: \{[^}]*total: number/)
    expect(player).toContain('applyDmList(list, up.total)')
  })
})

describe('后台补全检查点（2026-11-16 前移）', () => {
  const player = read('src/components/player/VideoPlayer.vue')

  it('检查点是 8/12/16/22/30 秒，而不是旧的 12/30/60', () => {
    // 聚合源实测 7~14 秒才写完缓存；旧的 12s 那个点常赶在它之前，
    // MuMu 上表现为"要等到 +25 秒才升级"。前移到 8s 起每 4~6 秒探一次。
    expect(player).toMatch(/DM_UPGRADE_CHECKPOINTS = \[8_000, 12_000, 16_000, 22_000, 30_000\]/)
    // 每个点都必须只读后端缓存（serverOnly），不能改成 fresh（会落回小份）
    const i = player.indexOf('function scheduleDmUpgrade')
    const body = player.slice(i, i + 1400)
    expect(body).toContain('loadDanmaku(url, { serverOnly: true })')
    expect(body).not.toContain('fresh: true')
  })

  it('切集/卸载要把五个定时器全清掉', () => {
    expect(player).toContain('if (dmUpgradeChecked || dmOverrideUrl.value) return')
    // 两处清理都必须遍历数组（单变量写法会漏掉其余四个定时器）
    expect((player.match(/for \(const t of dmUpgradeTimers\) (window\.)?clearTimeout\(t\)/g) || []).length)
      .toBeGreaterThanOrEqual(2)
  })
})
