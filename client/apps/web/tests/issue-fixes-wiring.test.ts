import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 本轮 issue 修复的"接线"门禁（2026-11-24）：
 * 单测锁行为，这个文件锁"代码真的接上了"——纯函数/桥/端点任何一环漏掉，
 * 线上表现就是"看起来改了但没生效"。
 *
 *   #12 / TV-1：TV nativeCaps 桥 → playRoute 自动原生（HEVC Main10 不转码）
 *   #15：离页/关 TV 主动撤转码（keepalive DELETE）
 *   #16：起播前预检 + 看门狗分档 + 线路成功率排序
 *   #1/#3：直播 video @error + readyState>=3 判据 + 频道级健康记忆
 */
const REPO = join(__dirname, '..', '..', '..', '..')

function read(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf8')
}

const PLAY = read('client', 'apps', 'web', 'src', 'views', 'PlayView.vue')
const LIVE = read('client', 'apps', 'web', 'src', 'views', 'LiveView.vue')
const ROUTE = read('client', 'apps', 'web', 'src', 'utils', 'playRoute.ts')
const BRIDGE = read('client', 'apps', 'web', 'src', 'api', 'nativeBridge.ts')
const LIB = read('client', 'apps', 'web', 'src', 'api', 'library.ts')
const API = read('client', 'apps', 'web', 'src', 'api', 'index.ts')
const VP = read('client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue')
const TV_BRIDGE = read('client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'TvBridge.java')
const MAIN = read('client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'MainActivity.java')
const SERVER = read('server', 'host', 'src', 'shared', 'ApiServer.java')

describe('#12 / TV-1：TV 原生能力表 → HEVC Main10 自动原生', () => {
  it('Java 桥用 MediaCodecList 实测，且按 profile 判 Main10（不是有 HEVC 就算）', () => {
    expect(TV_BRIDGE).toContain('public String nativeCaps()')
    expect(TV_BRIDGE).toContain('MediaCodecList.REGULAR_CODECS')
    expect(TV_BRIDGE).toContain('HEVCProfileMain10')
    // 能力表只能给可信页面（外部页面不该探测设备编解码器）
    const i = TV_BRIDGE.indexOf('public String nativeCaps()')
    expect(TV_BRIDGE.slice(i, i + 200)).toContain('trustedOrigin()')
  })

  it('Web 桥解析 JSON，老壳返回 probed=false（保持旧行为）', () => {
    expect(BRIDGE).toContain('nativeCaps?(): string')
    expect(BRIDGE).toContain('export function nativeCodecCaps')
    expect(BRIDGE).toContain('probed: false')
  })

  it('分配层：WebView 解不了、原生能解 → native（不是 native-hint/transcode）', () => {
    expect(ROUTE).toContain('export function nativeCanDecodeVideo')
    expect(ROUTE).toContain('nativeCanDecodeAudio')
    expect(ROUTE).toContain('if (!videoOk && nativeVideoOk && nativeAudioOk) return \'native\'')
    // 原生也解不了才转码
    expect(ROUTE).toContain("if (!nativeVideoOk || !nativeAudioOk) return canTranscode ? 'transcode' : 'native-hint'")
  })

  it('播放页把能力表接入路由输入', () => {
    expect(PLAY).toContain('nativeCodecCaps')
    expect(PLAY).toContain('nativeCaps: nativeCodecCaps()')
  })
})

describe('#15：离开播放页/关闭 TV 主动撤销转码', () => {
  it('前端记住"边转边看"的任务，离页用 keepalive DELETE', () => {
    expect(PLAY).toContain('let activeTranscode')
    expect(PLAY).toContain('function dropActiveTranscodeOnLeave')
    expect(PLAY).toContain('dropActiveTranscodeOnLeave()')
    expect(PLAY).toContain('__meowCancelTranscode')
    expect(LIB).toContain('export function cancelTranscodeOnLeave')
    expect(LIB).toContain('keepalive: true')
  })

  it('切集/换线/重试前先停旧任务（load 开头）', () => {
    const i = PLAY.indexOf('async function load()')
    expect(PLAY.slice(i, i + 400)).toContain('dropActiveTranscode()')
  })

  it('TV 壳关闭（isFinishing）时由原生层调页面入口', () => {
    expect(MAIN).toContain('window.__meowCancelTranscode')
    expect(MAIN).toContain('isFinishing()')
    expect(MAIN).toContain('protected void onStop()')
  })
})

describe('#16：线路预检 + 看门狗分档 + 成功率排序', () => {
  it('后端显式注册 /api/line/probe，2 秒 Range 探活', () => {
    expect(SERVER).toContain('"/api/line/probe"')
    expect(SERVER).toContain('private static void handleLineProbe')
    expect(SERVER).toContain('setConnectTimeout(2000)')
    expect(SERVER).toContain('setRequestProperty("Range", "bytes=0-1")')
    // 不跟 302：预检只判地址活着
    expect(SERVER).toContain('setInstanceFollowRedirects(false)')
  })

  it('前端预检只跳 dead，unknown（超时/老后端）继续播', () => {
    expect(API).toContain('export async function probeLine')
    expect(PLAY).toContain("if (pf === 'dead')")
    // parse=1 的线路不预检（地址不是最终流）
    expect(PLAY).toContain('!needsParse(r)')
  })

  it('看门狗预算由父组件传，默认仍是 20s/12s', () => {
    expect(VP).toContain('startupTimeoutMs?: number')
    expect(VP).toContain('stallTimeoutMs?: number')
    expect(VP).toContain('function startupBudgetMs')
    expect(VP).toContain('function stallBudgetMs')
    expect(VP).toContain("20_000")
    expect(VP).toContain("12_000")
    expect(PLAY).toContain(':startup-timeout-ms="lineWatch.startup"')
    expect(PLAY).toContain(':stall-timeout-ms="lineWatch.stall"')
  })

  it('线路表按成功率排序，成功/失败都落盘', () => {
    expect(PLAY).toContain('sortLinesByHealth')
    expect(PLAY).toContain('noteLineFail(site, name)')
    expect(PLAY).toContain('noteLineOk(site, flag.value)')
    expect(PLAY).toContain('lineBudget')
  })
})

describe('#13：drpy 站点不再被当苹果CMS', () => {
  it('http 脚本地址先排除，不落 CMS 分支', () => {
    expect(SERVER).toContain(
      'directApi != null && directApi.startsWith("http") && !isScriptApi(directApi)',
    )
  })
  it('isScriptApi 剥查询串（.js?v=3 也认）', () => {
    const i = SERVER.indexOf('private static boolean isScriptApi')
    const body = SERVER.slice(i, i + 520)
    expect(body).toContain("indexOf('?')")
    expect(body).toContain('.mjs')
  })
  it('ext 相对路径不再绑 .js（./json/xxx.json 也补全）', () => {
    expect(SERVER).toContain('if (e.startsWith("./") || e.startsWith("../")) {')
    expect(SERVER).not.toContain('(e.startsWith("./") || e.startsWith("../")) && e.endsWith(".js")')
  })
  it('导入判据用 isScriptApi，带查询串的脚本不会被丢掉', () => {
    const i = SERVER.indexOf('} else if (isScriptApi(api)')
    expect(i).toBeGreaterThan(-1)
  })
})

describe('#7：饭太硬图片包/多仓', () => {
  it('解析 `**` 图片包（JPEG 头 + base64 JSON）', () => {
    const i = SERVER.indexOf('private static JSONObject parseJsonLoose')
    const body = SERVER.slice(i, i + 900)
    expect(body).toContain('lastIndexOf("**")')
    expect(body).toContain('jsonOrBase64')
  })
  it('多仓 url 项兼容裸字符串', () => {
    expect(SERVER).toContain('private static String[] repoOf(JSONArray urls, int i)')
    expect(SERVER).toContain('urls.opt(i)')
    // 三处调用：探仓、导入、嵌套
    expect((SERVER.match(/repoOf\(/g) || []).length).toBeGreaterThanOrEqual(4)
  })
})

describe('#5：片库 SMB/WebDAV 目录浏览与失败归因', () => {
  it('后端可浏览未保存的候选片库，并把错误翻译成中文', () => {
    expect(read('server', 'host', 'src', 'shared', 'core', 'Library.java')).toContain(
      'public static JSONObject browse(JSONObject lib, String rel)',
    )
    expect(read('server', 'host', 'src', 'shared', 'core', 'Library.java')).toContain(
      'public static String explain(Throwable t)',
    )
    const routes = read('server', 'host', 'src', 'shared', 'routes', 'LibraryRoutes.java')
    expect(routes).toContain('"browse".equalsIgnoreCase')
    expect(routes).toContain('core.Library.explain(e)')
  })
  it('添加弹框能浏览 net 目录并把选择写回 root', () => {
    const dlg = read('client', 'apps', 'web', 'src', 'components', 'library', 'LibraryAddDialog.vue')
    expect(dlg).toContain('browseLibrary')
    expect(dlg).toContain('openNetPicker')
    expect(dlg).toContain("pickerMode.value === 'net'")
    expect(dlg).toContain('form.value.root = rel')
    expect(dlg).toContain('guide/library')
  })
})

describe('#6：片库 .strm 直链', () => {
  it('后端读 .strm / 解析首个 http(s) 行 / stream 302 到代理', () => {
    const lib = read('server', 'host', 'src', 'shared', 'core', 'Library.java')
    expect(lib).toContain('public static String resolveStrm')
    expect(lib).toContain('public static String readText')
    const routes = read('server', 'host', 'src', 'shared', 'routes', 'LibraryRoutes.java')
    expect(routes).toContain('"strm".equals(action)')
    expect(routes).toContain('endsWith(".strm")')
    expect(routes).toContain('/api/proxy/stream?url=')
  })
  it('前端 .strm 按在线播放走：代理 + 点播式转码，不交片库 probe', () => {
    expect(LIB).toContain('export function isStrmFile')
    expect(LIB).toContain('export async function resolveLibraryStrm')
    expect(PLAY).toContain('libraryStrmUrl')
    expect(PLAY).toContain('proxyStream(libraryStrmUrl.value)')
    expect(PLAY).toContain('isStrmFile(libraryFile.value)')
    // 直链过期要有专门文案（.strm 里通常是时效链接）
    expect(PLAY).toContain('直链打不开（.strm 里的地址多半已过期')
    const i = PLAY.indexOf('async function fetchProbeRoute')
    expect(PLAY.slice(i, i + 280)).toContain('libraryStrmUrl.value')
  })
})

describe('#1 / #3：直播黑屏兜底与频道级健康', () => {
  it('video 挂 @error（原生 HLS 失败不再静默转圈）', () => {
    expect(LIVE).toContain('@error="onVideoError"')
    expect(LIVE).toContain('function onVideoError')
  })

  it('坏台判据不再拿 readyState>=2 当成功', () => {
    expect(LIVE).toContain('v.readyState >= 3 || v.currentTime > 0')
    expect(LIVE).not.toContain('v.readyState >= 2 || v.currentTime > 0')
  })

  it('自动播放被拒也算坏台（缓冲看门狗不再 paused 直接 return）', () => {
    expect(LIVE).toContain('let autoPlayPending')
    expect(LIVE).toContain('autoPlayPending = true')
    expect(LIVE).toContain('if (!autoPlayPending) return')
    expect(LIVE).toContain('markBadAndAdvance')
  })

  it('频道级健康落盘：24h TTL、连续 2 次才灰显、坏台排后', () => {
    const store = read('client', 'apps', 'web', 'src', 'stores', 'liveHealth.ts')
    expect(store).toContain("'meow.live.health.v1'")
    expect(store).toContain('TTL_MS = 24 * 3600 * 1000')
    expect(store).toContain('BAD_FAILS = 2')
    expect(LIVE).toContain('isLiveBad(ch.name)')
    expect(LIVE).toContain('上次不可播')
    expect(LIVE).toContain('noteLiveOk')
  })
})
