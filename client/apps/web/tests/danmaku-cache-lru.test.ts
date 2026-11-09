import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 弹幕缓存配额与 LRU 淘汰（2026-11-02，照搬视频缓存那套）。
 *
 * <p>背景：之前弹幕缓存只有 30 天 TTL，而 TTL **只在读的时候判断**，
 * 文件本身永不删除 —— 一季 30 集约 42MB（每集完整 XML ~1.4MB），
 * 重度用户攒几个月能到几百 MB，用户既看不到也管不了。
 *
 * <p>这条门禁锁三件事：
 *   1. 配额/模式从 policy.json 读（不写死）
 *   2. 判据是 lastModified（LRU），不是文件名/创建时间
 *   3. **正在播的那一集永不被淘汰**（用户拖进度/切回时弹幕不能突然消失）
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const CACHE = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'core', 'VideoCache.java'),
  'utf8',
)
const API = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
)
const SETTINGS = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
  'utf8',
)

function region(src: string, marker: string, len: number): string {
  const i = src.indexOf(marker)
  expect(i, `找不到锚点 ${marker}`).toBeGreaterThan(-1)
  return src.slice(i, i + len)
}

describe('弹幕缓存配额', () => {
  it('配额与模式从 policy.json 读，不写死', () => {
    expect(CACHE).toContain('danmakuCacheQuotaMb')
    expect(CACHE).toContain('danmakuCacheEvictMode')
    const body = region(CACHE, 'public static long danmakuQuotaBytes', 500)
    expect(body).toContain('policy()')
    expect(body).toContain('optLong')
  })

  it('默认 200MB；0 表示不限制', () => {
    const body = region(CACHE, 'private static final long DEFAULT_DM_QUOTA_MB', 200)
    expect(body).toContain('200')
    const quota = region(CACHE, 'public static long danmakuQuotaBytes', 500)
    expect(quota).toContain('<= 0 ? 0')
  })

  it('off 模式只告警不删（与视频缓存同语义）', () => {
    const body = region(CACHE, 'public static synchronized void enforceDanmakuQuota', 3200)
    expect(body).toContain('off')
    expect(body).toContain('不删除')
  })
})

describe('LRU 判据', () => {
  it('按 lastModified 升序淘汰（最久没动过的先删）', () => {
    const body = region(CACHE, 'public static synchronized void enforceDanmakuQuota', 3200)
    expect(body).toContain('getLastModifiedTime')
    // 升序：a 的时间 < b 的时间
    expect(body).toMatch(/Long\.compare\(Files\.getLastModifiedTime\(a\)/)
  })

  it('命中缓存时刷新 lastModified（否则 LRU 判据永远不动）', () => {
    expect(CACHE).toContain('touchDanmakuFile')
    const touch = region(CACHE, 'public static void touchDanmakuFile', 500)
    expect(touch).toContain('setLastModifiedTime')
    // ApiServer 在读盘命中处调用它
    const get = region(API, 'private static String danmakuDiskGet', 1400)
    expect(get).toContain('touchDanmakuFile')
  })
})

describe('★ 正在播的那一集永不被淘汰', () => {
  it('有 active key 机制', () => {
    expect(CACHE).toContain('danmakuActiveKey')
    expect(CACHE).toContain('touchDanmaku')
  })

  it('淘汰循环里跳过 active key 对应的文件', () => {
    const body = region(CACHE, 'public static synchronized void enforceDanmakuQuota', 3200)
    // 文件名 = md5(activeKey) + ".xml"，命中就 continue
    expect(body).toContain('protect')
    expect(body).toContain('continue')
    expect(body).toContain('md5Of')
  })

  it('读盘会标记 active，写盘不会（预取不能抢走正在播那集的保护）', () => {
    const get = region(API, 'private static String danmakuDiskGet', 1400)
    expect(get).toContain('touchDanmaku')
    /*
     * 2026-11-02 修正：写盘原本也调 touchDanmaku，于是「预取下一集」
     * 会把 activeKey 改到下一集上，正在播的那集反而失去保护，
     * 配额淘汰正好从它开始删（用户原话：「别淘汰正在播那一集的弹幕」）。
     * 现在写盘改用 enforceDanmakuQuota(key) 的临时保护位。
     */
    const put = region(API, 'private static void danmakuDiskPut', 1600)
    // 断言的是「调用」，不是注释里提到的名字
    expect(put).not.toContain('VideoCache.touchDanmaku')
    expect(put).toContain('enforceDanmakuQuota(key)')
  })

  it('主播放 handler 显式标记正在播的那一集', () => {
    // 写入侧分不出「在看」和「预取」，只能由播放器取弹幕的入口标
    const i = API.indexOf('String xml = fetchDanmakuAuto(clean, epNo, src, fresh)')
    expect(i).toBeGreaterThan(-1)
    expect(API.slice(i, i + 700)).toContain('touchDanmaku')
  })

  it('预取的「有没有缓存」探测是只读的，不改 LRU/active', () => {
    expect(API).toContain('danmakuOnDiskUnread')
    const prefetch = region(API, 'private static void handleDanmakuPrefetch', 1800)
    expect(prefetch).toContain('danmakuOnDiskUnread')
    expect(prefetch).not.toContain('danmakuDiskGet(cacheKey)')
  })

  it('写盘后立刻检查配额（不需要额外定时任务）', () => {
    const put = region(API, 'private static void danmakuDiskPut', 1600)
    expect(put).toContain('enforceDanmakuQuota')
  })
})

describe('设置页入口', () => {
  it('配额与淘汰都有 UI，且照搬视频那套控件', () => {
    expect(SETTINGS).toContain('danmakuQuotaMb')
    expect(SETTINGS).toContain('danmakuEvictMode')
    expect(SETTINGS).toContain('saveDanmakuQuota')
    // 淘汰模式用 TileSelect（与视频缓存同一套；设置页门禁禁原生 select）。
    // 注意不能取第一次出现的 danmakuEvictMode（loadPolicy 里是先出现的），
    // 要定位到模板中的 :model-value 绑定处。
    const i = SETTINGS.indexOf(':model-value="danmakuEvictMode"')
    expect(i).toBeGreaterThan(-1)
    expect(SETTINGS.slice(Math.max(0, i - 400), i + 200)).toContain('TileSelect')
  })

  it('保存时必须合并现有 policy（否则会冲掉 danmakuApi 等）', () => {
    const body = region(SETTINGS, 'async function saveDanmakuQuota', 900)
    expect(body).toContain('fetchPolicy')
    expect(body).toContain('...cur')
  })
})
