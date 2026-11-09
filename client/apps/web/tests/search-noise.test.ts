import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 搜索噪音过滤（用户可维护的词表）。
 *
 * 需求原话：「设置页的"搜索与源"是不是应该加 搜索"噪音关键词"表（用户自行维护），
 * 避免在搜某剧时出现解说、花絮等内容。」
 *
 * 这条链路横跨四处，任何一处漏掉功能就静默失效，所以逐处锁住：
 *   ① 后端 policy 读词表（searchNoise）
 *   ② 后端 mergeOne 里剔除条目并计数
 *   ③ 前端设置页可编辑
 *   ④ 搜索页把"滤掉了几条"显示出来
 *   ⑤ 手机推送页也能改（TV 上没法输一长串词）
 *
 * 实测对照（19981 临时实例，44 源）：
 *   无词表 count=100 noiseFiltered=0
 *   有词表 count=97  noiseFiltered=3
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const SEARCH = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SearchView.vue')
const PUSH = join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'PushServer.java')

describe('搜索噪音过滤', () => {
  it('后端从 policy 读 searchNoise，且空表不过滤', () => {
    const src = readFileSync(API, 'utf8')
    expect(src, '没有读 searchNoise').toContain('optString("searchNoise"')
    expect(src, '词表为空时没有短路').toMatch(
      /if \(raw == null \|\| raw\.trim\(\)\.isEmpty\(\)\) return java\.util\.Collections\.emptyList\(\)/,
    )
    // 单字太容易误伤（"剧""片"命中几乎所有内容）
    expect(src, '没有过滤单字').toMatch(/t\.length\(\) >= 2/)
  })

  it('命中判据同时看片名和备注', () => {
    const src = readFileSync(API, 'utf8')
    // 很多源把"解说"写在 remarks 里而片名仍是正剧名，只看片名会漏掉这类
    const i = src.indexOf('private static boolean isNoise(')
    expect(i, '找不到 isNoise').toBeGreaterThan(-1)
    const body = src.slice(i, src.indexOf('\n    }', i))
    expect(body, 'isNoise 没看备注').toContain('remarks')
    expect(body, 'isNoise 没做大小写归一').toMatch(/toLowerCase/)
  })

  it('mergeOne 里真的剔除并计数', () => {
    const src = readFileSync(API, 'utf8')
    expect(src, 'mergeOne 没接词表参数').toMatch(
      /mergeOne\(Map<String, JSONObject> merged, String name, String raw,\s*\n?\s*String wd, java\.util\.List<String> noiseWords/,
    )
    expect(src, 'mergeOne 里没调 isNoise').toContain('isNoise(title, remarks, noiseWords)')
    expect(src, '命中了但没有计数').toContain('noiseHit.incrementAndGet()')
    // 两处调用（缓存路径 + 实跑路径）都要传，漏一处就有一半结果不过滤
    const calls = src.match(/mergeOne\(merged,[^;]*noiseWords,[^;]*noiseMarked\)/g) || []
    expect(calls.length, 'mergeOne 的调用点没有全部接上词表（缓存/实跑各一处）').toBe(2)
  })

  it('过滤条数要报给前端（否则用户以为源站没有）', () => {
    const src = readFileSync(API, 'utf8')
    expect(src, 'SearchTask 没有 noiseFiltered').toContain('volatile int noiseFiltered')
    expect(src, 'taskJson 没有输出 noiseFiltered').toContain('o.put("noiseFiltered", t.noiseFiltered)')
    const view = readFileSync(SEARCH, 'utf8')
    expect(view, '搜索页没显示过滤条数').toContain('已滤掉')
  })

  it('设置页在「搜索与源」区提供编辑入口 + 推荐词', () => {
    const src = readFileSync(SETTINGS, 'utf8')
    expect(src, '没有噪音输入框').toContain('v-model="noiseInput"')
    expect(src, '没有推荐词按钮').toContain('fillNoisePreset')
    expect(src, '没有清空入口').toContain('clearNoise')
    // 编辑区必须落在 source 分区内（用户要求"搜索与源"）
    const secStart = src.indexOf('data-sec="source"')
    const secEnd = src.indexOf('data-sec="play"')
    expect(secStart, '找不到搜索与源区').toBeGreaterThan(-1)
    expect(secEnd, '找不到区段结束边界').toBeGreaterThan(secStart)
    expect(src.slice(secStart, secEnd), '噪音过滤不在「搜索与源」区').toContain('noiseInput')
  })

  it('手机推送页也能改（TV 上没法输长词表）', () => {
    const src = readFileSync(PUSH, 'utf8')
    expect(src, '手机页缺噪音词字段').toMatch(/\['g_searchNoise',\s*'searchNoise',\s*'text'\]/)
    expect(src, '手机页缺噪音词输入框').toContain('id=\\"g_searchNoise\\"')
  })

  it('支持「过滤隐藏」与「仅排序降级」两种模式', () => {
    const api = readFileSync(API, 'utf8')
    // 后端读模式，且只认这两个值（拼错按 filter 兜底：静默失效最难排查）
    expect(api, '后端没读 searchNoiseMode').toContain('optString("searchNoiseMode"')
    expect(api, '模式没有归一化兜底').toMatch(/"rank"\.equals\(m\) \? "rank" : "filter"/)
    // rank 模式不能剔除，只能打标记
    expect(api, 'rank 模式没有打 noise 标记').toContain('entry.put("noise", true)')
    expect(api, '没有降级计数').toContain('noiseDowngraded')

    // 前端 scoreGroup 要读到这个标记并沉底
    const rank = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'searchRank.ts'), 'utf8')
    expect(rank, 'scoreGroup 没处理 noise 标记').toMatch(/if \(g\.noise\) s -= \d+/)

    // 设置页要有模式选择
    const settings = readFileSync(SETTINGS, 'utf8')
    expect(settings, '设置页没有模式开关').toContain('noiseModeOptions')
    expect(settings, '保存时没带上模式').toContain('searchNoiseMode: noiseMode.value')

    // 手机页也要能切
    const push = readFileSync(PUSH, 'utf8')
    expect(push, '手机页缺模式字段').toMatch(/\['g_searchNoiseMode',\s*'searchNoiseMode',\s*'text'\]/)
  })

  it('降级模式必须比 UGC_RE 的降权更狠（否则开关等于没生效）', () => {
    const rank = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'searchRank.ts'), 'utf8')
    const ugc = rank.match(/UGC_RE\.test\(name\)[^\n]*s -= (\d+)/)
    const noise = rank.match(/if \(g\.noise\) s -= (\d+)/)
    expect(ugc, '找不到 UGC_RE 降权幅度').toBeTruthy()
    expect(noise, '找不到 noise 降权幅度').toBeTruthy()
    // 用户明确填的词表，意图比通用正则更确定 → 必须沉得更狠，
    // 而且要压过"完全同名 +1000"（1000 - noise < 0）
    expect(Number(noise![1]), 'noise 降权没有比 UGC_RE 更狠').toBeGreaterThan(Number(ugc![1]))
    expect(Number(noise![1]), 'noise 降权不足以压过完全同名(+1000)').toBeGreaterThan(1000)
  })

  it('推荐词表不能含"直播/回放"这类用户可能真想看的词', () => {
    const src = readFileSync(SETTINGS, 'utf8')
    const i = src.indexOf('const NOISE_PRESET')
    expect(i, '找不到推荐词表').toBeGreaterThan(-1)
    const body = src.slice(i, src.indexOf(']', i))
    for (const bad of ['直播', '回放', '录播', '电视剧', '电影', '动漫']) {
      expect(body, `推荐词里不该有「${bad}」：那可能是用户真想看的内容或正常分类`)
        .not.toContain(bad)
    }
    // 必须有的核心噪音词
    for (const good of ['解说', '混剪', '影评']) {
      expect(body, `推荐词缺少核心项「${good}」`).toContain(good)
    }
  })
})
