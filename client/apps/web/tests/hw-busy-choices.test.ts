import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 两台设备抢 4K（2026-11-23 用户点单）：
 * 后端已经只放行一路并回 hw_busy；前端不能直接丢错误页，
 * 要给「排队重试」和「换 1080p 线路」两个选择。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const P = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'),
  'utf8',
)

describe('hw_busy 选择浮层', () => {
  it('hw_busy 不落错误页，而是弹出选择条', () => {
    expect(P).toContain("if (r.code === 'hw_busy')")
    expect(P).toContain('busyHint.value = true')
    // 分支里必须先把 error/hopError 清掉再 return
    const i = P.indexOf("if (r.code === 'hw_busy')")
    const body = P.slice(i, i + 900)
    expect(body).toContain("error.value = ''")
    expect(body).toContain('return')
  })

  it('排队：每 15s 重试、最多 5 分钟，成功后清状态', () => {
    expect(P).toContain('BUSY_RETRY_MS = 15_000')
    expect(P).toContain('BUSY_MAX_RETRIES = 20')
    expect(P).toContain('function scheduleBusyRetry')
    expect(P).toContain('function startBusyQueue')
    expect(P).toContain('busyRetrying.value = false')
    // 排队中必须在浮层里可见，并给取消入口
    expect(P).toContain('排队中：另一台设备正在转 4K')
    expect(P).toContain('取消排队')
    // VOD 与片库两条转码路径都要接
    expect(P).toContain("busyKind = 'lib'")
  })

  it('降线路：只挑非 4K 线路，并保留当前集（走 switchLine）', () => {
    expect(P).toContain('function lowerLineName')
    expect(P).toMatch(/4k\|2160\|uhd\|原盘/)
    expect(P).toContain('switchLine(n)')
    expect(P).toContain('v-if="lowerLine"')
  })
})
