import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 播放器事件上报（2026-11-23 用户点单）：
 * 缓冲空洞/卡死/token 过期落 JSONL，可按 kind/site 聚合；
 * 路由必须在 /api/state 保留前缀的 404 之前注册，否则会被当站点分派。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const API = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'),
  'utf8',
)
const STATE = readFileSync(
  join(REPO, 'server', 'host', 'src', 'shared', 'routes', 'StateRoutes.java'),
  'utf8',
)

describe('播放器诊断事件', () => {
  it('路由显式注册且排在 /api/state 保留前缀 404 之前', () => {
    const route = API.indexOf('"/api/state/player-events".equals(path)')
    // 用 404 文案定位：文件前面还有别处提到 /api/state 前缀，不能取第一个
    const reserved = API.indexOf('unknown state endpoint')
    expect(route).toBeGreaterThan(-1)
    expect(reserved).toBeGreaterThan(route)
  })

  it('JSONL 落盘 + 2MB 轮转 + 聚合查询', () => {
    expect(STATE).toContain('diag/player-events.jsonl')
    expect(STATE).toContain('EVENTS_MAX_BYTES')
    expect(STATE).toContain('sendPlayerEventStats')
    expect(STATE).toContain('byKind')
  })

  it('只收白名单字段，不允许整条 URL 落盘', () => {
    // 上报体里没有 url 字段（只允许 host）
    expect(STATE).not.toContain('optString("url"')
    expect(STATE).toContain('optString("host"')
  })
})
