import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「配置是权威」：有配置文件时，源码里那份 44 条静态基线里没进配置的
 * 默认站不能再下发。
 *
 * 2026-11-11 用户要求「把垃圾源剥离了，只留能用的 50 个」。
 * 实测踩到：`rebuildSites()` 每次都先 `SITES.clear + putAll(baseline)`
 * 再叠配置，于是「替换式导入」重启后基线站（荐片这类跑不起来、500）
 * 又冒回来，用户在界面上永远删不掉。
 *
 * 门禁：① 配置文件 key 被记录下来 ② /api/sites 与搜索/统计共用 siteVisible
 *      ③ 原生源（豆瓣）不受配置影响。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const J = readFileSync(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')

describe('配置权威：基线幽灵站不再下发', () => {
  it('记录配置里的站点 key（csp_ 与 js 两种分支）', () => {
    expect(J).toContain('CONFIG_SITE_KEYS')
    // 非 csp 分支
    expect(J).toMatch(/takenKey\.put\(useKey, api\);[\s\S]{0,120}CONFIG_SITE_KEYS\.add\(useKey\)/)
    // csp 分支
    expect(J).toMatch(/SITES\.put\(key, cleanSiteName[\s\S]{0,80}CONFIG_SITE_KEYS\.add\(key\)/)
  })

  it('可见性判据：配置非空时基线里没进配置的站被过滤', () => {
    expect(J).toMatch(/private static boolean siteVisible\(/)
    expect(J).toMatch(/CONFIG_SITE_KEYS\.contains\(key\)/)
    // 原生源永远可见
    expect(J).toMatch(/siteVisible[\s\S]{0,600}sources\.NativeSources\.get\(key\) != null\) return true/)
  })

  it('/api/sites、ext 统计、搜索都用同一个可见性判据', () => {
    expect(J).toMatch(/sitesJson[\s\S]{0,400}siteVisible\(e\.getKey\(\)\)/)
    expect(J).toMatch(/implementedExtCount[\s\S]{0,300}siteVisible\(key\)/)
    expect(J).toMatch(/implementedSiteKeys[\s\S]{0,300}siteVisible\(key\)/)
  })
})
