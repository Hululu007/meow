/**
 * 多轮工具编排（docs/47 §4.6 + §4.7）。
 *
 * 五条硬约束，缺一条就会出"AI 卡死"或"AI 乱调"：
 *   1. 最大轮数 8          —— 防死循环，正常任务 2–4 轮
 *   2. 单轮超时 8s         —— 模型 + 工具合计
 *   3. 总超时 30s          —— 超过就给当前最好结论
 *   4. 历史保留最近 4 轮    —— 控制上下文增长
 *   5. 同工具同参数连续 2 次 → 判定死循环，立即终止
 *
 * 工具结果一律经 summarize.ts 摘要化再喂模型（原始搜索结果几十 KB，
 * 直接塞进去既费钱又抓不住重点）。
 *
 * ★ 状态只信工具返回（§4.9 纪律一）：模型说"已切换线路"不算数，
 *   前端展示的任何变化必须由工具执行结果驱动。
 */

import { chat, type ChatMessage } from './llm'
import { ORCH_SYSTEM_PROMPT } from './prompt'
import { summarizeForModel } from './summarize'
import {
  meowState,
  meowLogs,
  meowDiagnose,
  meowSearch,
  meowPlay,
  meowSources,
  meowLibrary,
  meowLive,
  meowDanmaku,
  meowCache,
  meowCacheStart,
} from './tools'

// ---------------------------------------------------------------- 约束常量

/** 最大轮数：模型调工具的轮次上限（不含最终回答那轮） */
export const MAX_ROUNDS = 8
/**
 * 模型单次调用超时。
 *
 * ★ 必须比工具超时更宽松：推理模型（deepseek r1 / v4 这类）在工具变多后
 *   首轮"看 9 个工具的 schema + 想该调哪个"很容易超过 8 秒。实测
 *   「有哪些台能看直播」直接报"分析超时"，而实际模型只是还在思考。
 *   原来的 8 秒是按纯对话写的，没有把 function-calling 的开销算进去。
 */
export const ROUND_TIMEOUT_MS = 25_000
/**
 * 模型请求本身的 abort 预算（必须**大于** ROUND_TIMEOUT_MS）。
 *
 * ★ 踩过（2026-11-02）：`callModel` 原来用偏好里的 `llmTimeoutMs` 做 abort，
 *   默认 **8000ms**，而这里写 25 秒——内层永远先掐断，25 秒等于没改。
 *   症状是面板反复"分析超时了"，而实测同一链路一轮只要 2–3 秒，
 *   只是推理模型偶尔慢一点就必然撞 8 秒。
 *
 *   让 abort 比竞速更宽松：正常由上面的 withTimeout 报"模型调用超时（25000ms）"，
 *   abort 只在 fetch 卡死时兜底，这样错误文案能指出是哪一层。
 */
export const MODEL_ABORT_MS = ROUND_TIMEOUT_MS + 3000

/**
 * 每一轮至少给这么多输出 token。
 *
 * ★ 踩过（2026-11-02）：偏好里 `llmMaxTokens` 默认 **300**（按"解释一句话"定的，
 *   而且设置页根本没有这个字段，用户改不了）。但编排的一轮要装下"看 11 个
 *   工具 schema + 读工具结果 + 想清楚 + 要么吐 tool_calls 要么吐一段回答"，
 *   推理模型经常把 300 全烧在思维链上 → `finish_reason=length`、正文与
 *   tool_calls 都为空 → 面板报"分析超时了（模型返回空内容）"。
 *
 *   1200 是经验值：够一次完整工具调用 + 两三句结论；上限仍由模型自己收敛。
 */
export const MIN_ROUND_TOKENS = 1200
/**
 * 总超时。
 *
 * ★ 必须大于「一次慢工具 + 一次模型往返 + 一次收尾」：
 *   搜索 25 秒 + 模型 25 秒 + 收尾 25 秒 ≈ 75 秒。给 90 秒。
 *
 *   实际不会跑满：正常任务 2-4 轮、每轮模型 2-5 秒。这个上限只为兜住
 *   "推理模型思考很久 + 两次慢工具"的最坏情况，而不是常规路径。
 *   用户能感知的是 UI 上的进度提示，不是这个总闸。
 */
export const TOTAL_TIMEOUT_MS = 90_000
/** 历史保留最近几轮 */
export const KEEP_ROUNDS = 4

/**
 * 工具的单次超时。
 *
 * `meow_search` 跨 28 个源并发，实测最慢一次 **20 秒**
 * （56 个源里 17 个降级，仍在跑的很多是慢源）。给它 30 秒：
 * 单站超时 8 秒（后端 `HEALTH_PROBE_TIMEOUT`）+ 并发排队与聚合，留 3 倍余量。
 *
 * 其余工具都是毫秒到几秒（`/api/live` 实测 30ms、`/api/health` 个位数毫秒），
 * 统一用这个上限没有副作用。
 */
export const TOOL_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------- 工具表

/**
 * 可编排的工具。
 *
 * 只放**读操作**。写操作（缓存开始/转码/停用源）不进编排：
 * §4.9 纪律二要求写操作必须人确认，而"确认"是 UI 的事，
 * 不能让模型自主决定（它会很乐意替用户点）。
 */
interface ToolSpec {
  desc: string
  /** 参数名与类型说明，用于生成 function schema */
  params: Record<string, { type: 'string' | 'number'; desc: string; required?: boolean }>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

const TOOLS: Record<string, ToolSpec> = {
  meow_state: {
    desc: '建立上下文：版本、站点数、降级源、日志概况（各级别条数、有哪些模块）。任何任务开始前先调它。要看具体日志正文再调 meow_logs。',
    params: {},
    run: () => meowState(),
  },
  meow_logs: {
    // ★ 触发条件写进 desc —— 模型唯一能看到的说明就是这段（同 meow_search）。
    //   "看多少条 / 什么级别"刻意不写死：日志规模随故障差异极大
    //   （正常时全是 info req，真出事时 warn/error 才有信息），
    //   硬编码采样规则等于替模型做它更该做的判断。
    desc:
      '查后端日志（2000 条环形缓冲）。' +
      '用户问「刚才报什么错」「为什么失败」「后端怎么了」，或 meow_diagnose 的证据不够、' +
      '需要按级别 / 模块 / 时间窗确认时用它。' +
      '**筛选条件由你决定**：拿不准就先不带条件取 50 条看全局（先看 level 分布，' +
      '再决定是否只看 warn 以上）；已知模块就用 meow_state 的 logTags 里的 tag 精确过滤。' +
      '返回 matched 与 scanned，命中很多时用 limit 取最新的那批，不要一次拉满。',
    params: {
      minLevel: { type: 'string', desc: '最低级别：info / warn / error，只看该级别及以上' },
      tag: { type: 'string', desc: '模块标签，精确匹配；可用值见 meow_state 的 logTags' },
      keyword: { type: 'string', desc: '关键词，匹配正文或标签，不区分大小写' },
      minutes: { type: 'number', desc: '只看最近多少分钟' },
      limit: { type: 'number', desc: '最多返回多少条（默认 50，上限 500），取最新的' },
    },
    run: (a) =>
      meowLogs({
        minLevel:
          a.minLevel === 'warn' || a.minLevel === 'error' || a.minLevel === 'info'
            ? a.minLevel
            : undefined,
        tag: a.tag ? String(a.tag) : undefined,
        keyword: a.keyword ? String(a.keyword) : undefined,
        minutes: typeof a.minutes === 'number' ? a.minutes : undefined,
        limit: typeof a.limit === 'number' ? a.limit : undefined,
      }),
  },
  meow_diagnose: {
    desc: '解释播放失败的原因（读取播放器状态、网络失败、后端日志）。用户问"为什么播不了/卡/黑屏/没画面"时用它。',
    params: {},
    run: () => meowDiagnose(),
  },
  meow_search: {
    // ★ 描述必须写清"什么时候**不**该用"。
    //   踩过：原描述只有"按片名搜索"，模型就把「那就放它吧」当关键词传进来，
    //   搜出无关片并当结果展示。ZCode 的技能也是靠描述里的触发条件被选中的，
    //   而模型看到的唯一说明就是这段 desc —— 它决定行为。
    desc:
      '按**片名**搜索影片。' +
      '仅在用户这句话里出现了新的片名（如「庆余年」「想找流浪地球」）时使用。' +
      '以下情况**不要**调用：用户说「那就放它吧/就这个/好/行」这类应答词（应直接用上一轮的 site+vod_id 调 meow_play）；' +
      '用户说「还有别的吗/换个源」（用上一轮结果，不要重搜）；' +
      '用户描述的是类型而非片名（如「下饭的喜剧」）。' +
      'keyword 只能填片名本身，绝不能把整句话或应答词填进去。',
    params: {
      keyword: { type: 'string', desc: '片名关键词，只填片名（如「庆余年」），不要填整句话', required: true },
    },
    run: (a) => meowSearch(String(a.keyword ?? '')),
  },
  meow_play: {
    // ★ 描述里强调"用上一轮的 id"：多轮里用户说"就播它"时，
    //   模型应该复用上文拿到的 site/vod_id，而不是重新搜一遍。
    desc:
      '取播放地址（内部自动换线路）。需要 site 与 vod_id。' +
      '如果上一轮 meow_search 已经拿到了 site 和 vod_id，直接用它，不要为了拿 id 重新搜索。' +
      '用户说「就播它/那就放它吧/好」时也用上一轮的 id 调它。',
    params: {
      site: { type: 'string', desc: '来源标识（来自 meow_search 的结果）', required: true },
      vod_id: { type: 'string', desc: '影片在该源的 id（来自 meow_search 的结果）', required: true },
      episode: { type: 'string', desc: '集数，如 "1"。不填取第一集' },
    },
    run: (a) =>
      meowPlay({
        site: String(a.site ?? ''),
        vod_id: String(a.vod_id ?? ''),
        episode: a.episode ? String(a.episode) : undefined,
      }),
  },
  meow_sources: {
    desc: '源健康清单（只看有问题的），返回哪些源降级/停用及失败原因。用户问"哪些源挂了/源还好吗"时用它。',
    params: {},
    run: () => meowSources(),
  },
  meow_library: {
    desc: '本地 / NAS 片库概览（有几个库、多少部片）。用户问"我本地有什么片"时用它；不涉及第三方源。',
    params: {},
    run: () => meowLibrary(),
  },
  meow_live: {
    desc: '直播频道概览。用户问"直播能看吗/有哪些台"时用它。返回里若 failed 等于 tried，说明上游当天全挂，不是应用问题。',
    params: {},
    run: () => meowLive(),
  },
  meow_danmaku: {
    desc: '查某部片的弹幕源。用户问"这部为什么没弹幕"时用它；视频能播但没弹幕是常见情况，与视频源无关。',
    params: {
      name: { type: 'string', desc: '片名（用于匹配弹幕源）' },
      episode: { type: 'string', desc: '集数，如 "1"' },
    },
    run: (a) =>
      meowDanmaku({
        name: a.name ? String(a.name) : undefined,
        episode: a.episode ? String(a.episode) : undefined,
      }),
  },
  meow_cache: {
    desc: '查本地缓存：已缓存哪几部片、各下到第几集、占多少空间、有没有在下载。用户问"我缓存了什么/那部下完没/占多大空间"时用它。这是查询，不会开始下载。',
    params: {},
    run: () => meowCache('list'),
  },
  meow_cache_start: {
    desc: '开始把一部片缓存到本地（断网也能看）。用户说"帮我缓存这部/下载下来/缓存第3集"时用它。必须先有 site 和 vod_id（来自 meow_search 的结果，不要自己编）。不传 episodes 就是整季。这一步会真的开始下载，调用前确认用户确实要下载。',
    params: {
      site: { type: 'string', desc: '源标识，来自搜索结果的 site 字段', required: true },
      vod_id: { type: 'string', desc: '影片 id，来自搜索结果的 vod_id 字段', required: true },
      episodes: { type: 'string', desc: '只缓存某几集时传，逗号分隔如 "3,4,5"；整季不传' },
      line: { type: 'string', desc: '线路名，不传用第一条能用的' },
    },
    run: (a) =>
      meowCacheStart({
        site: String(a.site ?? ''),
        vod_id: String(a.vod_id ?? ''),
        episodes: a.episodes
          ? String(a.episodes).split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        line: a.line ? String(a.line) : undefined,
      }),
  },
}

/** 生成 OpenAI function-calling 的 tools 定义 */
export function toolSchemas() {
  return Object.entries(TOOLS).map(([name, spec]) => ({
    type: 'function' as const,
    function: {
      name,
      description: spec.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(spec.params).map(([k, v]) => [
            k,
            { type: v.type, description: v.desc },
          ]),
        ),
        required: Object.entries(spec.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    },
  }))
}

// ---------------------------------------------------------------- 结果类型

export interface OrchestrateResult {
  ok: boolean
  /** 最终回答（模型给的那段话） */
  answer: string
  /** 这一轮实际发生的工具调用，按顺序（UI 用来显示过程、也用来校验状态） */
  calls: Array<{
    tool: string
    args: Record<string, unknown>
    ok: boolean
    summary: string
    /**
     * 工具的完整返回数据。
     *
     * <p>为什么要把整个 data 带出来：界面需要的不只是摘要——
     * `meow_cache_start` 的摘要是一句话，界面真正要的是它解析出的
     * 待确认计划（CachePlan：多少集、哪些直链），好在确认框里展示。
     * 只给 summary 的话，缓存功能在 UI 上等于没有消费方。
     */
    data?: unknown
  }>
  /** 停止原因：正常完成 / 轮数上限 / 超时 / 死循环 / 模型报错 */
  stopReason: 'done' | 'max_rounds' | 'timeout' | 'loop' | 'error'
  /** 累计 token（成本可见，§4.9 纪律四） */
  usage: { promptTokens: number; completionTokens: number }
  error?: string
}

// ---------------------------------------------------------------- 循环

/** 调用签名：同工具同参数判定死循环用 */
function sig(tool: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort()
  return `${tool}(${keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join(',')})`
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} 超时（${ms}ms）`)), ms),
    ),
  ])
}

/** 历史里的一条消息（只存最终问答，不存工具往返） */
export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 跑一次编排。
 *
 * @param userText 用户原话
 * @param opts.onProgress 过程回调（UI 显示"正在搜索…"这类提示）
 * @param opts.history 前几轮的问答（不含本轮）。调用方负责截断到偏好里配置的轮数
 */
export async function orchestrate(
  userText: string,
  opts: { onProgress?: (text: string) => void; history?: HistoryTurn[] } = {},
): Promise<OrchestrateResult> {
  const startedAt = Date.now()
  const calls: OrchestrateResult['calls'] = []
  const usage = { promptTokens: 0, completionTokens: 0 }

  // ★ 历史只放"用户问 + 最终回答"，**不放工具往返**：
  //   工具消息带着几十 KB 的搜索结果，塞进历史会让每轮 prompt 暴涨，
  //   而上一轮的结论（"第二季全36集，在 AppDrama2"）已经足够支撑追问。
  const messages: ChatMessage[] = [
    { role: 'system', content: ORCH_SYSTEM_PROMPT },
    ...(opts.history || []).map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ]

  // 死循环判定，两个维度：
  //   ① 同工具 + 同参数连续 2 次  → 模型在机械重复
  //   ② 同工具连续失败 2 次        → 换参数硬试也没用，得换方法
  // 踩过：只按①判会让"每次参数略有不同"的重试全部绕过——实测 meow_play
  // 连试 4 次（有时带 line 有时不带）签名都不同，一路试到轮数耗尽。
  let lastSig = ''
  let sameCount = 0
  let failTool = ''
  let failCount = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
      return { ok: true, answer: '', calls, stopReason: 'timeout', usage }
    }

    // ---- 调模型 ----
    let reply: { text: string; toolCalls: any[] }
    try {
      opts.onProgress?.(round === 0 ? '正在分析…' : '正在思考下一步…')
      reply = await withTimeout(
        chatWithTools(messages),
        ROUND_TIMEOUT_MS,
        '模型调用',
      )
    } catch (e) {
      // 429 / 超时 → 静默降级（返回已有结论，不报错给用户）
      return {
        ok: true,
        answer: '',
        calls,
        stopReason: 'timeout',
        usage,
        error: e instanceof Error ? e.message : String(e),
      }
    }

    // 模型没调工具 = 给出最终回答
    if (!reply.toolCalls.length) {
      return { ok: true, answer: reply.text, calls, stopReason: 'done', usage }
    }

    // ---- 执行工具（本轮所有调用串行，避免并发打后端）----
    for (const tc of reply.toolCalls) {
      const name = tc?.function?.name ?? ''
      let args: Record<string, unknown> = {}
      try {
        args = tc?.function?.arguments ? JSON.parse(tc.function.arguments) : {}
      } catch {
        args = {}
      }

      const spec = TOOLS[name]
      if (!spec) {
        // 模型返回不存在的工具名：回一条"没有这个工具"，让它自己纠正
        messages.push({
          role: 'assistant',
          content: '',
        } as ChatMessage)
        messages.push({
          role: 'user',
          content: `没有名为 ${name} 的工具。可用：${Object.keys(TOOLS).join('、')}。请重新选择。`,
        })
        continue
      }

      // 死循环判定：同工具同参数连续 2 次
      const s = sig(name, args)
      if (s === lastSig) {
        sameCount++
        if (sameCount >= 2) {
          return {
            ok: true,
            answer: '',
            calls,
            stopReason: 'loop',
            usage,
            error: `检测到重复调用：${s}`,
          }
        }
      } else {
        lastSig = s
        sameCount = 1
      }

      opts.onProgress?.(`正在执行 ${name}…`)
      let result: unknown
      let ok = false
      try {
        result = await withTimeout(spec.run(args), TOOL_TIMEOUT_MS, name)
        ok = (result as { ok?: boolean })?.ok !== false
      } catch (e) {
        // 工具自身失败：把错误摘要给模型，允许它换参数重试一次
        result = { ok: false, error: e instanceof Error ? e.message : String(e) }
        ok = false
      }
      const summary = summarizeForModel(name, result)
      calls.push({ tool: name, args, ok, summary, data: (result as { data?: unknown })?.data })

      // ② 同工具连续失败：第一次失败允许它调整参数再试，第二次就停。
      //    这比让模型自己意识到"这条路走不通"可靠得多。
      if (!ok) {
        if (name === failTool) {
          failCount++
        } else {
          failTool = name
          failCount = 1
        }
        if (failCount >= 2) {
          return {
            ok: true,
            answer: '',
            calls,
            stopReason: 'loop',
            usage,
            error: `工具 ${name} 连续失败 ${failCount} 次：${(result as { error?: string })?.error || summary}`,
          }
        }
      } else {
        failTool = ''
        failCount = 0
      }

      // ★ 工具结果作为 user 消息回灌，而不是 assistant：
      //   OpenAI 兼容端点在无 tool_call_id 时对 assistant 角色会当成
      //   "模型自己说的"，导致它以为事情已经做完了。
      messages.push({ role: 'user', content: `工具 ${name} 返回：\n${summary}` })
    }

    // 历史保留最近 KEEP_ROUNDS 轮。
    //
    // ★ 边界必须按"本轮新增消息"算，不能写死 slice(0, 2)：
    //   带上历史后第 0 条是 system、第 1..N 条是历史问答，
    //   写死 2 会把历史当成工具往返裁掉，等于上下文白传。
    const baseLen = 1 + (opts.history?.length || 0) + 1 // system + 历史 + 本轮 user
    if (messages.length > baseLen + KEEP_ROUNDS * 2) {
      const head = messages.slice(0, baseLen)
      const tail = messages.slice(-(KEEP_ROUNDS * 2))
      messages.length = 0
      messages.push(...head, ...tail)
    }
  }

  // 轮数用尽：让模型基于已有信息给个结论
  try {
    messages.push({
      role: 'user',
      content: '已达到调用上限。请基于已知信息直接给结论，不要再调用工具。',
    })
    const final = await withTimeout(chatWithTools(messages), ROUND_TIMEOUT_MS, '收尾')
    return { ok: true, answer: final.text, calls, stopReason: 'max_rounds', usage }
  } catch {
    return { ok: true, answer: '', calls, stopReason: 'max_rounds', usage }
  }
}

/**
 * 带 tools 的 chat 调用。
 *
 * 单独一个函数而不是改 llm.chat：那个是"纯对话"，被诊断解释复用；
 * 这里还要传 tools 并解析 tool_calls，两者的返回结构不同。
 */
async function chatWithTools(
  messages: ChatMessage[],
): Promise<{ text: string; toolCalls: any[] }> {
  const { chatWithTools: impl } = await import('./llm')
  return impl(messages, toolSchemas(), {
    timeoutMs: MODEL_ABORT_MS,
    minTokens: MIN_ROUND_TOKENS,
  })
}
