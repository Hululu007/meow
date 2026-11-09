/**
 * 模型调用与编排。
 *
 * 设计见 docs/47 §四。三条硬约束（缺一个就会出"AI 卡死"或"AI 乱调"）：
 *
 *   1. **只实现 OpenAI 兼容协议**。一套代码覆盖 OpenAI / DeepSeek / 通义 /
 *      月之暗面 / 智谱 / 本地 Ollama，换模型只改一个字符串（§4.4）。
 *   2. **出站走壳代理**，不是浏览器直连。OpenAI 这类厂商不返回 CORS 头，
 *      浏览器 fetch 必被挡（§4.2）。纯 Web 环境退回后端 `/api/llm/relay`。
 *   3. **失败一律降级，不阻塞诊断**。规则层已经给出结论时，模型挂了只是少了
 *      一句人话，不能因此让用户看不到诊断（§4.7）。
 */

import { getPrefs, setPref } from '@/stores/prefs'
import { apiBase, isDesktop } from '@/api'
import type { Diagnosis } from './diagnose'

// ---------------------------------------------------------------- 配置读取
//
// 字段平铺在 meow.prefs 里（与 meow.api 同层），不嵌套成 llm:{...}。
// ★ 判断"用户配过没"必须看密钥本身，不能看 llmEnabled 的合并值——
//   合并过 DEFAULTS 之后恒为 false，`=== undefined` 那类判断是死代码（踩过）。

export interface LlmConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
  maxTokens: number
  /** 对话保留几轮上文（0 = 不带历史） */
  historyRounds: number
}

const DEFAULT_BASE = 'https://api.deepseek.com/v1'

/**
 * 已实测可用的预设（设置页的"快速填入"用它，不是写死的下拉）。
 *
 * 为什么仍保留 `baseUrl` 可自填：模型迭代太快，写死的列表半年后全是过时的
 * （§4.5）。预设只是省去用户抄地址，不是限制。
 *
 * 每条都注明了实测结论，避免下一个人重复踩：
 * - `deepseek-v4.1-flash`（自建网关）：推理模型（reasoning_tokens 300-400），
 *   实测 2-3 秒出结果、质量好；max_tokens 必须给 3000，否则正文被截断。
 * - `deepseek-r1:14b`（本地 Ollama）：同样要 3000，实测 900 时 content 为空。
 */
export const LLM_PRESETS = [
  {
    id: 'wb-cn',
    label: '自建网关 · deepseek-v4.1-flash',
    baseUrl: 'http://127.0.0.1:8788/v1',
    model: 'deepseek-v4.1-flash',
    note: '实测 2-3 秒，中文自然；属于推理模型，已自动加大 token 预算',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '需自己的 key',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    note: '零成本离线；OLLAMA_ORIGINS 需放行跨域',
  },
] as const

export function llmConfig(): LlmConfig {
  // 平铺字段在 Prefs 上是可选的；这里用 any 取值避免为一个可选能力
  // 把主 Prefs 接口搞成必填（旧用户读出来就是 undefined）。
  const p = getPrefs() as unknown as Record<string, unknown>
  return {
    enabled: p.llmEnabled === true,
    baseUrl: String(p.llmBaseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    apiKey: String(p.llmApiKey || ''),
    model: String(p.llmModel || 'deepseek-chat'),
    timeoutMs: Number(p.llmTimeoutMs || 8000),
    maxTokens: Number(p.llmMaxTokens || 300),
    // 0 是合法值（不带历史），所以不能用 || 兜底
    historyRounds: p.llmHistoryRounds === undefined ? 5 : Number(p.llmHistoryRounds),
  }
}

/** 是否具备真正调用模型的条件（开关 + 地址 + 密钥） */
export function llmReady(): boolean {
  const c = llmConfig()
  return c.enabled && !!c.baseUrl && !!c.apiKey
}

export function saveLlmConfig(patch: Partial<LlmConfig>): void {
  if (patch.enabled !== undefined) setPref('llmEnabled', patch.enabled)
  if (patch.baseUrl !== undefined) setPref('llmBaseUrl', patch.baseUrl)
  if (patch.apiKey !== undefined) setPref('llmApiKey', patch.apiKey)
  if (patch.model !== undefined) setPref('llmModel', patch.model)
  if (patch.timeoutMs !== undefined) setPref('llmTimeoutMs', patch.timeoutMs)
  if (patch.maxTokens !== undefined) setPref('llmMaxTokens', patch.maxTokens)
  if (patch.historyRounds !== undefined) setPref('llmHistoryRounds', patch.historyRounds)
}

// ---------------------------------------------------------------- 出站

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 发一次 chat completion。
 *
 * 出站路径按环境分流（§4.2）：
 *   · PC（Tauri）→ 壳的 `llmChat` command，绕开 CORS
 *   · 其它（Web / TV）→ 走后端 `/api/llm/relay`（policy.json 里默认关闭）
 *
 * 两条路都不在浏览器里直连厂商域名 —— 那条路对 OpenAI 是必然失败的。
 */
export async function chat(
  messages: ChatMessage[],
  opts: { stream?: false } = {},
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const r = await callModel(messages, {})
  return r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error }
}

/**
 * 带 function-calling 的一轮调用（编排循环用）。
 *
 * 与 chat 分开而不是加参数：chat 是"纯对话"（诊断解释复用，不传 tools），
 * 这里要带 tools 并解析 tool_calls，返回结构不同。
 *
 * ★ `timeoutMs` 必须由编排层显式给（2026-11-02 实测踩过）：原来这里用
 *   `cfg.timeoutMs`（偏好默认 **8000**），而编排层的单轮预算写的是 25 秒——
 *   内层 abort 永远先触发，25 秒形同虚设。诊断里那些"分析超时"全是 8 秒掐断，
 *   模型其实还在正常思考（实测同一条链路 2–3 秒能回，长一点的回合就超）。
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: unknown[],
  opts: { timeoutMs?: number; minTokens?: number } = {},
): Promise<{ text: string; toolCalls: any[] }> {
  const r = await callModel(messages, {
    tools,
    timeoutMs: opts.timeoutMs,
    minTokens: opts.minTokens,
  })
  if (!r.ok) throw new Error(r.error)
  return { text: r.text, toolCalls: r.toolCalls }
}

interface CallResult {
  ok: boolean
  text: string
  toolCalls: any[]
  error: string
  /** ok = 有正文或工具调用；empty = 返回了但两样都没有 */
  reason?: 'ok' | 'empty'
  /** OpenAI 的 finish_reason：'length' 表示被 max_tokens 截断 */
  finishReason?: string
}

/**
 * 唯一的出站实现。
 *
 * 出站路径按环境分流（§4.2）：PC 走 Tauri 壳，其余走后端 relay。
 * 都不在浏览器里直连厂商域名 —— 那条路对 OpenAI 是必然失败的（无 CORS 头）。
 */
async function callModel(
  messages: ChatMessage[],
  extra: { tools?: unknown[]; timeoutMs?: number; minTokens?: number },
): Promise<CallResult> {
  const cfg = llmConfig()
  if (!cfg.enabled) return { ok: false, text: '', toolCalls: [], error: '模型未启用' }
  if (!cfg.apiKey) return { ok: false, text: '', toolCalls: [], error: '未配置 API Key' }
  /*
   * 本次请求的实际预算。
   *
   * 默认取偏好里的 llmTimeoutMs（单次解释用，8000ms 够）；
   * 编排层每一轮**显式**传更大的值——一轮里模型要看 11 个工具 schema、
   * 还要把工具结果（搜索/日志摘要）读进去，和"解释一句话"不是一个量级。
   */
  const budgetMs = Math.max(extra.timeoutMs ?? cfg.timeoutMs, 1000)

  /** 发一次完整请求。拆出来是为了 token 不够时能换预算重试。 */
  const attempt = async (maxTokens: number): Promise<CallResult> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      // 推理模型要给足预算，否则全烧在思维链上、正文为空（见 effectiveMaxTokens）
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    }
    if (extra.tools?.length) {
      body.tools = extra.tools
      // 让模型自己决定调不调工具；不强制（强制会导致它每次都硬调一遍）
      body.tool_choice = 'auto'
    }

    // PC：优先走 Tauri 壳。
    //
    // ★ 但壳可能没有这个 command。实测 0.9.21 的 Rust 侧**根本没有 llm_chat**
    //   （generate_handler! 里没有注册），而且 Cargo.toml 里也没有任何 HTTPS 客户端
    //   （只有 mcp.rs 那个手写的明文 http socket 工具）——所以即便注册了也调不通
    //   https 的厂商端点。因此这里**必须失败即回退到 relay**，否则 PC 上 AI 全不可用。
    //
    //   判断"没这个 command"而不是所有错误都回退：真正的业务错误（401/限流）
    //   回退也没用，还会让排查变模糊。
    const w = window as unknown as Record<string, any>
    if (isDesktop() && w.__TAURI__?.invoke) {
      try {
        const r = await Promise.race([
          w.__TAURI__.invoke('llm_chat', { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body }),
          timeoutReject(budgetMs),
        ])
        return parseReply(r)
      } catch (e) {
        const msg = errText(e)
        const missing = /command.*not found|not allowed|unknown command|llm_chat/i.test(msg)
        if (!missing) return { ok: false, text: '', toolCalls: [], error: msg }
        // 落到下面的 relay 分支
      }
    }

    // Web / TV：后端中转（只转发，不存 key、不参与编排）
    try {
      const r = await fetch(`${apiBase()}/api/llm/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, body }),
        signal: AbortSignal.timeout(budgetMs),
      })
      if (r.status === 404) {
        return {
          ok: false, text: '', toolCalls: [],
          error: '后端没有 /api/llm/relay（需要 0.9.18+ 或在 policy 里开启 llmRelay）',
        }
      }
      if (!r.ok) {
        // ★ 不能只看状态码：relay **被关闭** 时后端也返回 403
        //   （LlmRelay.java 的 "llmRelay disabled"），和"上游厂商 401/403"撞车。
        //   只看码会把它报成"密钥无效"，把人引去检查 key——实测踩过。
        //   所以先读 body 的 error 字段，能认出是哪种再给文案。
        let bodyErr = ''
        try {
          const j = await r.json()
          bodyErr = String(j?.error || j?.msg || '')
        } catch {
          /* body 不是 JSON：按状态码兜底 */
        }
        if (/relay disabled|llmRelay/i.test(bodyErr)) {
          return {
            ok: false, text: '', toolCalls: [],
            /*
             * 不再让用户去改 policy.json（2026-10-30）：设置页的「启用」开关
             * 现在会自动同步 llmRelay.enabled。还会走到这里，只可能是
             * "开关打开了但同步没成功"（后端不可达 / 老版本不认这个字段）。
             */
            error: '后端拒绝了模型转发。把设置页「AI → 启用」关掉再打开一次即可（它会顺带打开后端开关）；仍不行说明后端版本太旧，需要升级',
          }
        }
        if (/not allowed/i.test(bodyErr)) {
          return { ok: false, text: '', toolCalls: [], error: `后端拒绝了这个模型地址：${bodyErr}` }
        }
        const hint =
          r.status === 401 || r.status === 403
            ? `密钥无效或无权访问${bodyErr ? `（${bodyErr}）` : ''}`
            : `中转 HTTP ${r.status}${bodyErr ? `：${bodyErr}` : ''}`
        return { ok: false, text: '', toolCalls: [], error: hint }
      }
      return parseReply(await r.json())
    } catch (e) {
      return { ok: false, text: '', toolCalls: [], error: errText(e) }
    }
  }

  const baseTokens = Math.max(effectiveMaxTokens(cfg), extra.minTokens ?? 0)
  const first = await attempt(baseTokens)
  /*
   * ★ token 预算被思维链吃干 → 翻倍重试（2026-11-02 实测）。
   *
   * 偏好里 `llmMaxTokens` 默认 **300**，而推理模型（这里是自建网关的
   * deepseek-v4.1-flash，reasoning_tokens 一两百到上千不等）在"11 个工具
   * schema + 工具结果 + 10 轮历史"的上下文里，经常把 300 全烧在 CoT 上：
   * `finish_reason=length`、content 为空、也没有 tool_calls —— 面板报
   * "分析超时了（模型返回空内容）"，用户完全看不出是预算问题。
   *
   * 判据用 `finish_reason` 而不是模型名：名字不可靠（这个名字不含 r1/
   * reasoner，靠 REASONING_MODEL_RE 永远匹配不到），而 finish_reason
   * 是服务端给的事实。上限 8000，避免把费用打飞。
   */
  if (first.reason === 'empty' && first.finishReason === 'length') {
    const bigger = Math.min(Math.max(baseTokens * 4, 2000), 8000)
    if (bigger > baseTokens) return attempt(bigger)
  }
  return first
}

/** 解析 OpenAI 兼容响应：正文 + tool_calls */
function parseReply(r: any): CallResult {
  const choice = r?.choices?.[0]
  const msg = choice?.message
  const text = extractText(r)
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
  const finishReason = String(choice?.finish_reason || '')
  if (!text && !toolCalls.length) {
    return {
      ok: false, text: '', toolCalls: [],
      error: '模型返回空内容',
      reason: 'empty',
      finishReason,
    }
  }
  return { ok: true, text, toolCalls, error: '', reason: 'ok', finishReason }
}

function extractText(r: any): string {
  // OpenAI 兼容：choices[0].message.content
  const c = r?.choices?.[0]?.message?.content
  if (typeof c === 'string') return c.trim()
  // 有些兼容实现直接给 text
  if (typeof r?.text === 'string') return r.text.trim()
  return ''
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.name === 'AbortError' ? '模型请求超时' : e.message
  return String(e)
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
}

// ---------------------------------------------------------------- 系统提示词

/**
 * 系统提示词必须自带 domain（§4.8）。
 *
 * 通用模型不知道 "m3u8 相对路径改写"、"parse=1"、"SSRF 防线" 这些概念，
 * 不写进去它只会给"检查网络"这类废话。
 */
export const SYSTEM_PROMPT = `你是「猫窝 Meow」影视客户端的看片助理，现在在解释一次播放失败。它聚合第三方影视源，通过 HLS 播放。

## 你的任务
用户给出一段播放失败的诊断证据，你用 1–3 句中文说明**为什么**，以及**用户下一步该做什么**。
不要说"建议检查网络连接"这类废话——证据里已经说明是哪一层出的问题。

## 说话方式
直接、具体，像熟悉片子的朋友。有判断就给判断，别把结论推回给用户。
片源里查不到的信息（评分、上映日期）就说查不到，不要推荐外部网站。
不卖萌、不用表情、不自称"喵"。

## 领域知识（判断依据，不要向用户复述这些名词）
- 源站常把失效视频换成占位页/占位图：清单请求 HTTP 200，但内容不是 m3u8 → manifestParsingError
- 403/401 多为防盗链，需要 Referer；应用会自动补，补了仍失败就是源的问题
- 分片 404 且与清单同主机：可能是后端清单改写异常（这是应用缺陷，要报给我们）
- MKV/HEVC 在浏览器里解不了：hls 无网络错误但 video.error.code=4 → 需要转码
- parse=1：源返回的地址需要第三方解析器，当前客户端未接入
- readyState>=3 但弹幕 0 条：视频正常，只是弹幕源没取到

## 输出要求
- 只输出**一段连续的中文**，2–3 句。不要 JSON、不要 Markdown、不要编号、不要列点、不要加粗
- 第一句说原因，第二句说下一步做什么
- 证据不足以判断时，直说"证据不足"并指出还缺什么信息
- 不要提"模型"、"我"、"诊断流程"
- **不要推荐外部工具或网站**（不要提 HandBrake / CloudConvert / ffmpeg 命令）。
  客户端自己就能转码，用户只需要点一下
- 不要复述领域知识里的英文名词（manifestParsingError 之类），说人话

## 反例（这些都不合格）
- "建议检查网络连接" —— 证据已指明是哪一层，这句是废话
- "1. 确认视频格式 2. 转码视频..." —— 不允许列点
- "可以使用 HandBrake 转码" —— 客户端自带转码，别推外部工具`

/**
 * 推理模型（deepseek-r1 / qwen3-thinking 这类）的 token 预算。
 *
 * ★ 实测踩过：`deepseek-r1:14b` 在 max_tokens=300 时，**全部预算烧在思维链上**，
 *   `finish_reason=length` 而 `content` 是空字符串；调到 900 也一样。
 *   用户看到的是"AI 没反应"。这类模型需要 2000+ 才留得下正文。
 *
 * 判据放在模型名里而不是加一个配置项：用户填模型名时已经表达了意图，
 * 再让他多填一个"这是不是推理模型"只会填错。
 */
const REASONING_MODEL_RE = /(^|[/:-])(r1|qwq|reasoner|thinking|o1|o3)([-:]|$)/i

export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(model || '')
}

/** 实际发给模型的 max_tokens：推理模型给足预算，否则正文会是空的。 */
export function effectiveMaxTokens(cfg: LlmConfig): number {
  if (isReasoningModel(cfg.model)) return Math.max(cfg.maxTokens, 3000)
  return cfg.maxTokens
}

/** 把诊断结果压成给模型看的用户消息（只给结构化事实，不给结论，让模型自己归纳） */
export function buildUserMessage(d: Diagnosis, question?: string): string {
  const lines: string[] = []
  if (d.cause) {
    lines.push(`规则层判定：${d.cause.code}（置信度 ${d.cause.confidence}，严重度 ${d.cause.severity}）`)
  } else {
    lines.push('规则层判定：未命中已知故障特征')
  }
  if (d.evidence.length) {
    lines.push('证据：')
    for (const e of d.evidence.slice(0, 10)) lines.push(`- [${e.kind}] ${e.detail}`)
  }
  if (d.suggestion?.text) lines.push(`当前建议：${d.suggestion.text}`)
  if (question) lines.push(`\n用户原话：${question}`)
  return lines.join('\n')
}

/**
 * 给诊断补一句人话解释。
 *
 * ★ 失败时返回 null 而**不是抛错**：explanation 为空只表示少了一句解释，
 *   诊断结论（规则层）照常展示。用户不该看到"你没配模型所以只有半套功能"。
 */
export async function explainDiagnosis(
  d: Diagnosis,
  question?: string,
): Promise<string | null> {
  if (!llmReady()) return null
  const r = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserMessage(d, question) },
  ])
  return r.ok ? r.text : null
}

/**
 * 自由问答（悬浮面板里用户自己提问）。
 *
 * 与 explainDiagnosis 的区别：这里把工具清单也告诉模型，让它知道能查什么；
 * 但**不在这里做工具编排**——编排留到二期（§4.6 的五条硬约束还没实现）。
 */
export async function askWithContext(
  question: string,
  context: unknown,
): Promise<{ ok: boolean; text: string }> {
  const r = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `当前状态（JSON）：\n${JSON.stringify(context).slice(0, 3000)}\n\n用户问题：${question}`,
    },
  ])
  return r.ok ? { ok: true, text: r.text } : { ok: false, text: r.error }
}
