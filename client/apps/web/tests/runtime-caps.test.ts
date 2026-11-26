/**
 * 运行时能力协商（2026-11-26）：
 *
 * iOS 端内只有 drpy（Node 跑 .js），没有 Python。之前 .py 源会被投给 drpy，
 * 报成 JS 语法错误，完全看不出「这个运行时没有 Python」。
 *
 * 契约：
 *  - pyrt /health：py=true，js=是否配置了 PYRT_DRPY
 *  - drpy /health：js=true，py=false
 *  - 宿主调用前先判 caps：.py + 纯 JS 运行时 → 直接给准确原因
 *  - /api/health 暴露缓存状态（不主动发网络请求）
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const ROOT = join(WEB, '..', '..', '..')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const api = read(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'))
const pyrt = read(join(ROOT, 'server', 'pyrt', 'pyrt.py'))
const drpy = read(join(ROOT, 'server', 'drpy', 'server.js'))

describe('运行时 /health 带 caps', () => {
  it('pyrt 报告 py=true，js 取决于 PYRT_DRPY', () => {
    expect(pyrt).toContain('"py": True')
    expect(pyrt).toContain('"js": bool(os.environ.get("PYRT_DRPY"')
  })

  it('drpy 报告 py=false', () => {
    expect(drpy).toContain('py: false')
    expect(drpy).toContain('js: true')
  })
})

describe('宿主按能力给准确错误', () => {
  it('.py + 纯 JS 运行时直接返回原因，不投给 drpy', () => {
    expect(api).toContain('private static boolean isPyApi(String api)')
    expect(api).toContain('runtimeSupportsPy()')
    expect(api).toContain('jsRuntime 只支持 .js')
    expect(api).toContain('jsRuntimePy')
  })
})
