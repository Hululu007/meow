import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 弹幕源的"能取到真弹幕"门禁（2026-11-02 加 360 + 修腾讯）。
 *
 * 背景：用户问「TV 能不能内置 danmu_api」。结论是 TV 上没有 Node，
 * 但 danmu_api 的**取弹幕逻辑**本身不需要 Node —— 所以在 Java 侧补齐。
 * 这轮做了两件事：
 *
 *   1. 新增 360 看（采集站）作为定位层：它给出「哪个平台、第几集、
 *      平台内 vid」，补上爱奇艺/腾讯**按标题搜不到正片**的缺口
 *      （实测：凡人修仙传正片在 B站/优酷，爱奇艺只有片花解说）；
 *
 *   2. 修掉腾讯线的致命 bug：`mfm.video.qq.com/danmu?second=N` 的
 *      `second` 参数**完全不生效**，每次返回同一批 300 条 timepoint
 *      落在 0~29 秒的弹幕。旧代码因此把腾讯线默认关闭。
 *      改用 `dm.video.qq.com/barrage/{base,segment}` 分片接口后，
 *      实测 40000 条弹幕覆盖 0~3983 秒（每 5 分钟约 3000 条）。
 */
// tests/ → web/ → apps/ → client/ → 仓库根
const REPO = join(__dirname, '..', '..', '..', '..')
const API = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
)

function region(startMarker: string, len = 3000): string {
  const i = API.indexOf(startMarker)
  expect(i).toBeGreaterThan(-1)
  return API.slice(i, i + len)
}

describe('360 看：定位层', () => {
  it('搜索入口挂进了 searchOfficialSources', () => {
    const body = region('private static List<JSONObject> searchOfficialSources', 2200)
    expect(body).toContain('searchIqiyi')
    expect(body).toContain('searchTencent')
    expect(body).toContain('search360')
    // 必须排在最后：它是补充，前两家有结果时不必等它
    expect(body.indexOf('search360')).toBeGreaterThan(body.indexOf('searchTencent'))
  })

  it('★ 必须重试，否则会误判"这部剧 360 没有"', () => {
    // 实测同一条请求前两次返回 code:0 + 空 longData，第 3 次才有 rows。
    // 不重试的话结论完全错误（我在命令行里因此误判过两次）。
    const body = region('private static List<JSONObject> search360', 4000)
    expect(body).toMatch(/attempt\s*<\s*3/)
    expect(body).toContain('Thread.sleep')
  })

  it('必须用桌面 Chrome UA（默认 UA 会静默返回空 rows）', () => {
    expect(API).toContain('S360_UA')
    const body = region('private static final String S360_UA', 300)
    expect(body).toContain('Chrome/91')
  })

  it('关键词要拆掉季度后缀（搜"庆余年第二季"是 0 条，"庆余年"有 4 条）', () => {
    expect(API).toContain('splitSeasonKeyword')
    const body = region('private static String[] splitSeasonKeyword', 1500)
    expect(body).toContain('[季部]')
    // 结尾单数字也要拆（"庆余年2"）
    expect(body).toMatch(/\\d\)/)
  })

  it('seriesPlaylinks 是逐集数据，只收有的条目', () => {
    const body = region('private static List<JSONObject> search360', 4000)
    expect(body).toContain('seriesPlaylinks')
    // 没有 seriesPlaylinks 的条目要跳过（电影/综艺拿不到逐集 id）
    expect(body).toMatch(/sp\s*==\s*null\s*\|\|\s*sp\.length\(\)\s*==\s*0/)
  })
})

describe('腾讯弹幕：必须走分片接口', () => {
  it('★ 不得再用 mfm.video.qq.com 的 second 翻页', () => {
    // 该接口的 second 参数实测无效，会把 3 万条全堆在第 0 秒
    const body = region('private static String fetchTencentXml', 6000)
    expect(body).not.toContain('TENCENT_DANMU')
    expect(body).not.toContain('&second=')
  })

  it('用 dm.video.qq.com 的 base + segment 两个端点', () => {
    expect(API).toContain('TENCENT_SEG_BASE')
    expect(API).toContain('TENCENT_SEG_PART')
    const body = region('private static final String TENCENT_SEG_BASE', 200)
    expect(body).toContain('dm.video.qq.com/barrage/base/')
    const body2 = region('private static final String TENCENT_SEG_PART', 200)
    expect(body2).toContain('dm.video.qq.com/barrage/segment/')
  })

  it('绝对时间 = 分片起点 + 片内偏移（time_offset 是片内的）', () => {
    const body = region('private static String fetchTencentXml', 6000)
    expect(body).toContain('time_offset')
    expect(body).toContain('startMs + off')
    // 分片必须先按起点排序，否则绝对时间会错乱（JSON 对象无序）
    expect(body).toContain('segs.sort')
  })

  it('腾讯自动抓取默认开启（时间轴问题已修）', () => {
    const body = region('private static boolean isTencentAutoEnabled', 900)
    expect(body).toContain('optBoolean("danmakuTencent", true)')
  })
})

describe('候选 id 的解析', () => {
  it('tencent 的第二段有两种含义：cid（纯数字）与 vid（含字母）', () => {
    expect(API).toContain('looksLikeTencentVid')
    const body = region('private static boolean looksLikeTencentVid', 500)
    expect(body).toContain('[A-Za-z]')
    const load = region('private static String loadDanmakuById', 1500)
    // 是 vid 就直接取，否则当 cid 走 float_vinfo2
    expect(load).toContain('looksLikeTencentVid')
    expect(load).toContain('fetchTencentXml')
  })

  it('360 的候选要归一成 handler key（qiyi/qq → iqiyi/tencent）', () => {
    const body = region('private static String danmakuHandlerFor', 1200)
    expect(body).toContain('tencent')
    // 爱奇艺不归一：360 给的 v_xxx 无法转成 Bullet 要的 16 位 tvId
    expect(body).not.toMatch(/s\.equals\("qiyi"\)\)\s*return\s*"iqiyi"/)
  })
})

describe('自动播放的降级顺序可配（danmakuOrder）', () => {
  it('★ 顺序从 policy.json 读，不再写死', () => {
    expect(API).toContain('danmakuOrder')
    const body = region('private static String[] danmakuOrder', 2200)
    // 数组与字符串两种写法都要支持（设置页写数组，手改写字符串）
    expect(body).toContain('optJSONArray')
    expect(body).toContain('optString')
    // 未知项跳过，且缺省回退默认顺序（永远不返回空数组）
    expect(body).toContain('DEFAULT')
  })

  it('降级链按配置顺序执行，aggregator 可以被排到第一个', () => {
    const body = region('private static String fetchDanmakuAuto0', 5000)
    // 2026-11-02 起是「并发抢占」：所有源同时发，先到先用。
    // 关键是不能写死顺序 —— 必须从 danmakuOrder() 取。
    expect(body).toContain('danmakuOrder()')
    expect(body).toContain('runDanmakuSource')
    // 按完成顺序收（轮询 isDone），不能按数组顺序 get()
    expect(body).toContain('isDone()')
    // 单源可配：只写 aggregator 就只跑它
    expect(API).toContain('fetchDanmakuFromAggregators')
    expect(API).toContain('fetchDanmakuFromTencent')
  })

  it('★ 后台补全只在条数明显更多时覆盖（避免无意义抖动）', () => {
    const body = region('private static String tellLaterIfBetter', 1200)
    // 1.2 倍门槛：7978 → 8100 这种差异不值得换一次缓存
    expect(body).toContain('1.2')
    // 后台线程必须是 daemon，不能拖住 JVM 退出
    const auto = region('private static String fetchDanmakuAuto0', 5000)
    expect(auto).toContain('setDaemon(true)')
  })

  it('腾讯开关关掉时整档跳过（只影响自动播放，手动搜索仍有）', () => {
    const body = region('private static String fetchDanmakuFromTencent', 900)
    expect(body).toContain('isTencentAutoEnabled')
  })

  it('设置页能选优先谁，并写进 policy', () => {
    const S = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    expect(S).toContain('orderFirst')
    expect(S).toContain('danmakuOrder')
    // 两个选项都要在界面上
    expect(S).toContain('内置直连优先')
    expect(S).toContain('弹幕 API 优先')
  })
})

describe('下集弹幕预取（片尾前）', () => {
  it('后端有预取端点，且立刻返回不阻塞', () => {
    expect(API).toContain('handleDanmakuPrefetch')
    expect(API).toContain('/api/proxy/danmaku/prefetch')
    const body = region('private static void handleDanmakuPrefetch', 3000)
    // 先回 queued/cached 再起线程 —— 预取是"顺手做"，不能阻塞前端
    // 源码里是 JSON 转义形式 \"queued\"
    expect(body).toContain('queued')
    expect(body).toContain('setDaemon(true)')
  })

  it('★ 预取走完整降级链（含 danmu_api），与主请求同一条路', () => {
    /*
     * 2026-11-02 用户指正：预取发生在片尾前 3 分钟，而 danmu_api 限流窗口
     * 是 1 分钟、额度 3 次 —— 三分钟内最多 1 次预取 + 1 次主请求，
     * 打不满额度。所以预取应走**同一条降级链**，拿到的就是最全的那份。
     *
     * 早期版本为躲限流只走内置源，那个担心是错估了时间尺度。
     */
    const body = region('private static void handleDanmakuPrefetch', 3000)
    expect(body).toContain('fetchDanmakuAuto')
    // 不能再自己拼 iqiyi/tencent 列表（那样两边行为会漂移）
    expect(body).not.toContain('new String[]{"iqiyi", "tencent"}')
  })

  it('预取可关、提前量可配', () => {
    const body = region('private static void handleDanmakuPrefetch', 3000)
    expect(body).toContain('isDanmakuPrefetchEnabled')
    expect(body).toContain('disabled')
    const lead = region('private static int danmakuPrefetchLeadSec', 900)
    expect(lead).toContain('180')
    expect(lead).toContain('3600')
  })

  it('幂等：已有缓存直接 cached，不重复抓', () => {
    const body = region('private static void handleDanmakuPrefetch', 3000)
    expect(body).toContain('cached')
    // 磁盘那半用只读探测：预取的「查有没有」不能篡改 activeKey/LRU
    expect(body).toContain('danmakuOnDiskUnread')
  })

  it('前端在片尾前触发，且每集只触发一次', () => {
    const P = readFileSync(
      join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
      'utf8',
    )
    expect(P).toContain('maybePrefetchNextDanmaku')
    expect(P).toContain('prefetchedEp')
    // 公式：min(片尾标记, 时长) - 提前量（用户定的写法）
    expect(P).toMatch(/Math\.min\(mark, dur\)\s*-\s*prefetchLead\.value/)
    // 开关与提前量都要能配
    expect(P).toContain('prefetchOn')
    expect(P).toContain('prefetchLead')
    // 没有下一集就不预取
    expect(P).toContain('i + 1 >= playlist.value.length')
  })
})

describe('首屏等待预算（调序后"出弹幕慢了"的根因）', () => {
  /*
   * 2026-11-02 实测：把 aggregator 排到第一位后，冷启动 6318ms 返回空。
   * 因为首屏截止写死 6 秒，而 danmu_api 聚合实测要 11–14 秒
   * （串行查多个平台，再并发拉几十个分片）。
   */
  it('预算按源自适应，不是写死 6 秒', () => {
    expect(API).toContain('danmakuFirstScreenMs')
    const body = region('private static long danmakuFirstScreenMs', 1400)
    // 聚合排第一 → 10s（用户明确选了「弹幕 API 优先」，就该等它）
    expect(body).toContain('10_000L')
    expect(body).toContain('"aggregator".equals(order[0])')
    // 其它情况 → 6s（直连最慢 5s，等得到）
    expect(body).toContain('6_000L')
  })

  it('首屏循环用的是这个预算，不再有裸的 6_000L', () => {
    const loop = region('private static String fetchDanmakuAuto0', 4200)
    expect(loop).toContain('danmakuFirstScreenMs(order)')
    expect(loop).not.toContain('+ 6_000L')
  })

  it('聚合在后台补全时，只有明显更全才覆盖（1.2 倍门槛）', () => {
    const loop = region('private static String fetchDanmakuAuto0', 6000)
    expect(loop).toContain('bg-upgrade')
    expect(loop).toMatch(/1\.2|120\s*\/\s*100/)
  })
})
