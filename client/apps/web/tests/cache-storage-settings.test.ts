import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「存储」区与弹幕缓存的门禁。
 *
 * 锁两件事（都是 2026-10-30 用户明确提的）：
 *   1. 设置页不该列逐条缓存清单 —— 管理入口在「我的缓存」页，这里只显示占用；
 *   2. 缓存一集必须顺带把弹幕存下来，否则断网播放没弹幕，
 *      而"离线也能看完一集"这个目标里的"看完"包含弹幕。
 */
const WEB = join(__dirname, '..')
const REPO = join(WEB, '..', '..', '..')
const SETTINGS = readFileSync(join(WEB, 'src', 'views', 'SettingsView.vue'), 'utf8')
const CACHE_JAVA = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'core', 'VideoCache.java'),
  'utf8',
)
const API_JAVA = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
)

/** 去掉 HTML/JS 注释，避免注释里写的"不要清单"把断言骗过去。 */
function codeOnly(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('设置页「存储」区', () => {
  const code = codeOnly(SETTINGS)

  it('不再逐条列出缓存（cachItems 的 v-for 已删除）', () => {
    expect(code).not.toContain('v-for="c in cacheItems"')
    expect(code).not.toContain("dropCache(")
  })

  it('显示视频缓存与弹幕缓存两块占用', () => {
    expect(code).toContain('视频缓存')
    expect(code).toContain('弹幕缓存')
  })

  it('弹幕占用未知时显示「—」而不是 0（老后端不返回该字段）', () => {
    expect(code).toContain("if (n === null) return '—'")
    // 默认值必须是 null：默认 0 会把"不知道"说成"没有"
    expect(code).toContain('const danmakuBytes = ref<number | null>(null)')
  })
})

describe('弹幕缓存', () => {
  it('缓存一集时预取弹幕（VideoCache 调用 DanmakuPrefetcher）', () => {
    expect(CACHE_JAVA).toContain('bindDanmakuPrefetcher')
    expect(CACHE_JAVA).toContain('prefetchDanmaku(t)')
    // 必须在分片齐了之后调，否则会和下载抢带宽、m3u8 拉不到时白花时间
    const i = CACHE_JAVA.indexOf('prefetchDanmaku(t)')
    expect(CACHE_JAVA.indexOf('一个分片都没下到')).toBeLessThan(i)
  })

  it('内存缓存命中也要补落盘（否则"先在线看过再缓存"永远不写盘）', () => {
    /*
     * 2026-11-02 重构后有两处 `String cacheKey = "dm|"`（tellLaterIfBetter 与
     * fetchDanmakuAuto），所以锚点要定在**缓存命中分支**所在的那个函数上：
     * 直接用 `fetchDanmakuAuto(String clean` 的签名定位，再验它内部的命中分支
     * 会调 storeDanmaku（它内部才调 danmakuDiskPut）。
     */
    const anchor = API_JAVA.indexOf(
      'private static String fetchDanmakuAuto(String clean, int ep, String[] sourceOut)',
    )
    expect(anchor).toBeGreaterThan(-1)
    const seg = API_JAVA.slice(anchor, anchor + 2600)
    // 命中分支必须写盘（直接或经 storeDanmaku）
    expect(seg).toMatch(/danmakuDiskPut|storeDanmaku/)
    // storeDanmaku 本体必须真的调 danmakuDiskPut
    const store = API_JAVA.indexOf('private static String storeDanmaku')
    expect(store).toBeGreaterThan(-1)
    expect(API_JAVA.slice(store, store + 900)).toContain('danmakuDiskPut')
  })

  it('有清理入口：过期与全部两档', () => {
    expect(CACHE_JAVA).toContain('clearDanmaku(')
    expect(CACHE_JAVA).toContain('DANMAKU_TTL_MS')
    expect(codeOnly(SETTINGS)).toContain("controlCache('clearDanmaku'")
  })
})
