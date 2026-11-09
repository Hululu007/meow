/**
 * 播放诊断：规则层。
 *
 * 设计见 docs/47 §二。三条原则：
 *   1. **零 LLM 依赖**：所有判断靠本地规则，断网也能跑，100ms 出结论。
 *      LLM 只在后面负责"把结论说成人话"与长尾追问（§2.2）。
 *   2. **判据按 hls.js 事件写**，不按 `video.error.code` —— 后者只有 4 个枚举，
 *      「源把视频换成占位图」和「编码不支持」都落在 MEDIA_ERR_SRC_NOT_SUPPORTED(4)，
 *      DOM 层面根本区分不开（实测，见 docs/47 §2.3）。
 *   3. **没命中就返回 cause: null**，绝不编一个 UNKNOWN。前者是"视频本来能播"，
 *      后者是"诊断出未知问题"，两者的上报价值完全不同。
 *
 * 这个模块只读三类证据，全部已在运行时采集：
 *   · `window.__playerDebug`（VideoPlayer 的 collectDebug）
 *   · `window.__meowDiag`（diagnostics.ts 的 errors / net / netFail）
 *   · `GET /api/logs`（后端环形缓冲）
 */

// ---------------------------------------------------------------- 类型契约
//
// 字段名与 docs/47 §2.6 的输出契约逐字对应，改一处要同时改文档。

export type Confidence = 'high' | 'medium' | 'low'
export type Severity = 'blocking' | 'degraded' | 'info'
export type EvidenceKind = 'hls' | 'player' | 'network' | 'backend' | 'style'

/** 建议动作。**必须是前端真能执行的**，未知值一律降级成 none（§2.8）。 */
export type SuggestAction =
  | 'switch_line'
  | 'switch_source'
  | 'retry'
  | 'refresh_danmaku'
  | 'open_logs'
  | 'transcode'
  | 'disable_source'
  | 'none'

export interface Evidence {
  kind: EvidenceKind
  detail: string
}

export interface Cause {
  code: string
  confidence: Confidence
  severity: Severity
}

export interface Suggestion {
  action: SuggestAction
  text: string
  /** switch_line 时是候选线路名；其它动作为空 */
  options?: string[]
  /** 需要用户确认的动作用 true（transcode / disable_source） */
  confirm?: boolean
}

export interface Diagnosis {
  ok: boolean
  cause: Cause | null
  evidence: Evidence[]
  suggestion: Suggestion
  /** LLM 生成的人话解释；未配置模型时为 null。前端不得因它为空而改变 UI */
  explanation: string | null
  /** ok=false 时给出原因 */
  error?: string
}

// ---------------------------------------------------------------- 证据采集

/** `__playerDebug` 的形状（只声明诊断用到的字段）。 */
interface PlayerDebug {
  readyState?: number
  currentTime?: number
  duration?: number
  paused?: boolean
  buffered?: number
  lastError?: string | null
  hls?: { level?: number; levels?: number; bandwidth?: number }
  play?: { line?: string; elapsedMs?: number; retries?: number }
  danmaku?: { count?: number }
  [k: string]: unknown
}

interface NetRecord {
  method: string
  url: string
  status: number | null
  ok: boolean
  ms: number
  error: string | null
}

export interface DiagSources {
  player?: PlayerDebug | null
  hlsError?: string | null
  netFail?: NetRecord[]
  errors?: Array<{ message: string; url?: string }>
  backendLogs?: Array<{ level: string; tag?: string; text: string }>
  route?: string
  /** 起播看门狗是否已到期（播放页在 20s 未起播时会置位） */
  watchdogFired?: boolean
  /** 样式探针结果：'' 表示正常，其它表示异常描述 */
  styleProbe?: string
  /** 当前线路与候选线路名 */
  line?: string
  lines?: string[]
  /** 站点是否已降级（源健康） */
  siteDegraded?: boolean
  /** play 返回的 parse 字段 */
  parse?: number | string
}

/** 从浏览器全局读取证据。任何一项缺失都不报错——诊断要能降级工作。 */
export function collectSources(extra: Partial<DiagSources> = {}): DiagSources {
  const w = window as unknown as Record<string, any>
  const dbg = (w.__playerDebug || null) as PlayerDebug | null
  const diag = w.__meowDiag || null
  return {
    player: dbg,
    hlsError: (dbg?.lastError as string | null) ?? null,
    netFail: diag?.netFail ? diag.netFail() : [],
    errors: diag?.errors ? diag.errors() : [],
    route: location.hash || '',
    ...extra,
  }
}

// ---------------------------------------------------------------- 规则表

/**
 * 一条规则。
 *
 * `match` 返回 true 表示命中；`detail` 用来拼证据文本（给人看，也给 LLM 看）。
 * 规则之间没有隐式优先级——全部命中后按 severity 排（blocking 在前）。
 */
interface Rule {
  code: string
  severity: Severity
  /** 该规则的置信度基线；多条同时命中会统一降一档 */
  confidence: Confidence
  match(s: DiagSources): boolean
  detail(s: DiagSources): string
  suggestion: (s: DiagSources) => Suggestion
}

/** 从 `fragLoadError (403)` 这类字符串里取状态码 */
function codeOf(hlsErr: string | null | undefined): number {
  if (!hlsErr) return 0
  const m = /\((\d{3})\)/.exec(hlsErr)
  return m ? Number(m[1]) : 0
}

function hasText(hlsErr: string | null | undefined, ...needles: string[]): boolean {
  if (!hlsErr) return false
  return needles.some((n) => hlsErr.includes(n))
}

/** 后端日志里是否有匹配项 */
function backendHas(s: DiagSources, re: RegExp): boolean {
  return (s.backendLogs || []).some((l) => re.test(l.text || ''))
}

function firstBackend(s: DiagSources, re: RegExp): string {
  const hit = (s.backendLogs || []).find((l) => re.test(l.text || ''))
  return hit ? hit.text : ''
}

/** 换线路的建议：把当前线路排除掉，剩下的作为选项 */
function lineSuggestion(s: DiagSources, text: string): Suggestion {
  const others = (s.lines || []).filter((l) => l !== s.line)
  return {
    action: others.length ? 'switch_line' : 'switch_source',
    text,
    ...(others.length ? { options: others.slice(0, 5) } : {}),
  }
}

const RULES: Rule[] = [
  {
    // 源把 HTML / 图片当 m3u8 返回：清单 HTTP 200，但解析失败。
    // 实测（AppRJ 302 到小红书 PNG）就属这类。
    code: 'SOURCE_PLACEHOLDER',
    severity: 'blocking',
    confidence: 'high',
    match: (s) =>
      hasText(s.hlsError, 'manifestParsingError', 'manifestIncompatibleCodecsError') &&
      codeOf(s.hlsError) === 200,
    detail: (s) => `${s.hlsError}：清单返回 200 但内容不是 m3u8`,
    suggestion: (s) =>
      lineSuggestion(s, '这个源把视频换成了占位内容（通常是 404 占位图或验证页），不是应用缺陷。建议换一条线路。'),
  },
  {
    // 401/403：多数是防盗链，需要补 Referer。
    code: 'SOURCE_403_REFERER',
    severity: 'blocking',
    confidence: 'high',
    match: (s) => {
      const c = codeOf(s.hlsError)
      return (c === 401 || c === 403) &&
        hasText(s.hlsError, 'manifestLoadError', 'fragLoadError', 'levelLoadError')
    },
    detail: (s) => `${s.hlsError}：源站拒绝访问，多为防盗链`,
    suggestion: (s) =>
      lineSuggestion(s, '源站返回 403（防盗链）。可以先点重试，仍失败就换线路。'),
  },
  {
    // 分片 404 且与清单同主机 → 后端相对路径改写出了问题。
    // 这条是**应用缺陷**，要用户报给我们（历史上踩过，见 m3u8-rewrite 那条记忆）。
    code: 'HLS_RELATIVE_404',
    severity: 'blocking',
    confidence: 'medium',
    match: (s) =>
      hasText(s.hlsError, 'fragLoadError') && codeOf(s.hlsError) === 404,
    detail: (s) => `${s.hlsError}：分片地址 404，可能是后端清单改写异常`,
    suggestion: () => ({
      action: 'open_logs',
      text: '分片请求 404。如果是自建源，可能是清单里的相对地址没被正确改写——点「查看日志」可看到具体 URL。',
    }),
  },
  {
    // 编码不支持：hls 没有网络错误，但 video.error.code = 4（MKV/HEVC 常见）
    code: 'CODEC_UNSUPPORTED',
    severity: 'blocking',
    confidence: 'medium',
    match: (s) =>
      hasText(s.hlsError, 'bufferAddCodecError', 'bufferAppendError') ||
      (!s.hlsError && s.player?.readyState === 0 && (s.player as any)?.mediaError === 4),
    detail: (s) =>
      s.hlsError
        ? `${s.hlsError}：浏览器不支持这个编码`
        : '视频元素报告 MEDIA_ERR_SRC_NOT_SUPPORTED，且无网络错误',
    suggestion: () => ({
      action: 'transcode',
      text: '当前浏览器解不了这个编码（多为 MKV / HEVC）。可以转码后再播——转码是分钟级任务，要等一会儿。',
      confirm: true,
    }),
  },
  {
    code: 'NETWORK_TIMEOUT',
    severity: 'blocking',
    confidence: 'high',
    match: (s) =>
      hasText(s.hlsError, 'manifestLoadTimeOut', 'fragLoadTimeOut', 'levelLoadTimeOut') ||
      (!!s.watchdogFired && (s.player?.readyState ?? 0) < 3),
    detail: (s) =>
      s.hlsError ? `${s.hlsError}：请求超时` : `起播看门狗到期，readyState=${s.player?.readyState ?? 0}`,
    suggestion: (s) => lineSuggestion(s, '这个源响应太慢，起播超时。换一条线路通常就好了。'),
  },
  {
    // play 返回 parse=1 说明地址需要第三方解析器。前端目前不读这个字段
    // （docs/26 §play 字段），所以表现是"地址坏了"。
    code: 'PARSE_REQUIRED',
    severity: 'blocking',
    confidence: 'high',
    match: (s) => String(s.parse ?? '') === '1',
    detail: (s) => `play 返回 parse=${s.parse}，需要第三方解析器`,
    suggestion: () => ({
      action: 'switch_source',
      text: '这个源返回的是需要二次解析的地址，当前客户端还没接入解析器。换一个源吧。',
    }),
  },
  {
    code: 'SOURCE_EMPTY_LIST',
    severity: 'blocking',
    confidence: 'medium',
    match: (s) => !!s.siteDegraded && (s.player?.readyState ?? 0) === 0,
    detail: () => '该源已被标记为降级（连续失败），且播放器未起播',
    suggestion: (s) => ({
      action: 'switch_source',
      text: '这个源近期多次失败，已经自动降级。换一个源试试。',
      ...(s.line ? {} : {}),
    }),
  },
  {
    code: 'DANMAKU_ONLY',
    severity: 'info',
    confidence: 'high',
    match: (s) =>
      (s.player?.readyState ?? 0) >= 3 && (s.player?.danmaku?.count ?? -1) === 0,
    detail: (s) => `视频正常（readyState=${s.player?.readyState}），但弹幕 0 条`,
    suggestion: () => ({
      action: 'refresh_danmaku',
      text: '视频本身没问题，只是这部片没取到弹幕。可以换个弹幕源再试试。',
    }),
  },
  {
    code: 'CORS_BLOCKED',
    severity: 'degraded',
    confidence: 'medium',
    match: (s) => backendHas(s, /blocked origin/i),
    detail: (s) => firstBackend(s, /blocked origin/i),
    suggestion: () => ({
      action: 'open_logs',
      text: '后端拦下了跨域请求。如果是自部署，检查 policy.json 的 corsOrigins。',
    }),
  },
  {
    code: 'WEBVIEW_TOO_OLD',
    severity: 'blocking',
    confidence: 'high',
    match: (s) => !!s.styleProbe,
    detail: (s) => `样式探针失败：${s.styleProbe}`,
    suggestion: () => ({
      action: 'open_logs',
      text: '这台设备的 WebView 内核过旧，页面样式没生效。需要更新系统的「Android System WebView」。',
    }),
  },
]

/** 严重度排序：blocking 最前，同档保持规则表顺序（表里的顺序就是优先级）。 */
const SEV_ORDER: Record<Severity, number> = { blocking: 0, degraded: 1, info: 2 }

/**
 * 跑一遍规则，产出诊断结论。
 *
 * 这是纯函数（除了读 sources 参数），不碰 DOM、不发请求，所以可以直接单测。
 */
export function diagnose(s: DiagSources): Diagnosis {
  const hits = RULES.filter((r) => {
    try {
      return r.match(s)
    } catch {
      // 单条规则抛错不能毁掉整个诊断
      return false
    }
  })

  const evidence: Evidence[] = []
  // 无论命中什么，都把"客观事实"附上：这些是 LLM 与用户都需要的上下文
  if (s.hlsError) evidence.push({ kind: 'hls', detail: s.hlsError })
  if (s.player) {
    const p = s.player
    evidence.push({
      kind: 'player',
      detail: `readyState=${p.readyState ?? '?'} currentTime=${p.currentTime ?? '?'} buffered=${p.buffered ?? '?'}`,
    })
  }
  if (s.watchdogFired) {
    evidence.push({ kind: 'player', detail: '20 秒起播看门狗到期' })
  }
  const failed = (s.netFail || []).slice(-5)
  for (const n of failed) {
    evidence.push({
      kind: 'network',
      detail: `${n.method} ${shortUrl(n.url)} → ${n.status ?? n.error ?? 'failed'}`,
    })
  }
  for (const line of (s.backendLogs || []).slice(-5)) {
    if (line.level === 'error' || line.level === 'warn') {
      evidence.push({ kind: 'backend', detail: `[${line.tag || line.level}] ${line.text}` })
    }
  }
  if (s.errors?.length) {
    evidence.push({ kind: 'style', detail: `JS 错误 ${s.errors.length} 条：${s.errors[0]?.message?.slice(0, 80)}` })
  }

  if (!hits.length) {
    return {
      ok: true,
      cause: null,
      evidence,
      suggestion: { action: 'none', text: '未发现已知故障特征' },
      explanation: null,
    }
  }

  hits.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
  const main = hits[0]

  // 多条同时命中说明判据不唯一，置信度降一档（可能还撞上更低的那条）
  const confidence: Confidence =
    hits.length > 1 ? (main.confidence === 'high' ? 'medium' : 'low') : main.confidence

  for (const h of hits) {
    // 命中项也进证据，但 kind 必须落在契约的 5 种里（§2.6）。
    // 规则命中本质是"对 hls/player 数据的解读"，归到 hls 最贴切。
    evidence.push({ kind: 'hls', detail: `命中规则 ${h.code}` })
  }

  return {
    ok: true,
    cause: { code: main.code, confidence, severity: main.severity },
    evidence,
    suggestion: main.suggestion(s),
    explanation: null,
  }
}

/** 证据里的 URL 只留 host+末段，避免把整条带 token 的地址塞进界面 */
function shortUrl(u: string): string {
  try {
    const x = new URL(u, 'http://x')
    const tail = x.pathname.split('/').filter(Boolean).pop() || ''
    return `${x.host}/${tail}`.slice(0, 90)
  } catch {
    return String(u).slice(0, 90)
  }
}

/** 已知 cause 的中文短名，给 UI 做标签用（不参与判断） */
export const CAUSE_LABEL: Record<string, string> = {
  SOURCE_PLACEHOLDER: '源返回占位内容',
  SOURCE_403_REFERER: '源站拒绝访问',
  HLS_RELATIVE_404: '分片地址 404',
  CODEC_UNSUPPORTED: '编码不支持',
  NETWORK_TIMEOUT: '网络超时',
  PARSE_REQUIRED: '需要解析器',
  SOURCE_EMPTY_LIST: '源已失效',
  DANMAKU_ONLY: '仅弹幕缺失',
  CORS_BLOCKED: '跨域被拦',
  WEBVIEW_TOO_OLD: 'WebView 过旧',
}
