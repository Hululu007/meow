import { apiBase } from '@/api'

/**
 * 播放器诊断事件上报（缓冲空洞 / 卡死 / token 过期）。
 *
 * 后端落 JSONL 并可按 kind/site 聚合（`GET /api/state/player-events`），
 * 用来回答"哪个源、哪个时间点容易出洞"——只靠用户复现太慢。
 *
 * 约束：
 *   · 同一 (kind, site, vod) 30 秒内只发一条，密集跳洞不会刷爆；
 *   · 不传完整 URL（只传 host），token 不进日志；
 *   · 失败静默：诊断上报绝不影响播放。
 */
export type PlayerEventKind = 'buffer_hole' | 'buffer_stall' | 'token_stale'

export interface PlayerEvent {
  kind: PlayerEventKind
  site?: string
  vod?: string
  ep?: string
  /** 事件发生时的播放位置（秒） */
  pos?: number
  /** 空洞大小（秒），仅 buffer_hole */
  gap?: number
  /** 关联的 hls 最后错误文本（截断） */
  msg?: string
  /** 源站 host（不含路径/参数） */
  host?: string
  codec?: string
  pixfmt?: string
}

const lastSent = new Map<string, number>()
const THROTTLE_MS = 30_000

export function reportPlayerEvent(ev: PlayerEvent): void {
  try {
    if (!ev || !ev.kind) return
    const key = `${ev.kind}|${ev.site || ''}|${ev.vod || ''}`
    const now = Date.now()
    if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return
    lastSent.set(key, now)
    const body = JSON.stringify({ ...ev, ts: now })
    void fetch(`${apiBase()}/api/state/player-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => {
      /* 诊断上报失败静默 */
    })
  } catch {
    /* 序列化/网络异常都不允许影响播放 */
  }
}
