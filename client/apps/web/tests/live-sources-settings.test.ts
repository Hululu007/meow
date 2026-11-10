import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页「直播源」区块的可运维能力。
 *
 * 起因（2026-11-06 用户连问）：
 *   · 「过期后，我们能在设置页删除或更新吗」—— 当时只有删除，改名/换地址都要
 *     "先删再加"两步
 *   · 「这俩源如果更新了，怎么确定啊」—— 界面上完全看不到源的新鲜度，而
 *     内置的 Guovin 实际已经停更 25 天（Last-Modified 10-12），名字还叫
 *     "每日更新"
 *   · 「内置的能删除不用吗」—— 能删，但删错后没有恢复入口，只能手输 CDN 地址
 *
 * 这条门禁锁住四件事：编辑、测试（台数+新鲜度）、恢复内置源、后端透传 Last-Modified。
 * 只做字符串存在性检查，语义靠实机冒烟。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const API = join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'index.ts')
const SERVER = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')

describe('设置页直播源：编辑 / 测试 / 恢复内置', () => {
  const S = readFileSync(SETTINGS, 'utf8')
  const A = readFileSync(API, 'utf8')
  const J = readFileSync(SERVER, 'utf8')

  it('可以改名和换地址（换地址 = 先加新的再删旧的）', () => {
    expect(S, '缺少编辑入口').toContain('function startEditLive')
    expect(S, '缺少保存逻辑').toContain('function saveEditLive')
    // 先 POST 新地址、成功后才 DELETE 旧地址 —— 中间失败不能先丢旧源
    expect(S, '换地址没走"先加后删"').toMatch(
      /const changed = url !== oldUrl[\s\S]{0,600}if \(changed\) await removeLiveSource\(oldUrl\)/,
    )
    // 换地址要校验（改名不校验）
    expect(S, '换地址没做校验').toMatch(/addLiveSource\(\{[\s\S]{0,160}verify: changed/)
  })

  it('可以测试一条源：台数 + 更新于几天前（超 7 天提示停更）', () => {
    expect(S, '缺少测试入口').toContain('function testLive')
    expect(S, '测试没读 updated').toMatch(/r\.updated[\s\S]{0,260}days/)
    expect(S, '没有停更提示').toContain('已停更')
    // 不在打开页面时自动测（208KB 要 6 秒）
    expect(S, '测试按钮应手动触发').toMatch(/@click="testLive\(l\.url\)"/)
  })

  it('内置源删除后可一键恢复（不用手输 CDN 地址）', () => {
    expect(S, '缺少恢复函数').toContain('function doResetBuiltin')
    expect(S, '恢复按钮没按"有内置被删"显示').toContain('canResetBuiltin')
    expect(S, '恢复按钮没接处理函数').toMatch(/@click="doResetBuiltin"/)
    expect(A, '缺少 resetBuiltinLives API').toContain('resetBuiltinLives')
    // 后端分支：清掉 builtinLiveOff
    expect(J, '后端没有 resetBuiltin 分支').toContain('resetBuiltin')
    expect(J, '没有清 builtinLiveOff').toMatch(/saved\.remove\("builtinLiveOff"\)/)
  })

  it('后端透传 Last-Modified 给前端算新鲜度', () => {
    expect(J, '没读 Last-Modified').toMatch(/getHeaderField\("Last-Modified"\)/)
    expect(J, '响应里没带 updated').toMatch(/out\.put\("updated"/)
    expect(A, '前端类型缺 updated').toMatch(/updated\?: string/)
  })

  it('内置 iptv-org 用语言包 zho（一条顶 cn+hk+tw）', () => {
    expect(J, '内置源没换成语言包').toContain('languages/zho.m3u')
    // 注释里可以提到旧地址，真实配置行不能再用国家包
    expect(J, '还在用 countries/cn.m3u 当内置源').not.toMatch(/"https:\/\/iptv-org[^"]*countries\/cn\.m3u"/)
  })

  it('iptv-org 国家源可一键添加（国家码不好记，英国是 uk 不是 gb）', () => {
    expect(S, '缺少国家预设表').toContain('LIVE_COUNTRY_PRESETS')
    expect(S, '缺少快捷添加处理函数').toContain('function addCountryLive')
    // 英国是 uk：gb.m3u 实测 404
    expect(S, '英国码写错').toMatch(/code: 'uk'/)
    expect(S, '不该出现 gb 码').not.toMatch(/code: 'gb'/)
    // 和手输添加一样要先真拉一遍
    expect(S, '快捷添加没做校验').toMatch(/addCountryLive[\s\S]{0,700}verify: true/)
    // 已加过的置灰
    expect(S, '没做重复判断').toContain('hasCountryPreset')
  })

  it('加完一条源后，内置源不会从设置页消失（POST 也要回合并列表）', () => {
    // 后端：POST 的两个成功分支都必须回 livesWithBuiltin()。
    // 裸 `lives` 只是存储表，内置源平时不在表里 → 用户会以为内置源被覆盖了。
    expect(J, 'duplicate 分支回了裸表').toMatch(
      /put\("duplicate", true\)[\s\S]{0,120}livesWithBuiltin\(\)/,
    )
    expect(J, '新增分支回了裸表').toMatch(
      /JSONObject okOut = new JSONObject\(\)\.put\("ok", true\)\.put\("lives", livesWithBuiltin\(\)\)/,
    )
    // 前端：老后端仍可能回裸表，所以以 GET 为准再刷一次
    expect(S, 'doAddLive 加完没重读').toMatch(
      /async function doAddLive[\s\S]{0,1400}await refreshLives\(\)/,
    )
    expect(S, 'addCountryLive 加完没重读').toMatch(
      /async function addCountryLive[\s\S]{0,1400}await refreshLives\(\)/,
    )
  })

  it('「更多国家/地区」按需拉全量列表（8 个按钮不够用）', () => {
    expect(S, '缺展开开关').toContain('function toggleAllCountries')
    expect(S, '没拉 iptv-org 的国家清单').toContain(
      'iptv-org.github.io/api/countries.json',
    )
    // 该接口的 code 不是严格 ISO（英国是 UK，与 uk.m3u 一致），别拿 ISO 校正
    expect(S, '缺少中文名映射表').toContain('COUNTRY_ZH')
    expect(S, '中文名表缺英国').toContain("UK: '英国'")
  })
})
