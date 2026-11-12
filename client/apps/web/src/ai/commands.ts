/**
 * 斜杠命令：用户主动调用已有工具链的入口。
 *
 * ## 为什么不是把 11 个 `meow_*` 工具名直接搬上来
 *
 * 工具名是**给模型看的实现语义**：
 *   · `meow_state` 是「建立上下文」，AI 的内部动作，用户手动调没有意义；
 *   · `meow_play` 要 `site + vod_id`，那串 id 用户手里根本没有（来自搜索结果）；
 *   · `meow_cache_start` 的 `_start` 是相对 `meow_cache` 的实现区分，不是用户语言。
 *
 * 所以这里只映射**用户意图成立**的五个动作，命令名用中文，参数是"片名 / 第N集"
 * 这种人类能打出来的东西。真正的执行仍在 `tools.ts` —— 这里只做数据与解析，
 * **不写第二套实现**（否则必然和工具/意图分类漂移）。
 *
 * ## 为什么不只是"好看"
 *
 * `AiPanel` 在没有配置模型时走不到编排，除了搜索之外的能力全部不可达
 * （`llmReady()` 为假只调 `meowSearch`）。命令层是唯一能让「没装模型的用户」
 * 用上诊断/日志的路径，而且确定性、零 token、<1s 出结果。
 */

export interface CommandSpec {
  /** 命令名（不含斜杠）。中文：用户想的是"搜索"不是 "search" */
  name: string
  /** 别名：英文与缩写，方便键盘输入 */
  aliases: string[]
  /** 参数提示；空串 = 无参数（选中即执行） */
  argHint: string
  /** 一句话说明：什么时候用它 */
  desc: string
  /** 示例，补全列表里第二行显示 */
  example: string
}

export const COMMANDS: CommandSpec[] = [
  {
    name: '搜索',
    aliases: ['s', 'search'],
    argHint: '片名',
    desc: '跨源搜片，不用模型也能用',
    example: '/搜索 庆余年',
  },
  {
    name: '播放',
    aliases: ['p', 'play'],
    argHint: '[片名] [第N集]',
    desc: '取可播地址；不填片名就用上一轮那部',
    example: '/播放 庆余年 第3集',
  },
  {
    name: '缓存',
    aliases: ['c', 'cache', '下载'],
    argHint: '[片名] [第N集]',
    desc: '解析直链后弹确认卡，点了才下载',
    example: '/缓存 庆余年',
  },
  {
    name: '诊断',
    aliases: ['d', 'diag'],
    argHint: '',
    desc: '为什么播不了：本地规则，100ms 出结论',
    example: '/诊断',
  },
  {
    name: '日志',
    aliases: ['l', 'log', 'logs'],
    argHint: '[info|warn|error] [关键词]',
    desc: '查后端日志，按级别与关键词收窄',
    example: '/日志 warn',
  },
]

/**
 * 工具名 → 中文动作（**唯一一份**人话命名）。
 *
 * 两处共用：
 *   · AI 编排的 `trace`（原来直接拼 `c.tool`，界面上显示 `meow_search → meow_play`）；
 *   · 命令执行回填的 trace。
 *
 * ★ 新增工具时必须同步这里，`ai-commands.test.ts` 有门禁（对比 `TOOL_DEFS`）。
 */
export const TOOL_LABEL: Record<string, string> = {
  meow_state: '建立上下文',
  meow_logs: '日志',
  meow_diagnose: '诊断',
  meow_search: '搜索',
  meow_play: '取播放地址',
  meow_sources: '源健康',
  meow_cache: '缓存',
  meow_cache_start: '缓存',
  meow_library: '片库',
  meow_danmaku: '弹幕',
  meow_live: '直播',
}

/** 工具名 → 中文；未知名字原样返回（不能显示空白） */
export function toolLabel(name: string): string {
  return TOOL_LABEL[name] || name
}

export interface ParsedCommand {
  spec: CommandSpec
  /** 参数原文（已 trim；无参数时为空串） */
  arg: string
}

/**
 * 全角归一。
 *
 * ★ 中文输入法下 `/` 极易打成 `／`（U+FF0F），句间空格是 `　`（U+3000）。
 *   不归一的话用户会觉得"我明明打了斜杠却没反应"，而且看不出差在哪。
 */
function normalize(raw: string): string {
  return raw.replace(/\uFF0F/g, '/').replace(/\u3000/g, ' ')
}

/** 命令名/别名统一小写比较（`/S` 与 `/s` 等价） */
function matchesToken(spec: CommandSpec, token: string): boolean {
  const t = token.toLowerCase()
  if (spec.name.toLowerCase() === t) return true
  return spec.aliases.some((a) => a.toLowerCase() === t)
}

/**
 * 解析一条命令。不是命令（不以 `/` 开头、命令名不认识、只有一个斜杠）返回 null，
 * 调用方据此回落原本的自然语言路径 —— 行为完全不变。
 */
export function parseCommand(raw: string): ParsedCommand | null {
  const text = normalize(raw).trim()
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  // 第一个空白之前是命令名，之后全是参数（片名可能含空格）
  const m = /^(\S*)\s*([\s\S]*)$/.exec(body)
  if (!m) return null
  const token = m[1]
  const arg = m[2].trim()
  if (!token) return null // 只有 "/" 不构成命令
  const spec = COMMANDS.find((c) => matchesToken(c, token))
  if (!spec) return null
  return { spec, arg }
}

/**
 * 补全候选。
 *
 * 两种情况下返回空：输入不以 `/` 开头；**已经开始填参数**（命令名后面有空白）。
 * 第二种是必需的 —— 用户打 `/搜索 庆余年` 时列表还挂在那里会挡住消息区，
 * 而且那时的上下键应该给输入法的候选词、不是走命令列表。
 */
export function matchCommands(raw: string): CommandSpec[] {
  const text = normalize(raw).trimStart()
  if (!text.startsWith('/')) return []
  const body = text.slice(1)
  if (/\s/.test(body)) return []
  const q = body.toLowerCase()
  if (!q) return COMMANDS
  return COMMANDS.filter(
    (c) => c.name.toLowerCase().startsWith(q) || c.aliases.some((a) => a.toLowerCase().startsWith(q)),
  )
}

/** 选中命令后填回输入框的文本：有参数的命令补一个空格，光标落在参数位 */
export function completeCommand(spec: CommandSpec): string {
  return spec.argHint ? `/${spec.name} ` : `/${spec.name}`
}

export interface LogsCommandArgs {
  minLevel?: 'info' | 'warn' | 'error'
  tag?: string
  keyword?: string
}

const LEVEL_ALIAS: Record<string, 'info' | 'warn' | 'error'> = {
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  err: 'error',
  信息: 'info',
  警告: 'warn',
  错误: 'error',
}

/**
 * `/日志` 的参数解析。
 *
 * 语义刻意做宽：**剩余词一律当关键词**（`meowLogs` 的 keyword 同时匹配正文与标签，
 * 比精确 tag 宽容得多）。用户不需要先知道模块叫什么 —— 猜 `播放` 能命中标签 `播放`，
 * 写 `req` 也能命中。真要精确匹配才用 `tag:` 前缀。
 *
 *   /日志                     → 无过滤，取最近 50 条
 *   /日志 warn                → 只看 warn 及以上
 *   /日志 error 播放           → error 及以上 + 关键词"播放"
 *   /日志 tag:req             → 标签精确等于 req
 */
export function parseLogsArg(arg: string): LogsCommandArgs {
  const out: LogsCommandArgs = {}
  const words: string[] = []
  for (const part of normalize(arg).split(/\s+/).filter(Boolean)) {
    const low = part.toLowerCase()
    const lv = LEVEL_ALIAS[low]
    if (lv && !out.minLevel) {
      out.minLevel = lv
      continue
    }
    if (low.startsWith('tag:')) {
      const tag = part.slice(4).trim()
      if (tag) out.tag = tag
      continue
    }
    words.push(part)
  }
  if (words.length) out.keyword = words.join(' ')
  return out
}
