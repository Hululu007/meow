/**
 * 意图分类与工具路由（docs/47 §2.1「规则先行」在这条链路上的完整落地）。
 *
 * ## 为什么要有这一层
 *
 * 原来只有 `parsePlayIntent`，只认「播放 X 第 Y 集」。其余全部丢给模型编排，
 * 结果出现两类明显错误（都实测踩过）：
 *
 *   1. **拿整句当关键词搜**：用户说「庆余年有第二季吗」，模型把整句传给
 *      meow_search，搜回一堆无关片。
 *   2. **拿应答词当关键词搜**：多轮里第二句是「那就放它吧」，不含任何片名，
 *      却照样进搜索，搜出「扶你青云反成仇，那就放你尘埃」这种片并当结果展示。
 *
 * 根因是**没有在发送前判定"这句话要干什么"**。这里补上：先分类，
 * 再决定调哪个工具、用什么参数。分类完大部分请求根本不需要模型。
 *
 * ## 和 ZCode 技能触发的对应关系
 *
 * ZCode：用户说"画图" → 命中 skill → 调对应的工具链。
 * 这里：用户说"为什么播不了" → kind=diagnose → 只调 meow_diagnose。
 * 区别只是我们的"技能"就是 9 个 meow_* 工具。
 *
 * ## 设计原则
 *
 * - **只在高置信度时分类**：拿不准就 `chat` 交给模型，宁可慢也不猜错
 * - **片名提取必须成功才走搜索类意图**：提取不到就是 chat/confirm
 * - **confirm 意图绝对不搜索**：它指向的是上一轮已确认的片
 */

import { episodeNumber } from './tools'

export type IntentKind =
  /** 明确的播放指令（片名 + 播放动词） */
  | 'play'
  /** 检索意图（片名 + 有没有/搜一下/怎么样） */
  | 'search'
  /** 纯应答，指向上一轮已确认的片 */
  | 'confirm'
  /** 指代上一轮结果的追问（还有别的吗 / 换个源）——不重新搜索 */
  | 'followup'
  /** 为什么播不了 / 卡 / 失败 */
  | 'diagnose'
  /** 源健康 */
  | 'sources'
  /** 直播 */
  | 'live'
  /** 弹幕 */
  | 'danmaku'
  /** 缓存 / 下载 */
  | 'cache'
  /** 本地片库 */
  | 'library'
  /** 其它：交给模型编排 */
  | 'chat'

export interface Intent {
  kind: IntentKind
  /** play/search 时是提取出的片名（**不是整句**） */
  title?: string
  /** play 时的集数 */
  episode?: string
}

// ---------------------------------------------------------------- 词表

/** 纯应答：不含任何片名，只是在回应上一轮 */
const CONFIRM_RE =
  /^(?:那就|就|那)?\s*(?:放|播|看|开始)?\s*(?:它|这个|那个|第一个|刚才那个|这部)?\s*(?:吧|了|呢|啊|呀)?\s*[。！?？!]*$/u

/** 单独的应答词（「好」「行」「可以」），和上面的"带动词短句"分开判 */
const CONFIRM_WORD_RE = /^(?:好|行|可以|嗯|对|是|要|继续|ok|OK)\s*[的吧了呢啊呀。！?？!]*$/u

/** 指代上一轮结果的追问：语义是"在刚才那批结果上继续"，不是新搜索 */
const FOLLOWUP_RE =
  /(还有别的|还有吗|还有呢|别的吗|其他的|换个源|换一个源|换个线路|换条线路|再换|下一个|其他源|别的源)/u

/** 播放动词（句首） */
const PLAY_VERB_RE = /^(?:帮我|给我|我要|我想|想|请|麻烦)?\s*(?:播放|放|看|打开)\s*/u

/** 检索动词（句首，可选） */
const SEARCH_VERB_RE = /^(?:帮我|给我|我想|请|麻烦)?\s*(?:搜一下|搜搜|找一下|找找|搜索|查找|找)\s*/u

/** 各类意图的关键词（不含片名的独立信号） */
const SIGNALS: Array<{ kind: IntentKind; re: RegExp }> = [
  // 诊断：优先级最高——"为什么播不了"里不该被当成片名去搜
  { kind: 'diagnose', re: /(为什么|为啥|怎么).{0,6}(播不了|放不了|打不开|卡|失败|黑屏|转圈|没声音|没画面|加载不)/u },
  { kind: 'diagnose', re: /(播不了|放不了|打不开|黑屏|起播失败|加载失败)/u },
  { kind: 'sources', re: /(哪些|哪个|多少).{0,4}源.{0,4}(挂|失效|降级|坏|不可用)|源.{0,3}(健康|状态|列表)/u },
  { kind: 'live', re: /直播|频道|电视台/u },
  { kind: 'danmaku', re: /弹幕/u },
  { kind: 'cache', re: /缓存|下载|离线/u },
  { kind: 'library', re: /片库|本地库|NAS|网盘/u },
]

/**
 * 句尾的"非片名"部分，剥掉后剩下的才是片名。
 *
 * ★ 顺序敏感：「有第二季」必须在「第二季」之前；
 *   而且只匹配**句尾**，所以片名本身含"第二季"（「庆余年第二季」）不受影响——
 *   它后面没有"吗/有"这类词。
 */
const SUFFIX_NOISE: RegExp[] = [
  // 庆余年有第二季吗 / 有没有第二季
  /有(?:没有)?\s*第?\s*[0-9一二三四五六七八九十]+\s*季\s*[吗呢吧啊了？?。！!]*$/u,
  /有没有\s*[吗呢吧啊了？?。！!]*$/u,
  // 好看吗 / 怎么样 / 如何 / 值得看吗
  /(?:好看|怎么样|如何|值得看|值得一看|口碑|评分)\s*[吗呢吧啊了？?。！!]*$/u,
  // 讲什么 / 是什么 / 谁演的 / 多少集 / 更新到哪 / 完结了吗
  /(?:讲什么|讲啥|是什么|谁演的|主演|多少集|几集|更新到.{0,4}|完结了?吗|结局)\s*[吗呢吧啊了？?。！!]*$/u,
  // 尾部纯语气词（只在前面已剥离过内容时才用）
  /[吗呢吧啊呀？?。！!]+$/u,
]

/**
 * 泛化检索需求：描述类型/风格而不是指名某部片。
 *
 * ★ 源站是**关键词搜索**不是语义检索，「下饭的喜剧」翻了也搜不到；
 *   剥出来的"个下饭的喜剧"更是纯噪声。这类请求交给模型，由它
 *   向用户要一个具体片名（见 prompt.ts 的"判断不了就先问"）。
 */
const VAGUE_RE = /(下饭|随便|推荐|好看的|好看的片|喜剧片|恐怖片|爱情片|动作片|科幻片|新片|热门|高分|有什么好)/u

/** 集数模式 */
const EP_PATTERNS: RegExp[] = [
  /第\s*([0-9]{1,4}|[一二三四五六七八九十]+)\s*[集话期回]/u,
  /\b[Ee][Pp]?\s*([0-9]{1,4})\b/u,
  /([0-9]{1,4})\s*[集话期回]/u,
]

/**
 * 剥完片名后不该残留的虚词/应答残片。
 *
 * ★ 这是 extractTitle 的"防误判闸门"：命中说明这句话不是"在说某部片"，
 *   而是应答/疑问/泛指。实测漏了这道闸门时，「那就放它」「能看」「里有啥」
 *   都会被当成片名去搜索，返回一堆无关片。
 */
const RESIDUE_RE =
  /(那就|就|放它|放这|放那|它吧|这个|那个|别的|换个|换一|还有|能看|看吗|可以吗|有没有|是什么|里有|有几|多少|啥|什么|怎么|为什么|哪些|哪个|试试|一下)/u

// ---------------------------------------------------------------- 片名提取

/**
 * 从一句话里剥出片名。
 *
 * ★ **刻意保守**：提取不出就返回 null。宁可让模型处理，也不要把
 *   「那就放它」「能看」「里有啥」这种残句当片名去搜索——实测这类
 *   误判会返回一堆无关片，比慢几秒糟糕得多。
 *
 * 判据（必须同时满足）：
 *   1. 必须带播放/检索动词，或者整句本身就是一个干净的名词短语
 *   2. 剥完剩下的长度 ≥ 2 个"实字"（汉字/字母/数字）
 *   3. 剩下的部分不能是常见应答词/疑问词残片
 */
export function extractTitle(raw: string): { title: string; episode?: string } | null {
  let rest = raw.trim()
  if (!rest) return null

  const hadVerb = PLAY_VERB_RE.test(rest) || SEARCH_VERB_RE.test(rest)
  // 1. 前缀动词
  rest = rest.replace(PLAY_VERB_RE, '').replace(SEARCH_VERB_RE, '').trim()
  if (!rest) return null

  // 2. 集数（先摘出来，避免「第一集」被当成片名的一部分）
  let episode: string | undefined
  for (const re of EP_PATTERNS) {
    const m = re.exec(rest)
    if (!m) continue
    const n = episodeNumber(m[1])
    if (n !== null) episode = String(n)
    rest = (rest.slice(0, m.index) + rest.slice(m.index + m[0].length)).trim()
    break
  }

  // 3. 句尾噪声（重复剥离，处理「庆余年有第二季吗好看吗」这类叠用）
  for (let i = 0; i < 3; i++) {
    let changed = false
    for (const re of SUFFIX_NOISE) {
      const next = rest.replace(re, '').trim()
      if (next !== rest) {
        rest = next
        changed = true
        break
      }
    }
    if (!changed) break
  }

  rest = rest.replace(/\s+/g, ' ').trim()
  const solid = rest.replace(/[^\p{L}\p{N}]/gu, '')
  if (solid.length < 2) return null

  // ★ 没有动词时，剥完必须"看起来就是个片名"：
  //   不能残留疑问/应答虚词，否则说明这句话不是"在说某部片"。
  if (!hadVerb) {
    // 残留虚词 → 不是片名（「那就放它」「能看」「里有啥」「个下饭的喜剧」）
    if (RESIDUE_RE.test(rest)) return null
    // 没有动词又不带季/集/年份等片名特征，且长度很短 → 不可靠
    if (solid.length < 3 && !/[季集]/.test(rest)) return null
  }

  return { title: rest, ...(episode ? { episode } : {}) }
}

// ---------------------------------------------------------------- 分类

/**
 * 判定这句话要做什么。
 *
 * @param raw 用户原话
 * @param ctx.hasConfirmed 上一轮是否已经确认过某部片（决定 confirm 意图是否成立）
 */
export function classifyIntent(raw: string, ctx: { hasConfirmed?: boolean } = {}): Intent {
  const text = raw.trim()
  if (!text) return { kind: 'chat' }

  // ① 纯应答：只在"上一轮确实确认过片"时才成立。
  //    没有上文时「好」「行」指向不明，交给模型问清楚。
  // 纯应答（「好」「那就放它吧」「就这个」）：只在上一轮确认过片时成立。
  // ★ 必须两个正则都试：CONFIRM_RE 匹配"带动词的短句"，
  //   CONFIRM_WORD_RE 匹配裸应答词；只写一个会漏掉另一类。
  if (CONFIRM_WORD_RE.test(text) || CONFIRM_RE.test(text)) {
    return ctx.hasConfirmed ? { kind: 'confirm' } : { kind: 'chat' }
  }

  // ② 功能类意图（不含片名，或片名无所谓）
  //    ★ 必须在片名提取之前判：否则「为什么播不了」会把"为什么播不了"当片名。
  for (const s of SIGNALS) {
    if (!s.re.test(text)) continue
    // 只有诊断类可能带片名（「庆余年为什么播不了」），且要用**剥离后**的残句提取。
    // 其余功能类（源/直播/弹幕/缓存/片库）整句的语义就是那个功能本身，
    // 提取出的"片名"必然是噪声（实测：「这部没弹幕」→ 片名"这部没"）。
    if (s.kind !== 'diagnose') return { kind: s.kind }
    const t = extractTitle(text.replace(s.re, ''))
    return { kind: s.kind, ...(t ? { title: t.title } : {}) }
  }

  // ③ 指代上一轮结果的追问：不搜索，用上一轮的 hits
  //    「还有别的吗」「换个源」「换个线路」都是这个语义。
  if (ctx.hasConfirmed && FOLLOWUP_RE.test(text)) {
    return { kind: 'followup' }
  }

  // 泛化需求（"找个下饭的喜剧"）不是片名，直接交模型去追问
  if (VAGUE_RE.test(text)) return { kind: 'chat' }

  // ④ 播放 / 检索（需要可靠片名）
  const isPlay = PLAY_VERB_RE.test(text)
  const t = extractTitle(text)
  if (t) {
    return isPlay
      ? { kind: 'play', title: t.title, ...(t.episode ? { episode: t.episode } : {}) }
      : { kind: 'search', title: t.title }
  }

  // ⑤ 拿不准 → 交给模型
  return { kind: 'chat' }
}

/**
 * 兼容旧调用：只关心"是不是播放指令"时用它。
 * @deprecated 新代码请用 {@link classifyIntent}
 */
export function parsePlayIntent(raw: string): { title: string; episode?: string } | null {
  const it = classifyIntent(raw)
  return it.kind === 'play' && it.title
    ? { title: it.title, ...(it.episode ? { episode: it.episode } : {}) }
    : null
}
