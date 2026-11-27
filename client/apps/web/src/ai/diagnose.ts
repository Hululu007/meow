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
export type EvidenceKind = 'hls' | 'player' | 'network' | 'backend' | 'style' | 'search'

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
  /**
   * 「我们这一跳」失败的原因（转码/代理）。播放页把 hopError 传进来。
   *
   * ★ 2026-11-27：不加这个字段时，「iOS 端没有 ffmpeg」只能从"看门狗到期"
   *   倒推成 NETWORK_TIMEOUT（置信度 high），把用户引向"换线路"——而片库
   *   场景没有线路可换，换一百次也一样。
   */
  hopError?: string | null
  /**
   * 最近一次聚合搜索的规模（2026-11-27）。
   *
   * <p>只在"刚搜过"时有（`window.__meowSearchStats`，10 分钟内有效）。
   * 用来区分「源全失败」与「确实没这部片」——两者对用户的建议完全相反。
   */
  search?: {
    wd: string
    groups: number
    hits: number
    total?: number
    returned?: number
    count?: number
  } | null
}

/** 从浏览器全局读取证据。任何一项缺失都不报错——诊断要能降级工作。 */
export function collectSources(extra: Partial<DiagSources> = {}): DiagSources {
  const w = window as unknown as Record<string, any>
  const dbg = (w.__playerDebug || null) as PlayerDebug | null
  const diag = w.__meowDiag || null
  /*
   * 最近一次聚合搜索的规模（meow_search 写入，10 分钟内有效）。
   * 过期的不带上：否则用户半小时后问"为什么播不了"，还会拿到一次旧搜索的结论。
   */
  const rawSearch = w.__meowSearchStats as
    | { wd?: string; groups?: number; hits?: number; total?: number; returned?: number; count?: number; at?: number }
    | undefined
  const search =
    rawSearch && Date.now() - Number(rawSearch.at || 0) < 10 * 60_000
      ? {
          wd: String(rawSearch.wd || ''),
          groups: Number(rawSearch.groups || 0),
          hits: Number(rawSearch.hits || 0),
          total: rawSearch.total,
          returned: rawSearch.returned,
          count: rawSearch.count,
        }
      : null
  return {
    player: dbg,
    hlsError: (dbg?.lastError as string | null) ?? null,
    netFail: diag?.netFail ? diag.netFail() : [],
    errors: diag?.errors ? diag.errors() : [],
    search,
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

/** 命中某个模式的后端日志条数（判"成批出现"用它，见 SOURCES_MOSTLY_BROKEN）。 */
function countBackend(s: DiagSources, re: RegExp): number {
  return (s.backendLogs || []).filter((l) => re.test(l.text || '')).length
}

/**
 * 本端没有转码能力（iOS / 没装 ffmpeg 的端）。
 *
 * <p>判据两条，任一条成立即可（2026-11-27 补第二来源）：
 *   · hopError：我们这一跳自己失败的原因，比从看门狗倒推可靠；
 *   · 后端日志里转码任务留下的 `[no_ffmpeg]`：有些路径（片库预判、repair）
 *     只走日志不走 hopError，只看前者会漏。
 * 关键词沿用后端 502 原文与前端守卫文案，改文案时两边一起改。
 */
function isTranscodeMissing(s: DiagSources): boolean {
  const h = s.hopError || ''
  if (/找不到\s*ffmpeg|ffmpeg\s*不可用|ffmpeg.{0,12}(未配置|没有)/i.test(h)) return true
  // 后端 noteFail 写的是 `[no_ffmpeg] 找不到 ffmpeg（policy/PATH/常见路径都没有）`
  return backendHas(s, /\[no_ffmpeg\]|找不到\s*ffmpeg|ffmpeg NOT found/i)
}

/**
 * 转码拉流失败（源站侧）：源超时 / 403 / 源文件坏。
 *
 * <p>这类失败**换线路有用、等没用**，但用户看到的是"转码失败"，
 * 直觉是"设备不行/再等等"。后端现在会把 code 写进日志（`[source_timeout]` 等），
 * 诊断据此给"换线路"而不是"换设备"。
 */
function isTranscodeSourceFail(s: DiagSources): boolean {
  return backendHas(s, /\[(source_timeout|source_http|bad_source|short_output)\]/)
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
    /*
     * 本端没有转码能力（iOS / 桌面 Safari / 未装插件的 PC）。
     *
     * ★ 2026-11-27 用户实报：片库的扩展名预判与直连失败兜底会直接去起转码，
     *   后端回 502「找不到 ffmpeg」；起播永远不成立 → 20 秒看门狗到期 →
     *   被判成 NETWORK_TIMEOUT（high），诊断卡建议"换一条线路"。片库根本没有
     *   线路可换，用户按建议点多少次都一样。
     *   排在 NETWORK_TIMEOUT 之前，并让后者与它**互斥**（否则两条同时命中会
     *   把置信度降档，而这里的事实是确定的）。
     */
    code: 'TRANSCODE_UNAVAILABLE',
    severity: 'blocking',
    confidence: 'high',
    match: isTranscodeMissing,
    detail: (s) => `本端没有转码能力：${(s.hopError || '').slice(0, 90)}`,
    suggestion: () => ({
      action: 'none',
      text: '这个格式需要转码，而当前设备没有转码能力（iOS 不能起子进程；PC 需装 ffmpeg 插件）。换 MP4/HLS 源，或用装了 ffmpeg 的端播放。',
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
    suggestion: (s) =>
      isTranscodeMissing(s)
        ? {
            // 没有 ffmpeg 时"转码"这个按钮点了必然失败，别再给（2026-11-27）
            action: 'none',
            text: '当前内核解不了这个编码，而本端没有转码能力。换 MP4/H.264 源，或用装了 ffmpeg 的端播放。',
          }
        : {
            action: 'transcode',
            text: '当前浏览器解不了这个编码（多为 MKV / HEVC）。可以转码后再播——转码是分钟级任务，要等一会儿。',
            confirm: true,
          },
  },
  {
    /*
     * 转码拉流失败（源站侧）。排在 NETWORK_TIMEOUT 之前：两者都会"起播超时"，
     * 但"后端 ffmpeg 拉不到流"和"你的网络慢"的处置完全不同（前者换线路，
     * 后者换网络/等一等）。
     */
    code: 'TRANSCODE_SOURCE_FAIL',
    severity: 'blocking',
    confidence: 'high',
    match: (s) => !isTranscodeMissing(s) && isTranscodeSourceFail(s),
    detail: (s) => {
      const t = firstBackend(s, /\[(source_timeout|source_http|bad_source|short_output)\]/)
      return `后端转码拉流失败：${t.slice(0, 110)}`
    },
    suggestion: (s) =>
      lineSuggestion(s, '转码时后端拉不到源站（超时/403/源不完整），换一条线路，不要反复重试同一条。'),
  },
  {
    code: 'NETWORK_TIMEOUT',
    severity: 'blocking',
    confidence: 'high',
    match: (s) =>
      !isTranscodeMissing(s) &&
      !isTranscodeSourceFail(s) &&
      (hasText(s.hlsError, 'manifestLoadTimeOut', 'fragLoadTimeOut', 'levelLoadTimeOut') ||
        (!!s.watchdogFired && (s.player?.readyState ?? 0) < 3)),
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
    /*
     * 聚合搜索一条都没搜到（2026-11-27，AI 面板"为什么什么都搜不到"）。
     *
     * 判据要有"参与源数"才成立：只有真的跑了源、且 0 条结果才算。
     * 光看"结果空"会把"关键词不对"也算进来，而这两种处置完全相反。
     */
    code: 'SEARCH_ALL_EMPTY',
    severity: 'degraded',
    confidence: 'medium',
    match: (s) => !!s.search && s.search.groups === 0 && (s.search.total ?? 0) > 0,
    detail: (s) => {
      const x = s.search!
      const ret = x.returned ?? 0
      const tot = x.total ?? 0
      return `搜索「${x.wd}」：参与 ${tot} 个源，返回 ${ret} 个，结果 0 条`
    },
    suggestion: (s) => {
      const x = s.search!
      const ret = x.returned ?? 0
      const tot = x.total ?? 0
      // 多数源没返回 → 是"源/运行时/网络"的问题；都返回了 → 是"片名"的问题
      const mostlyMissing = tot > 0 && ret < Math.max(1, Math.floor(tot * 0.5))
      return mostlyMissing
        ? {
            action: 'open_logs',
            text: `大部分源没返回（${ret}/${tot}）。先看日志里有没有"源不可用/超时"，再试「设置 → 运行时」重启脚本运行时，或更新源包。`,
          }
        : {
            action: 'none',
            text: '源都正常返回了，但没有这部片。换个片名（去掉副标题/季数）或换个关键词再搜。',
          }
    },
  },
  {
    /*
     * 多个源在本机跑不起来（2026-11-27）。
     *
     * 判据是后端日志里成批出现的"源不可用/实例化失败"——典型原因是
     * 源包与当前构建不匹配（dex2jar 的 VerifyError / 缺类）或脚本运行时没起来。
     * 少量出现是正常的（真有站点坏了），≥5 条才判"整体不可用"。
     */
    code: 'SOURCES_MOSTLY_BROKEN',
    severity: 'blocking',
    confidence: 'medium',
    match: (s) => countBackend(s, /源不可用|实例化失败|ClassNotFoundException|VerifyError/) >= 5,
    detail: (s) =>
      `${countBackend(s, /源不可用|实例化失败|ClassNotFoundException|VerifyError/)} 条"源不可用"记录：`
      + firstBackend(s, /源不可用|实例化失败|ClassNotFoundException|VerifyError/).slice(0, 90),
    suggestion: () => ({
      action: 'open_logs',
      text: '多个源在本机加载失败（多为源包与当前构建不匹配，或脚本运行时没起来）。到「设置 → 运行时」重启运行时，仍不行就换一份源包重新导入。',
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
  // 「我们这一跳」的原因单独留证：它是 TRANSCODE_UNAVAILABLE 的唯一判据，
  // 也是用户报 bug 时唯一能说明"不是网络问题"的一行
  if (s.hopError) {
    evidence.push({ kind: 'backend', detail: `本端失败原因：${s.hopError.slice(0, 120)}` })
  }
  if (s.search) {
    evidence.push({
      kind: 'search',
      detail:
        `搜索「${s.search.wd}」：命中 ${s.search.hits} 部 / ${s.search.groups} 组`
        + (s.search.total != null
          ? `，源返回 ${s.search.returned ?? '?'}/${s.search.total}`
          : ''),
    })
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
  TRANSCODE_UNAVAILABLE: '本端无法转码',
  PARSE_REQUIRED: '需要解析器',
  SOURCE_EMPTY_LIST: '源已失效',
  DANMAKU_ONLY: '仅弹幕缺失',
  CORS_BLOCKED: '跨域被拦',
  WEBVIEW_TOO_OLD: 'WebView 过旧',
}
