import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * TV 内置 dex jar 的形态检查（2026-11-09 改为纯壳语义）。
 *
 * 历史：1.0.0 / 1.0.5 / 1.0.7 的发布 APK 全都没有 assets/spider.jar，
 * 「本机执行」一加载就 ClassNotFoundException。当时的修法是入库 + 断言。
 *
 * 现在仓库是公开壳：jar 属于源包，**故意不入库**。所以判据变成：
 *   ① 有 jar 时必须校验形态 + 必须在 APK 里（私有全量构建）
 *   ② 没有 jar 也是合法产物（纯壳构建），构建链不能 throw
 */
const TV = join(__dirname, '..', '..', 'tv')
const ASSETS = join(TV, 'app', 'src', 'main', 'assets')
const JAR = join(ASSETS, 'spider.jar')
const GITIGNORE = readFileSync(join(ASSETS, '.gitignore'), 'utf8')
const BUILD = readFileSync(join(TV, 'build-apk.ps1'), 'utf8')
const CI = readFileSync(
  join(__dirname, '..', '..', '..', '..', '.github', 'workflows', '_tv.yml'),
  'utf8',
)

describe('内置 dex jar：有则校验，无则纯壳', () => {
  it('.gitignore 只对第三方二进制关门：spider.jar 不入库、danmu 载荷入库', () => {
    expect(GITIGNORE).not.toMatch(/^!spider\.jar\s*$/m)
    expect(GITIGNORE).not.toMatch(/^!spider-ext\.jar\s*$/m)
    // danmu 载荷是**日更的 JS wrapper 压缩包**（不是源包二进制），
    // _tv_plugins / build-runtime-module.ps1 都读它；2026-11-09 起按原仓库
    // 对齐入库（2b342ee），所以这里的断言方向反过来了。
    expect(GITIGNORE, 'danmu 载荷应放行（tv_plugins 构建要用）').toMatch(
      /^!node-payload-danmu\.zip\s*$/m,
    )
  })

  it('文件存在时必须是 dex 形态（体积量级检查）；不存在 = 纯壳', () => {
    if (!existsSync(JAR)) {
      expect(true).toBe(true)
      return
    }
    const sz = statSync(JAR).size
    expect(sz).toBeGreaterThan(500 * 1024)
  })
})

describe('构建链：有 jar 断言在包内，没有也不阻断', () => {
  it('本地 build-apk.ps1：区分全量与纯壳', () => {
    expect(BUILD).toContain('$hasBundledJar')
    expect(BUILD).toContain('classes.dex')
    expect(BUILD).toContain('纯壳构建')
    expect(BUILD).toContain('APK 自检失败')
  })

  it('CI _tv.yml：拆包记录形态，不因缺 jar 直接 fail', () => {
    expect(CI).toContain('assets/spider.jar')
    expect(CI).toContain('unzip -l "$APK"')
    expect(CI).toContain('纯壳 APK')
  })
})
