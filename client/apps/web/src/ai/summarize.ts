/**
 * 工具结果摘要化（docs/47 §4.6 那张表）。
 *
 * ★ 这是编排里最容易写崩的地方：跨 28 个源的原始搜索结果有几十 KB，
 * 直接塞进上下文既费钱又让模型抓不住重点。每个工具都要有自己的裁剪规则，
 * 通用截断只是兜底。
 *
 * 两条铁律：
 *   1. meow_play **不回完整地址**（几百字符的签名 URL，模型用不上，还容易复述出去）
 *   2. 超过 2KB 一律截断并标注，让模型知道信息不全
 */

/** 上限：超过就截断（字符数，非 token） */
export const MAX_RESULT_CHARS = 2048

interface SearchHitLike {
  name: string
  remarks?: string
  sources?: Array<{ site: string; vod_id: string }>
}

interface PlayOutLike {
  url: string
  line: string
  episode: string
  tried: string[]
}

/** 前 5 部 × 每部前 3 个源 */
export function summarizeSearch(data: SearchHitLike[] | undefined): unknown {
  const list = (data || []).slice(0, 5).map((h) => ({
    片名: h.name,
    备注: h.remarks || '',
    来源: (h.sources || []).slice(0, 3).map((s) => ({
      site: s.site,
      vod_id: s.vod_id,
    })),
    来源总数: h.sources?.length || 0,
  }))
  return { 结果数: (data || []).length, 前几部: list }
}

/**
 * 播放结果：只回"能不能播"和为什么，**不回完整地址**。
 *
 * 实测：完整 m3u8 地址带签名参数，长度常超 300 字符；模型会把它整段
 * 复述给用户（既没用又难看），而且偶尔会把签名泄漏到日志里。
 */
export function summarizePlay(data: PlayOutLike | undefined): unknown {
  if (!data) return { ok: false }
  return {
    ok: !!data.url,
    地址是http: /^https?:/i.test(data.url || ''),
    线路: data.line,
    集: data.episode,
    试过的线路: data.tried?.slice(0, 5) || [],
  }
}

interface StateLike {
  version: string
  sites: number
  ext?: number
  degraded: Array<{ site: string } | string>
  disabled: string[]
  logs?: Array<{ level: string; text: string }>
  logCounts?: Record<string, number>
  logTags?: string[]
  logHint?: string
}

/** 版本 + 站点计数 + 降级源名单（最多 10 个）+ 日志概况 */
export function summarizeState(data: StateLike | undefined): unknown {
  if (!data) return { 错误: '无状态' }
  const degraded = (data.degraded || [])
    .map((d) => (typeof d === 'string' ? d : d.site))
    .slice(0, 10)
  return {
    版本: data.version,
    源数: data.sites,
    ext数: data.ext ?? 0,
    降级源: degraded,
    降级总数: (data.degraded || []).length,
    已停用: (data.disabled || []).slice(0, 10),
    最近错误: (data.logs || [])
      .filter((l) => l.level === 'error' || l.level === 'warn')
      .slice(-3)
      .map((l) => l.text.slice(0, 100)),
    // ★ 概况而非日志正文：让模型先看到"哪个级别有多少条、有哪些模块"，
    //   再决定 meow_logs 怎么筛（行数/级别/模块由它判断，不在这里预设）。
    日志条数: data.logCounts || undefined,
    日志模块: (data.logTags || []).slice(0, 12),
    日志不可用: data.logHint || undefined,
  }
}

interface LogsLike {
  items: Array<{ at: number; level: string; tag: string; text: string }>
  matched: number
  scanned: number
}

/**
 * 日志：只给时间 + 级别 + 模块 + 正文前 160 字。
 *
 * 正文可能很长（异常栈），但模型需要的是"哪个模块、什么错误落在哪一层"，
 * 栈顶那几行足够；整段塞进去会把 matched/scanned 这些判断依据挤出预算。
 */
export function summarizeLogs(data: LogsLike | undefined): unknown {
  if (!data) return { 错误: '无日志' }
  const items = (data.items || []).map((e) => ({
    时间: new Date(e.at || 0).toISOString().slice(11, 23),
    级别: e.level,
    模块: e.tag,
    内容: (e.text || '').slice(0, 160),
  }))
  return {
    命中: data.matched,
    扫描: data.scanned,
    本批条数: items.length,
    日志: items,
  }
}

interface SourcesLike {
  total: number
  sites: Array<{ key: string; name: string; degraded: boolean; disabled: boolean }>
}

/** 只回有问题的源（健康的列出来毫无信息量） */
export function summarizeSources(data: SourcesLike | undefined): unknown {
  if (!data) return { 错误: '无源信息' }
  const bad = (data.sites || []).filter((s) => s.degraded || s.disabled)
  return {
    总数: data.total,
    有问题的源: bad.slice(0, 10).map((s) => ({
      名: s.name,
      状态: s.disabled ? '已停用' : '降级',
    })),
    问题总数: bad.length,
  }
}

interface DiagnosisLike {
  ok: boolean
  cause: { code: string; confidence: string; severity: string } | null
  suggestion: { action: string; text: string }
  evidence: Array<{ kind: string; detail: string }>
}

/** 诊断：结论 + 前 5 条证据（证据全文可能很长） */
export function summarizeDiagnosis(data: DiagnosisLike | undefined): unknown {
  if (!data) return { 错误: '无诊断结果' }
  return {
    原因: data.cause?.code ?? null,
    置信度: data.cause?.confidence ?? null,
    严重度: data.cause?.severity ?? null,
    建议: data.suggestion?.text,
    建议动作: data.suggestion?.action,
    证据: (data.evidence || []).slice(0, 5).map((e) => `[${e.kind}] ${e.detail.slice(0, 120)}`),
  }
}

/** 兜底：任意结果序列化并截断 */
export function clampResult(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (text.length <= MAX_RESULT_CHARS) return text
  return text.slice(0, MAX_RESULT_CHARS) + '…（已截断）'
}

/**
 * 按工具名分派摘要。未知工具走 clampResult。
 *
 * 用一张表而不是 if 链：加工具时只加一行，不会漏掉某个分支。
 */
const SUMMARY: Record<string, (data: unknown) => unknown> = {
  meow_search: (d) => summarizeSearch(d as SearchHitLike[]),
  meow_play: (d) => summarizePlay(d as PlayOutLike),
  meow_state: (d) => summarizeState(d as StateLike),
  meow_logs: (d) => summarizeLogs(d as LogsLike),
  meow_sources: (d) => summarizeSources(d as SourcesLike),
  meow_diagnose: (d) => summarizeDiagnosis(d as DiagnosisLike),
}

export function summarizeForModel(tool: string, result: unknown): string {
  // 工具自己报错时直接给错误文案，让模型知道失败了并能换参数
  const r = result as { ok?: boolean; error?: string; data?: unknown }
  if (r && r.ok === false) {
    return clampResult({ 失败: r.error || '未知错误' })
  }
  const fn = SUMMARY[tool]
  return clampResult(fn ? fn(r?.data) : r?.data ?? result)
}
