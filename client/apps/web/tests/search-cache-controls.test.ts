import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 搜索缓存 / 跳过 / 强刷的「界面 ↔ 后端」一致性，2026-10-30 实现。
 *
 * 起因（用户的三个问题）：
 *   1. 搜索页的强刷**根本没接** —— 后端 `refresh` 参数早就有，
 *      但 `startSearch(wd, threads)` 没有第三个参数，界面上也没有按钮。
 *      于是"同词再搜"永远是毫秒级返回同一份缓存，用户以为搜索坏了。
 *   2. 设置页站点弹框只认 `disabled/unsupported`，而搜索实际还会跳过
 *      `failed`（实测 141 个）和 `timeout` 两类，界面说的和后端做的不一致。
 *   3. 缓存 TTL、清缓存、重置健康这些机制**用户看不见也管不了**。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')
const HEALTH = join(ROOT, 'server', 'host', 'src', 'shared', 'routes', 'HealthRoutes.java')
const WEB_API = join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'index.ts')
const VIEW = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SearchView.vue')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')

describe('强刷（refresh）贯通', () => {
  const api = readFileSync(WEB_API, 'utf8')
  const view = readFileSync(VIEW, 'utf8')
  const back = readFileSync(API, 'utf8')

  it('后端读 refresh 且普通搜索不写回覆盖', () => {
    expect(back).toContain('req.optBoolean("refresh", false)')
  })

  it('前端 startSearch 能传 refresh', () => {
    const i = api.indexOf('export async function startSearch')
    expect(i, 'startSearch 不存在').toBeGreaterThan(0)
    const sig = api.slice(i, i + 420)
    expect(sig, 'startSearch 没有 refresh 参数').toContain('refresh = false')
    expect(sig, 'startSearch 没把 refresh 放进 body').toContain('refresh }')
  })

  it('搜索页有重新搜索按钮且会传 true', () => {
    expect(view, '没有 run(true) 调用 → 按钮没接上').toContain('run(true)')
    expect(view, '没有「重新搜索」文案').toContain('重新搜索')
    expect(view).toContain('startSearch(k, getPrefs().searchThreads, force)')
  })

  it('★ watch 不能直接传 run（会把搜索词当 force）', () => {
    /*
     * 这是个静默的严重 bug：watch 回调签名是 (newVal, oldVal)，
     * 直接 `watch(wd, run)` 会把**新的搜索词字符串**当成 force。
     * 字符串是 truthy → 每次输入都强刷 → 缓存完全失效，每次搜索 30 秒。
     * 而且不会报任何错，只能靠肉眼看日志发现"怎么每轮都真跑"。
     */
    expect(view, 'watch 直接传了 run，会把搜索词当 force').not.toMatch(/watch\(\s*wd\s*,\s*run\s*,/)
    expect(view, '应改为箭头函数包一层').toMatch(/watch\(\s*wd\s*,\s*\(\)\s*=>\s*run\(\)/)
  })
})

describe('缓存可管理', () => {
  const back = readFileSync(API, 'utf8')
  const api = readFileSync(WEB_API, 'utf8')
  const settings = readFileSync(SETTINGS, 'utf8')

  it('后端有统计与清空端点，且排在 /api/ 兜底之前', () => {
    expect(back).toContain('"/api/search/cache".equals(path)')
    expect(back).toContain('SEARCH_CACHE.clear()')
    expect(back).toContain('SEARCH_CACHE.statsJson()')
  })

  it('TTL 可从 policy.json 读，改完立即重载', () => {
    expect(back).toContain('resolveTtl("searchCacheHitSec"')
    expect(back).toContain('resolveTtl("searchCacheMissSec"')
    expect(back).toContain('resolveTtl("searchCacheFailSec"')
    // savePolicy 里必须重算，否则用户改完要重启后端才生效
    const i = back.indexOf('private static void savePolicy')
    expect(back.slice(i, i + 600), 'savePolicy 没调 reloadTtl').toContain('SearchCache.reloadTtl()')
  })

  it('前端有清空缓存入口与 TTL 下拉', () => {
    expect(api).toContain('export async function clearSearchCache')
    expect(api).toContain('export async function fetchSearchCacheStats')
    expect(settings).toContain('@click="clearSearchCacheNow"')
    expect(settings).toContain('searchCacheHitSec')
  })
})

describe('跳过状态由后端下发，前端不重算', () => {
  const back = readFileSync(API, 'utf8')
  const settings = readFileSync(SETTINGS, 'utf8')
  const health = readFileSync(HEALTH, 'utf8')

  it('后端在 /api/sites 里下发 skippedFailed / skippedTimeout', () => {
    expect(back).toContain('skippedFailed')
    expect(back).toContain('skippedTimeout')
    expect(health).toContain('public static boolean isFailedSkipped')
  })

  it('前端展示"已跳过"，且优先于"反复失败"', () => {
    /*
     * 判据不同：degraded = 连续失败 3 次；skippedFailed = 累计失败 ≥5 且
     * 30 分钟无成功。实测大量源 degraded=true 但没被跳过，
     * 只显示"反复失败"会让用户看不出它是否参与搜索。
     */
    expect(settings).toContain('已跳过·失效')
    expect(settings).toContain('已跳过·超时')
    const i = settings.indexOf('function healthLabel')
    const fn = settings.slice(i, i + 900)
    expect(fn.indexOf('skippedFailed'), '跳过判据应排在 degraded 之前')
      .toBeLessThan(fn.indexOf('h.degraded'))
  })

  it('前端不自己按 fail 次数推断跳过', () => {
    // 两套判据一定漂移，界面说的和后端做的就对不上
    expect(settings).not.toMatch(/skipped\w*:\s*.*fail\s*>=/)
  })

  it('重置健康有后端端点与前端按钮', () => {
    expect(health).toContain('public static synchronized void resetAll')
    expect(back).toContain('"/api/health/reset"')
    expect(settings).toContain('@click="resetSourceHealth"')
    /*
     * ★ reset 端点必须排在路由兜底之前，否则永远 404（AGENTS §4.3）。
     *
     * 注意 `path.startsWith("/api/health/")` 在文件里出现两次：
     * 第一次是 CORS 白名单（不是路由），第二次才是 404 兜底。
     * 必须从 reset 之后开始找，否则会抓到白名单那处、测试假失败。
     */
    const resetIdx = back.indexOf('"/api/health/reset"')
    const guardIdx = back.indexOf('path.startsWith("/api/health/")', resetIdx)
    expect(guardIdx, '找不到 reset 之后的 health 前缀兜底').toBeGreaterThan(resetIdx)
  })
})
