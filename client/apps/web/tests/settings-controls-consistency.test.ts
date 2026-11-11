import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页的控件必须统一。
 *
 * 起因（2026-10-30 用户连续截图两处）：
 *   1. 「搜索缓存时长」三个下拉写成原生 `<select>`，混在磁贴网格里 ——
 *      高度、圆角、点击反馈全不一致，而且原生弹层在深色主题下是系统白底；
 *   2. 离线缓存的「超限时」也是原生 `<select>`，同样的问题。
 *
 * 项目已有 `TileSelect`（磁贴样式的下拉）作为唯一正确形态，
 * 27 处设置项都用它。所以这条门禁很直接：设置页里不许出现原生 `<select>`。
 *
 * 为什么不在别处禁：LogsView 的模块筛选是紧凑工具条，原生 select 更合适；
 * 那里不在设置页的"磁贴网格"语境里。这条只约束设置页。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const TOKENS = join(ROOT, 'client', 'apps', 'web', 'src', 'styles', 'tokens.css')

describe('设置页控件统一', () => {
  const src = readFileSync(SETTINGS, 'utf8')

  it('不使用原生 <select>（必须用 TileSelect）', () => {
    const hits = [...src.matchAll(/<select[\s>]/g)]
    expect(
      hits.length,
      `设置页有 ${hits.length} 处原生 <select>：它在深色主题下弹系统白底，` +
        `且高度/圆角与周围磁贴不一致。改用 TileSelect。`,
    ).toBe(0)
  })

  it('TileSelect 是设置页的主要下拉形态', () => {
    // 27 处使用；少于 20 说明有人改回了原生控件或删了大批设置项
    const n = (src.match(/<TileSelect/g) || []).length
    expect(n, `TileSelect 只用 ${n} 处，疑似退化`).toBeGreaterThanOrEqual(20)
  })

  it('搜索缓存的三档时长都在「搜索与源」区', () => {
    /*
     * 用户原话：「应该放到 浏览与搜索 区域内」。
     * 它原来在「数据与维护」—— 那是放"清除/重置"这类维护动作的地方，
     * 而缓存时长是**搜索行为的参数**，与搜索线程、搜索展示同类。
     *
     * 2026-10-30 再次重构：「浏览与搜索」整区并进了「搜索与源」，
     * 因为"某部剧搜不到"要在三个区之间跳。断言跟着改到 source 区。
     *
     * 模板里是 `v-for="f in cacheTtlFields"` 渲染三档，所以断言要检查
     * 那个循环变量，而不是逐个 key 名（踩过一次：直接找 searchCacheHitSec
     * 找不到，因为它只出现在 script 里的常量定义中）。
     */
    const i = src.indexOf('data-sec="source"')
    const j = src.indexOf('data-sec="play"')
    expect(i, '找不到搜索与源区').toBeGreaterThan(-1)
    expect(j, '找不到播放区（用作区段结束边界）').toBeGreaterThan(i)
    const block = src.slice(i, j)
    expect(block, '三档缓存磁贴不在搜索与源区').toContain('cacheTtlFields')
    expect(block, '缓存说明文案不在搜索与源区').toContain('searchCacheStats')
    // 反向：维护区不该再有它
    const mi = src.indexOf('data-sec="maint"')
    expect(mi).toBeGreaterThan(j)
    expect(src.slice(mi), '缓存时长还留在维护区').not.toContain('cacheTtlFields')
  })

  it('color-scheme 必须跟随 data-mode（否则 light 下原生控件仍是深色）', () => {
    /*
     * 原生控件（滚动条、select 弹层、数字框箭头）由 color-scheme 决定配色，
     * 不跟 CSS 变量。原来 `:root` 写死 dark，light 主题下点开下拉还是深色菜单。
     */
    const css = readFileSync(TOKENS, 'utf8')
    expect(css, '没有 light 的 color-scheme 覆盖').toMatch(
      /html\[data-mode=['"]light['"]\]\s*\{[^}]*color-scheme:\s*light/,
    )
  })
})

/**
 * 分区归属门禁（2026-10-30 第三轮）。
 *
 * 用户连续三轮在调整分区，每轮都是"某几个控件放错了地方"。这里把**已经
 * 达成一致的归属**锁成断言，避免下次重构又把它们挪回去 —— 挪动本身不报错，
 * 只有用户翻设置页才会发现，代价很高。
 *
 * 断言写法：取"该分区起点 → 下一个分区起点"的源码片段，检查关键词在其中。
 * 分区起点用 `data-sec="x"`，因为那是导航与滚动高亮共用的唯一标识。
 */
describe('设置页分区归属', () => {
  const src = readFileSync(SETTINGS, 'utf8')

  /** 取某个分区（data-sec）到下一个分区之间的源码。 */
  function blockOf(id: string): string {
    const i = src.indexOf(`data-sec="${id}"`)
    expect(i, `找不到分区 ${id}`).toBeGreaterThan(-1)
    const rest = src.slice(i + 10)
    const next = rest.search(/data-sec="/)
    return next < 0 ? rest : rest.slice(0, next)
  }

  it('搜索相关控件都在「搜索与源」区', () => {
    const b = blockOf('source')
    for (const k of ['cacheTtlFields', 'searchLayout', 'searchThreads', 'healthTiles', 'cacheTiles', 'settings-sites']) {
      expect(b, `「搜索与源」区缺少 ${k}`).toContain(k)
    }
  })

  it('列数上限在「外观」区（列表密度属于外观）', () => {
    expect(blockOf('appearance'), '列数上限不在外观区').toContain('homeCols')
  })

  it('历史记录条数在「存储」区（这是留多久，不是怎么搜）', () => {
    expect(blockOf('storage'), '历史记录条数不在存储区').toContain('historyLimit')
    // 反向：不能又回到搜索区
    expect(blockOf('source'), '历史记录条数又跑回搜索区了').not.toContain('historyLimit')
  })

  it('本地弹幕在「弹幕」区（它属于弹幕，不属于离线缓存）', () => {
    expect(blockOf('danmaku'), '本地弹幕不在弹幕区').toContain('dmLocal')
    expect(blockOf('storage'), '本地弹幕又跑回存储区了').not.toContain('dmLocal')
  })

  it('DNS 在「网络与加速」区（网络层，不是源配置）', () => {
    const b = blockOf('net')
    expect(b, '安全DNS 不在网络与加速区').toContain('dnsChoice')
    expect(b, 'DNS 测试不在网络与加速区').toContain('probeDns')
    expect(blockOf('source'), 'DNS 又跑回搜索与源区了').not.toContain('dnsChoice')
  })

  it('WebDAV 有独立分区，不与存储混在一起', () => {
    const b = blockOf('sync')
    expect(b, 'WebDAV 分区里没有 dav').toContain('dav.')
    expect(blockOf('storage'), 'WebDAV 又混回存储区了').not.toContain('dav.url')
  })

  it('应用更新在「更新」区，且仍受 desktop/tvMode 门控', () => {
    const b = blockOf('update')
    expect(b, '应用更新不在更新区').toContain('updFound')
    expect(b, '应用更新的平台门控丢了（Web 端会看到灰按钮）').toMatch(
      /v-if="desktop \|\| tvMode"/,
    )
  })
})
