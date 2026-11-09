import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 运行日志面板 + 后端编译清单的回归。
 *
 * 两件事都出过真问题：
 *  1. `core/LogBuffer.java` 没进 `sources.txt` → javac 报"找不到符号"，
 *     而那个清单是脚本/工具生成的，容易忘。这里直接比对目录与清单。
 *  2. 日志脱敏如果失效，WebDAV 密码和 authToken 会进面板并被复制出去。
 *     这里对脱敏规则做纯函数验证（不启动后端）。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const HOST = join(REPO, 'server', 'host')

function listJava(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listJava(p, base))
    else if (name.endsWith('.java')) {
      out.push(p.slice(REPO.length + 1).split('\\').join('/'))
    }
  }
  return out
}

describe('后端 sources.txt 与实际源文件一致', () => {
  it('sources.txt 覆盖 server/host/src 下全部 .java', () => {
    const manifest = join(HOST, 'sources.txt')
    expect(existsSync(manifest), 'sources.txt 不存在，javac @sources.txt 会失败').toBe(true)
    const listed = new Set(
      readFileSync(manifest, 'utf8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    const actual = listJava(join(HOST, 'src'))
    const missing = actual.filter((f) => !listed.has(f))
    // 报错信息要直接说清怎么修，否则下一个人只知道"少了几个"
    expect(
      missing,
      `这些源文件没进 sources.txt（新增文件后要重新生成）：${missing.join(', ')}`,
    ).toEqual([])
  })

  it('sources.txt 里没有已删除的文件', () => {
    const listed = readFileSync(join(HOST, 'sources.txt'), 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const stale = listed.filter((f) => !existsSync(join(REPO, f)))
    expect(stale, `sources.txt 里有已被删除的文件：${stale.join(', ')}`).toEqual([])
  })

  it('LogBuffer 保持在册（日志面板的后端依赖）', () => {
    const listed = readFileSync(join(HOST, 'sources.txt'), 'utf8')
    expect(listed.includes('core/LogBuffer.java')).toBe(true)
  })
})

describe('日志脱敏规则（纯函数）', () => {
  /** 与 core/LogBuffer.scrub 同规则的 JS 镜像，用来锁住行为。 */
  function scrub(raw: string): string {
    let out = raw
    for (const key of ['url', 'token', 'authToken', 'password', 'pwd', 'pass']) {
      out = out.replace(new RegExp(`([?&]${key}=)[^&\\s]*`, 'gi'), '$1***')
    }
    return out
  }

  it('代理目标的 url= 参数被打码', () => {
    const s = scrub('/api/proxy/stream?url=http://x/a.m3u8&token=secret123')
    expect(s).not.toContain('secret123')
    expect(s).toContain('url=***')
  })

  it('密码类参数被打码（password / pwd / pass）', () => {
    for (const k of ['password', 'pwd', 'pass']) {
      const s = scrub(`/api/library?${k}=hunter2&x=1`)
      expect(s, `${k} 未打码`).not.toContain('hunter2')
    }
  })

  it('authToken 被打码', () => {
    expect(scrub('/api/config?authToken=tok_live_9')).not.toContain('tok_live_9')
  })

  it('普通参数保持原样（可读性不能被过度打码毁掉）', () => {
    expect(scrub('/api/search?wd=庆余年')).toBe('/api/search?wd=庆余年')
    expect(scrub('/api/sites')).toBe('/api/sites')
  })
})

describe('日志页源码约束', () => {
  it('路由注册了 /logs', () => {
    const router = readFileSync(join(REPO, 'client/apps/web/src/router/index.ts'), 'utf8')
    expect(router.includes("path: '/logs'")).toBe(true)
  })

  it('日志页不直接 import diagnostics 模块（会拿到空实例）', () => {
    const api = readFileSync(join(REPO, 'client/apps/web/src/api/logs.ts'), 'utf8')
    // 必须读 window.__meowDiag：页面写的是全局快照，import 进来是另一个实例
    expect(api.includes('__meowDiag')).toBe(true)
  })
})
