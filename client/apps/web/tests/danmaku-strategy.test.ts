import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dmPlatformOf, pickSameSourceCandidate } from '../src/components/player/dmUpgrade'

/**
 * 2026-11-19 弹幕抓取策略优化：把这些判据钉住，防止后续回退。
 *
 * 纯字符串契约（后端是 Java，前端只跑 vitest）；行为断言在
 * danmaku-upgrade / danmaku 各自文件里。
 */
const API = join(__dirname, '..', '..', '..', '..', 'server', 'host', 'src', 'shared', 'ApiServer.java')
const backend = readFileSync(API, 'utf8')
const PLAYER = join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue')
const player = readFileSync(PLAYER, 'utf8')

describe('候选季/版本校验', () => {
  it('爱奇艺按标题分选最佳专辑，不再取第一个', () => {
    expect(backend).toContain('private static int danmakuTitleScore(')
    // 取弹幕时按「目标集号 + 年份」打分（2026-11-27 起）
    expect(backend).toContain('vids.length(), ep, year);')
    // 手动搜索的候选列表没有目标集，两个维度都传 0
    expect(backend).toContain('vids.length(), 0, 0);')
    // 旧实现：第一个频道匹配就 break / return
    expect(backend).not.toContain('break;   // 只取第一个正片')
  })

  it('腾讯搜索结果按标题评分排序后再返回', () => {
    expect(backend).toContain('scores.add(danmakuTitleScore(clean, title, eps, 0, 0));')
    expect(backend).toContain('for (int b = a; b > 0 && scores.get(b) > scores.get(b - 1); b--)')
  })

  it('集数不够这一集、年份对不上都要降权', () => {
    // 覆盖不了目标集号 → 直接排除（原来只按"集数多"加分，短片也能压正片）
    expect(backend).toContain('if (episodes < wantEp) score -= 300;')
    // 年份一致加分、不一致重罚；两边都缺年份时跳过这一维
    expect(backend).toContain('score += (gotYear == wantYear) ? 80 : -150;')
  })
})

describe('手动搜索：并发 + 缓存 + 去重', () => {
  it('三源并发，总预算 9 秒', () => {
    expect(backend).toContain('fs.add(POOL.submit(() -> searchIqiyi(clean)));')
    expect(backend).toContain('fs.add(POOL.submit(() -> searchTencent(clean)));')
    expect(backend).toContain('fs.add(POOL.submit(() -> search360(clean)));')
    expect(backend).toContain('long deadline = System.currentTimeMillis() + 9_000L;')
  })

  it('搜索结果缓存 5 分钟，支持 fresh=1 跳过', () => {
    expect(backend).toContain('DANMAKU_SEARCH_CACHE.put(searchCacheKey, payload, 5 * 60_000L)')
    expect(backend).toContain('boolean searchFresh = "1".equals(q.getOrDefault("fresh", ""))')
  })

  it('同平台同集去重，direct/360 优先', () => {
    expect(backend).toContain('items = dedupeDanmakuCandidates(items)')
    expect(backend).toContain('private static int danmakuCandidateRank(JSONObject o)')
    expect(backend).toContain('} else if (rank > prevRank) {')
  })

  it('官方源异常 60 秒冷却，空结果不退避', () => {
    expect(backend).toContain('DANMAKU_SOURCE_COOLDOWN_MS = 60_000L')
    expect(backend).toContain('markDanmakuSource(names.get(i), false)')
  })
})

describe('预取质量门与让路', () => {
  it('低质量结果删缓存，让主请求重抓', () => {
    expect(backend).toContain('if (n > 0 && n < 120)')
    expect(backend).toContain('DANMAKU_CACHE.remove(cacheKey)')
    expect(backend).toContain('danmakuDiskRemove(cacheKey)')
  })

  it('预取失败不写负缓存（否则主请求先命中空串）', () => {
    expect(backend).toContain('DM_NO_NEGATIVE_CACHE')
    expect(backend).toContain('if (!Boolean.TRUE.equals(DM_NO_NEGATIVE_CACHE.get()))')
  })

  it('预取延迟 5s，主请求在跑就放弃', () => {
    expect(backend).toContain('Thread.sleep(5_000)')
    expect(backend).toContain('fetchDanmakuAutoPrefetch(clean, ep, year)')
    expect(backend).toContain('if (DANMAKU_INFLIGHT.contains(cacheKey))')
  })

  it('聚合源延迟 2s 启动，不抢直连首屏带宽', () => {
    expect(backend).toContain('final boolean delayAgg = "aggregator".equals(src)')
    expect(backend).toContain('Thread.sleep(2_000)')
  })

  it('主请求撞预取只等 1 秒', () => {
    expect(backend).toContain('DANMAKU_PREFETCHING.contains(cacheKey) ? 2 : 40')
    expect(backend).toContain('if (registered) DANMAKU_INFLIGHT.remove(cacheKey)')
  })
})

describe('腾讯时长校验', () => {
  it('getinfo 取 td 并过滤超片长弹幕', () => {
    expect(backend).toContain('private static int tencentDurationOf(String vid)')
    expect(backend).toContain('m.find()) sec = (int) Math.ceil(Double.parseDouble(m.group(1)))')
    expect(backend).toContain('sorted.removeIf(x -> Double.parseDouble(x[0]) > limit)')
    // td 可能是预告/片段时长：删掉 80% 以上就放弃过滤，不能整集删光
    expect(backend).toContain('before - over < before * 0.2')
    expect(backend).toContain('duration rejected')
  })
})

describe('手选源跨集沿用', () => {
  it('后端 prefer 排到降级链最前', () => {
    expect(backend).toContain('fetchDanmakuAuto(clean, epNo, src, fresh, prefer, year)')
    expect(backend).toContain('reordered.add(p)')
  })

  it('前端把 360 的 platform 归一成 tencent/iqiyi', () => {
    expect(dmPlatformOf({ source: '360', platform: 'qq' })).toBe('tencent')
    expect(dmPlatformOf({ source: '360', platform: 'qiyi' })).toBe('iqiyi')
    expect(dmPlatformOf({ source: 'tencent' })).toBe('tencent')
    expect(dmPlatformOf({ source: 'iqiyi' })).toBe('iqiyi')
    expect(dmPlatformOf({ source: 'imgo' })).toBe('mango')
    expect(dmPlatformOf({ source: 'youku' })).toBe('youku')
  })

  it('同平台同集能跨 360/聚合源匹配', () => {
    const list = [
      { source: '360', platform: 'qq', episode: 3, url: 'a' },
      { source: 'youku', episode: 3, url: 'b' },
    ]
    expect(pickSameSourceCandidate(list, 'tencent', 3)?.url).toBe('a')
    expect(pickSameSourceCandidate(list, 'youku', 3)?.url).toBe('b')
    expect(pickSameSourceCandidate(list, 'iqiyi', 3)).toBeUndefined()
  })

  it('找不到同源时把平台透传给自动接口', () => {
    expect(player).toContain('function withDmPrefer(url: string, prefer: string): string')
    expect(player).toContain("return url + '&prefer=' + encodeURIComponent(p)")
  })
})
