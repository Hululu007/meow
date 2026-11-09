import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 多仓导入与配置回滚的门禁。
 *
 * 两件事必须同时成立（2026-10-30 用户要求"另起不要污染我们当前用的"）：
 *   1. 探测是**只读**的：看有哪些仓，不能把现有配置冲掉；
 *   2. 导入是覆盖式的，所以**每次导入前必须自动备份**，且能一键恢复。
 *
 * 任何一条丢了，用户挑错一个仓就等于丢掉几百个站，而且界面上无从补救。
 */
// tests/ 在 client/apps/web/tests，仓库根要上四层
const REPO = join(__dirname, '..', '..', '..', '..')
const API_JAVA = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
)
const SETTINGS = readFileSync(join(__dirname, '..', 'src', 'views', 'SettingsView.vue'), 'utf8')
const API_TS = readFileSync(join(__dirname, '..', 'src', 'api', 'index.ts'), 'utf8')

describe('多仓探测（只读）', () => {
  it('探测接口不写配置文件、不重建站点表', () => {
    const start = API_JAVA.indexOf('private static void handleConfigDepot')
    expect(start).toBeGreaterThan(-1)
    // 方法体到下一个方法注释为止
    const end = API_JAVA.indexOf('private static JSONObject probeOneRepo', start)
    const body = API_JAVA.slice(start, end)
    expect(body.length).toBeGreaterThan(200)
    // 这些都会改动本地配置/运行时状态，探测里一个都不能出现
    expect(body).not.toContain('DataPaths.write')
    expect(body).not.toContain('rebuildSites')
    expect(body).not.toContain('backupConfigBeforeImport')
  })

  it('探测结果带 inJar：判断"导入后真能用几站"', () => {
    // 只看可达性不够 —— 实测有的仓 298 站里只有 8 站的类在我们 jar 里
    expect(API_JAVA).toContain('o.put("inJar", inJar)')
  })
})

describe('导入前自动备份', () => {
  it('写配置之前一定先备份', () => {
    /*
     * 锚点必须落在 handleConfigImport 里：文件里有两处 synchronized(IMPORT_LOCK)
     * （另一处是 restoreConfigBackup），只搜第一个会命中错的。
     */
    const fn = API_JAVA.indexOf('private static void handleConfigImport')
    expect(fn).toBeGreaterThan(-1)
    const i = API_JAVA.indexOf('synchronized (IMPORT_LOCK) {', fn)
    expect(i).toBeGreaterThan(fn)
    const seg = API_JAVA.slice(i, i + 900)
    expect(seg).toContain('backupConfigBeforeImport()')
    // 备份必须在写盘之前
    expect(seg.indexOf('backupConfigBeforeImport()')).toBeLessThan(
      seg.indexOf('DataPaths.write("config.sites.json"'),
    )
  })

  it('全新安装（没有旧配置）时不产生空备份', () => {
    const i = API_JAVA.indexOf('private static void backupConfigBeforeImport')
    const seg = API_JAVA.slice(i, i + 700)
    // 没有旧文件就直接返回，否则「恢复」按钮会看起来可用、点了却清空一切
    expect(seg).toContain('!cur.isFile()')
    expect(seg).toContain('return')
  })

  it('恢复前先解析备份，坏文件不写回去', () => {
    const i = API_JAVA.indexOf('private static boolean restoreConfigBackup')
    const seg = API_JAVA.slice(i, i + 900)
    expect(seg).toContain('new JSONObject(txt)')
  })
})

describe('设置页多仓与恢复入口', () => {
  it('有「多仓探测」和「用这个」两个动作', () => {
    expect(SETTINGS).toContain('多仓探测')
    expect(SETTINGS).toContain('@click="importDepotEntry(e)"')
  })

  it('有备份时显示「恢复上一次配置」', () => {
    expect(SETTINGS).toContain('cfgBackup.exists')
    expect(SETTINGS).toContain('恢复上一次配置')
  })

  it('API 层有探测与恢复三个函数', () => {
    expect(API_TS).toContain('export async function probeConfigDepot')
    expect(API_TS).toContain('export async function restoreConfigBackup')
    expect(API_TS).toContain('export async function discardConfigBackup')
  })
})

describe('DoH 抓取的 TLS SNI', () => {
  it('连 IP 时保留域名的 SNI（否则 Cloudflare 前置直接拒握手）', () => {
    // 实测：只改 URL + 设 Host 头时，ClientHello 的 SNI 是 IP，
    // gh-proxy.com 回 handshake_failure，配置导入永远失败。
    expect(API_JAVA).toContain('class SniSocketFactory')
    expect(API_JAVA).toContain('setServerNames')
    expect(API_JAVA).toContain('c.setSSLSocketFactory(sniFactory)')
  })
})
