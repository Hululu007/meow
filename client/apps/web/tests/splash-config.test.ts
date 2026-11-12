/**
 * 品牌开屏门禁（2026-11-12）。
 *
 * 三处视觉必须一致，否则会出现「系统开屏一张脸 → 闪黑 → 应用」：
 *  ① Android 12+ 系统开屏：values-v31 的 Theme.MeowSplash；
 *  ② 所有版本的 SplashActivity（品牌图 + 应用名 + 正在启动）；
 *  ③ PC 的 sidecar 启动遮罩（图标 + 应用名 + 正在启动后端）。
 *
 * 注：曾试过"开屏与 WebView 同层、首屏数据就绪再撤"的预加载方案，评估后
 * 放弃——品牌窗口底色已经覆盖加载过程，预加载只省约 300ms，却要在关键
 * 启动路径上引入桥接信号/注入后 reload 的时序和兜底。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', '..')
const tv = (...p: string[]) => readFileSync(join(ROOT, 'client', 'apps', 'tv', ...p), 'utf8')
const web = (...p: string[]) => readFileSync(join(ROOT, 'client', 'apps', 'web', ...p), 'utf8')

describe('Android 开屏', () => {
  const manifest = tv('app', 'src', 'main', 'AndroidManifest.xml')

  it('桌面入口在 SplashActivity（LAUNCHER + LEANBACK），MainActivity 不再抢入口', () => {
    const splash = manifest.slice(manifest.indexOf('.SplashActivity'))
    const block = splash.slice(0, splash.indexOf('</activity>'))
    expect(block).toContain('android.intent.action.MAIN')
    expect(block).toContain('android.intent.category.LAUNCHER')
    expect(block).toContain('android.intent.category.LEANBACK_LAUNCHER')

    const main = manifest.slice(manifest.indexOf('.MainActivity'))
    const mainBlock = main.slice(0, main.indexOf('/>') + 2)
    expect(mainBlock).not.toContain('android.intent.action.MAIN')
    // 调试/安装器仍要能显式拉起
    expect(mainBlock).toContain('android:exported="true"')
  })

  it('主题：主界面与开屏用品牌底，播放/配置仍纯黑', () => {
    const themes = tv('app', 'src', 'main', 'res', 'values', 'themes.xml')
    expect(themes).toContain('name="Theme.MeowSplash"')
    expect(themes).toContain('name="Theme.MeowMain"')
    expect(themes).toContain('@drawable/splash_window_bg')
    // 其它 Activity 的主题不能带 logo，否则打开播放器会闪一下
    expect(manifest).toMatch(/\.MainActivity[\s\S]{0,400}android:theme="@style\/Theme\.MeowMain"/)
    expect(manifest).toMatch(/\.NativePlayerActivity[\s\S]{0,400}android:theme="@style\/Theme\.MeowTv"/)
  })

  it('Android 12+ 系统开屏：底色 + 图标 + 时长', () => {
    const v31 = tv('app', 'src', 'main', 'res', 'values-v31', 'themes.xml')
    expect(v31).toContain('android:windowSplashScreenBackground')
    expect(v31).toContain('android:windowSplashScreenAnimatedIcon')
    expect(v31).toContain('android:windowSplashScreenAnimationDuration')
    expect(v31).toContain('@color/brand_splash_bg')
  })

  it('SplashActivity 真的会跳到 MainActivity，且最短展示不是 0', () => {
    const act = tv('app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'SplashActivity.java')
    expect(act).toContain('new Intent(SplashActivity.this, MainActivity.class)')
    expect(act).toContain('MIN_SHOW_MS')
    expect(act).toContain('猫窝')
  })
})

describe('PC 启动遮罩', () => {
  const main = web('src', 'main.ts')

  it('遮罩有图标 + 应用名 + 状态行，状态回调写进状态行而不是整块替换', () => {
    expect(main).toContain('icon-192.png')
    expect(main).toContain("appName.textContent = '猫窝'")
    expect(main).toContain('正在启动后端…')
    expect(main).toContain('status.textContent = msg')
  })

  it('不引入开屏预加载桥（启动路径保持简单）', () => {
    expect(main).not.toContain('pageReady')
    expect(main).not.toContain('meow:home-ready')
  })
})
