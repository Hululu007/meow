import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 日志页的状态提示：必须区分「后端没有这个端点」与「后端连不上」。
 *
 * 真实事故：连 0.9.15 后端时 `/api/logs` 返回 404，而同一屏里
 * `/api/health`、`/api/sites` 全是 200——后端明明活着。
 * 页面却显示「后端不可达」，把排查方向引到网络/进程上，方向完全错了。
 */
const SRC = join(__dirname, '..', 'src')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

describe('日志接口的失败分类', () => {
  const api = read('api/logs.ts')

  it('定义了四种状态', () => {
    expect(api).toContain("export type LogsFetchState")
    for (const s of ['ok', 'unsupported', 'unreachable', 'error']) {
      expect(api, `缺少状态 ${s}`).toContain(`'${s}'`)
    }
  })

  it('404 判成 unsupported，不是 unreachable', () => {
    // 找 404 分支，确认它返回 unsupported
    const idx = api.indexOf('r.status === 404')
    expect(idx, '缺少 404 分支').toBeGreaterThan(0)
    const block = api.slice(idx, idx + 400)
    expect(block).toContain("'unsupported'")
    expect(block).not.toContain("'unreachable'")
  })

  it('只有 fetch 本身抛错才算 unreachable', () => {
    // catch 分支应返回 unreachable
    const idx = api.indexOf("return { state: 'unreachable'")
    expect(idx, '缺少 unreachable 返回').toBeGreaterThan(0)
    // 它必须出现在 fetch 的 try/catch 里（catch (e) 之后）
    const before = api.slice(0, idx)
    expect(before.lastIndexOf('} catch')).toBeGreaterThan(0)
  })

  it('不再用 throw 表达失败（否则调用方无法分类）', () => {
    expect(api).not.toContain('throw new Error(`HTTP ${r.status}`)')
  })
})

describe('日志页按状态给不同提示', () => {
  const view = read('views/LogsView.vue')

  it('unsupported 提示"版本较旧"，不是"连不上"', () => {
    expect(view).toContain('后端版本较旧')
    expect(view).toContain('后端连不上')
    // 两者必须是不同分支（v-if / v-else-if）
    const iUn = view.indexOf('后端版本较旧')
    const iUnreach = view.indexOf('后端连不上')
    expect(iUn).toBeGreaterThan(0)
    expect(iUnreach).toBeGreaterThan(iUn)
  })

  it('旧后端时停止轮询（不会每 3 秒打一次 404）', () => {
    expect(view).toContain("if (r.state === 'unsupported') live.value = false")
  })

  it('服务端统计只在 ok 时展示', () => {
    expect(view).toContain('serverState === \'unsupported\'')
    expect(view).toContain('旧版无日志端点')
  })
})
