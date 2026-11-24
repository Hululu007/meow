/**
 * iOS 真机的四个修复（2026-11-24）—— 都是"typecheck 与运行期都发现不了"的契约：
 *
 *  1. 安全区：WebView 不再 ignoresSafeArea（刘海不遮顶栏）—— 锁 Swift 源码；
 *  2. 输入框不缩放：iOS 壳锁 maximum-scale=1 + 输入控件 16px；
 *  3. 导入不再被客户端超时打断：确认导入走后台线程 + 轮询；
 *  4. 粘站点首页（`http://肥猫.net`）自动补 `/tv`。
 *
 * 前三条的失败形态都是"界面报失败但后端其实在做"，没有异常可抓，只能锁源码。
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
const rootView = read(join(ROOT, 'client', 'apps', 'ios', 'Meow', 'RootView.swift'))
const appStore = read(join(WEB, 'src', 'stores', 'app.ts'))

describe('iOS：安全区与输入缩放', () => {
  it('WebView 不再 ignoresSafeArea（刘海/Home 条区域留给黑底）', () => {
    expect(rootView).toContain('WebView(url: url')
    // 唯一允许忽略安全区的是底层背景色
    expect(rootView).toContain('Color.black.ignoresSafeArea()')
    const web = rootView.slice(rootView.indexOf('WebView(url: url'))
    expect(web.slice(0, 420)).not.toContain('.ignoresSafeArea()')
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
