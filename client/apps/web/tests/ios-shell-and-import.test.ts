/**
 * iOS 真机的修复（2026-11-24，两轮）—— 都是"typecheck 与运行期都发现不了"的契约：
 *
 *  1. 安全区：WebView **铺满全屏**，顶栏/底栏用 env() 让开刘海（不是黑边）；
 *  2. 输入框不缩放：iOS 壳锁 maximum-scale=1 + 输入控件 16px；
 *  3. 导入不再被客户端超时打断：确认导入走后台线程 + 轮询；
 *  4. 粘站点首页（`http://肥猫.net`）自动补 `/tv`；
 *  5. 导入后网关"像挂了"：站点类名查找要缓存（未命中会扫整个 jar）；
 *  6. iOS 后端地址只认注入的桥，别再退回同源静态服务（9979）。
 *
 * 这些失败形态都是"界面报错但后端日志干净"，没有异常可抓，只能锁源码。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const ROOT = join(WEB, '..', '..', '..')

/** 统一换行：工作区（autocrlf）里是 CRLF，直接 toContain('\n') 会假红 */
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const api = read(join(WEB, 'src', 'api', 'index.ts'))
const view = read(join(WEB, 'src', 'views', 'SettingsView.vue'))
const html = read(join(WEB, 'index.html'))
const tokens = read(join(WEB, 'src', 'styles', 'tokens.css'))
const host = read(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'))
const jars = read(join(ROOT, 'server', 'host', 'src', 'shared', 'core', 'Jars.java'))
const rootView = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'RootView.swift'))
const webViewSwift = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'WebView.swift'))
const bootstrapSwift = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'Bootstrap.swift'))
const player = read(join(WEB, 'src', 'components', 'player', 'VideoPlayer.vue'))
const appStore = read(join(WEB, 'src', 'stores', 'app.ts'))

describe('iOS：安全区与输入缩放', () => {
  it('WebView 铺满全屏，安全区交给 CSS env()（顶栏/底栏下移，不是黑边）', () => {
    expect(rootView).toContain('WebView(url: url')
    const web = rootView.slice(rootView.indexOf('WebView(url: url'))
    // 页面必须画到刘海底下：背景与顶部渐层铺满，内容靠 padding 让开
    expect(web.slice(0, 600)).toContain('.ignoresSafeArea()')
    expect(html).toContain('viewport-fit=cover')
    expect(tokens).toContain("html[data-shell='ios'] .app-header")
    expect(tokens).toContain('padding-top: env(safe-area-inset-top)')
    expect(tokens).toContain("html[data-shell='ios'] .has-tabbar")
  })

  it('iOS 壳锁住页面缩放，且输入控件抬到 16px', () => {
    // 首帧脚本按注入的 meowIos 桥认壳，不靠 UA
    expect(html).toContain("window.meowIos.platform === 'ios'")
    expect(html).toContain("root.setAttribute('data-shell', 'ios')")
    expect(html).toContain('maximum-scale=1')
    // 16px：WebKit 对 <16px 的输入框聚焦会整页放大
    expect(tokens).toContain("html[data-shell='ios'] input")
    expect(tokens).toContain("html[data-shell='ios'] textarea")
    expect(tokens).toContain('font-size: 16px')
  })
})

describe('导入：后台执行 + 轮询（客户端不再等长请求）', () => {
  it('后端把 background 请求转成后台任务，状态可轮询', () => {
    expect(host).toContain('startImportJob(body)')
    expect(host).toContain('importJobState')
    // 后台线程里必须清掉 background，否则会自己调自己（实测过）
    expect(host).toContain('jb.remove("background")')
    expect(host).toContain('core.MemoryExchange')
    // GET 同一路径回 state/pending
    expect(host).toContain('out.put("pending", "running".equals(importJobState))')
  })

  it('预览（dryRun）不下载/不转换 jar —— 它才是慢的那一段', () => {
    expect(host).toContain('"skipped", "dryRun"')
    expect(host).toContain('preview\n                ? new JSONObject().put("skipped", "dryRun")')
  })

  it('前端确认导入带 background，并轮询到结果再报成功', () => {
    expect(api).toContain('background: !!opts.background')
    expect(api).toContain('export async function getImportJobState')
    expect(view).toContain('background: true')
    expect(view).toContain('await waitImportJob()')
    expect(view).toContain('getImportJobState()')
    // 轮询提示要带秒数：用户得看到"在动"，否则 30 秒后就以为卡死
    expect(view).toContain('正在导入…已')
  })
})

describe('首页 ping：iOS 上不被「正在转换 jar」误报成断连', () => {
  it('iOS 壳与桌面端一样重试，间隔更长', () => {
    expect(appStore).toContain('isDesktop() || isIosShell() ? 4 : 1')
    expect(appStore).toContain("const gap = isIosShell() ? 1200 : 400")
  })
})

describe('导入：站点首页自动补 /tv', () => {
  it('HTML 且 URL 没有路径时补一次 /tv 再试', () => {
    expect(host).toContain('private static boolean looksLikeHtml')
    expect(host).toContain('private static String appendTvPath')
    expect(host).toContain('if (looksLikeHtml(raw))')
    expect(host).toContain('retry with " + alt')
  })
})

describe('导入后「像挂了」：类查找缓存 + base 只认桥', () => {  it('站点类名查找按 jar 代次缓存（未命中会扫整个 jar）', () => {
    expect(host).toContain('SPIDER_CLASS_MEMO')
    expect(host).toContain('core.Jars.generation()')
    expect(jars).toContain('public static int generation()')
    expect(jars).toContain('public static void invalidateClassCache()')
    // 站点表重建时也要失效（TV 不走 Jars.reload）
    expect(host).toContain('core.Jars.invalidateClassCache()')
    // 基线幽灵先判，别为它们白扫 jar
    expect(host).toContain('return siteImplemented(key)')
  })

  it('iOS 后端地址只认注入的桥；拿不到就报错，不退回同源 9979', () => {
    expect(api).toContain('iosShellInfo()?.apiBase')
    expect(api).toContain('(isDesktopShell() || isIosShell()) && !resolveBase()')
    expect(api).toContain('iOS 壳没有拿到后端地址')
  })

  it('网络级失败写进宿主日志（后端日志里这类失败一行都没有）', () => {
    expect(api).toContain('function webLog')
    expect(api).toContain('fetch ${method} ${base()}${path} failed after')
    expect(webViewSwift).toContain('name: "meowLog"')
    expect(webViewSwift).toContain('WKScriptMessageHandler')
  })
})

describe('开屏：品牌页盖住启动过程（不写工程化文案）', () => {
  it('开屏用品牌图标，进度不再往界面上写文字', () => {
    expect(rootView).toContain('Image("BrandLogo")')
    expect(rootView).toContain('0x0B / 255.0')
    // 「正在启动 Java 宿主」「等待 API 就绪」这类用户不该看到
    expect(bootstrapSwift).not.toContain('正在启动 Java 宿主')
    expect(bootstrapSwift).not.toContain('等待 API 就绪')
    // 只有真起不来才给一行原因 + 重试
    expect(rootView).toContain('boot.failed')
    expect(bootstrapSwift).toContain('func retry()')
  })
})

describe('宿主保活：进程活着就不许 VM 退（导入完成后网关消失的真因）', () => {
  it('非 daemon 守夜线程 + 看门狗自探活 + 重绑', () => {
    expect(host).toContain('meow-host-keeper')
    expect(host).toContain('keeper.setDaemon(false)')
    expect(host).toContain('meow-host-watchdog')
    expect(host).toContain('probeHealth(port)')
    expect(host).toContain('rebindListener')
    // 探活要走一条不刷访问日志的轻路径
    expect(host).toContain('/api/_hb')
  })

  it('导入阶段可见（下载并转换 / 写入）', () => {
    expect(host).toContain('importJobPhase = "写入配置"')
    expect(host).toContain('"phase", importJobPhase')
    expect(view).toContain('s.phase')
  })
})

describe('播放页全屏（iOS 只能伪全屏 + 原生转屏）', () => {
  it('iOS 不走 requestFullscreen，直接伪全屏并转横屏', () => {
    expect(player).toContain('if (isIosShell()) {')
    expect(player).toContain('ios.setOrientation(mode)')
    expect(bootstrapSwift).toContain('meowIos.setOrientation')
    expect(webViewSwift).toContain('ShellOrientation.apply')
  })
})
