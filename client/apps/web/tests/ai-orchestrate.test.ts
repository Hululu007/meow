import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_ROUNDS,
  ROUND_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
  TOOL_TIMEOUT_MS,
  KEEP_ROUNDS,
  toolSchemas,
} from '../src/ai/orchestrate'
import {
  summarizeSearch,
  summarizePlay,
  summarizeState,
  summarizeSources,
  clampResult,
  summarizeForModel,
  MAX_RESULT_CHARS,
} from '../src/ai/summarize'
import { ORCH_SYSTEM_PROMPT, DIAG_SYSTEM_PROMPT } from '../src/ai/prompt'

/**
 * 编排循环（docs/47 §4.6 / §4.7）。
 *
 * 五条硬约束与"结果摘要化"是这一层全部的价值——写错任何一条都会出现
 * "AI 卡死 30 秒"或"上下文爆掉"，而这些在单元测试之外几乎无法发现。
 */

describe('编排约束的取值', () => {
  it('约束的数值与文档一致', () => {
    expect(MAX_ROUNDS).toBe(8)
    expect(ROUND_TIMEOUT_MS).toBe(25000)
    expect(TOTAL_TIMEOUT_MS).toBe(90000)
    expect(KEEP_ROUNDS).toBe(4)
  })

  it('工具超时必须够搜索跑完（跨 28 源实测最慢 20s）', () => {
    // 实测踩过：工具与模型共用 8s，导致 meow_search 永远被打断，
    // 模型重试后撞死循环熔断，报"AI 反复尝试同一步"——真因只是搜索没跑完。
    expect(TOOL_TIMEOUT_MS).toBeGreaterThan(20_000)
    expect(TOOL_TIMEOUT_MS).toBeLessThan(TOTAL_TIMEOUT_MS)
  })

  it('模型超时必须够推理模型思考（实测 8s 会误报"分析超时"）', () => {
    // 踩过：「有哪些台能看直播」在 8 秒时直接报超时，而模型只是还在想。
    // function-calling 有 9 个工具 schema 要读，比纯对话慢得多。
    expect(ROUND_TIMEOUT_MS).toBeGreaterThan(15_000)
  })

  it('单轮超时必须小于总超时（否则一轮就能吃完整个预算）', () => {
    expect(ROUND_TIMEOUT_MS).toBeLessThan(TOTAL_TIMEOUT_MS)
  })
})

describe('工具 schema', () => {
  const schemas = toolSchemas()

  it('写操作不由模型自主执行（下载/转码/停用源都只到"提议"为止）', () => {
    const names = schemas.map((s) => s.function.name)
    expect(names).toContain('meow_search')
    expect(names).toContain('meow_play')
    expect(names).toContain('meow_diagnose')
    // 转码、停用源是纯写操作，模型连提议都不该直接做
    expect(names).not.toContain('transcode')
    expect(names).not.toContain('disable_source')
    /*
     * meow_cache_start 可以进编排，但**只解析、不下载**：
     * 它返回一份 CachePlan 交给界面，用户在确认框里点过才真正入队。
     * 下游断言锁住这一点，见下面「meow_cache_start 只解析」。
     */
    expect(names).toContain('meow_cache_start')
  })

  it('meow_cache_start 只解析不下载（不能替用户决定花流量）', () => {
    const SRC = readFileSync(join(__dirname, '..', 'src', 'ai', 'tools.ts'), 'utf8')
    const i = SRC.indexOf('export async function meowCacheStart')
    expect(i).toBeGreaterThan(-1)
    const body = SRC.slice(i, SRC.indexOf('/** 待确认的缓存计划', i))
    // 工具内部不许直接提交下载任务
    expect(body).not.toContain('startBatchCache(')
    expect(body).not.toContain('cacheEpisode(')
    // 必须把计划交回界面
    expect(body).toContain("kind: 'cache-plan'")
  })

  it('每个工具都有 description 与合法 parameters', () => {
    for (const s of schemas) {
      expect(s.type).toBe('function')
      expect(s.function.description.length, `${s.function.name} 缺描述`).toBeGreaterThan(5)
      expect(s.function.parameters.type).toBe('object')
      expect(s.function.parameters.required).toBeInstanceOf(Array)
    }
  })

  it('必填参数被正确标记', () => {
    const search = schemas.find((s) => s.function.name === 'meow_search')!
    expect(search.function.parameters.required).toContain('keyword')
    const state = schemas.find((s) => s.function.name === 'meow_state')!
    expect(state.function.parameters.required).toEqual([])
  })
})

describe('工具结果摘要化（§4.6 那张表）', () => {
  it('搜索：前 5 部 × 每部前 3 个源', () => {
    const hits = Array.from({ length: 9 }, (_, i) => ({
      name: `片${i}`,
      remarks: 'HD',
      sources: Array.from({ length: 6 }, (_, j) => ({ site: `s${j}`, vod_id: `${i}${j}` })),
    }))
    const s = summarizeSearch(hits) as any
    expect(s.结果数).toBe(9)
    expect(s.前几部.length).toBe(5)
    expect(s.前几部[0].来源.length).toBe(3)
    expect(s.前几部[0].来源总数).toBe(6)
  })

  it('播放：不回完整地址（几百字符的签名 URL 模型用不上还易泄漏）', () => {
    const longUrl = 'https://cdn.example.com/path/to/playlist.m3u8?sign=' + 'x'.repeat(300)
    const s = summarizePlay({ url: longUrl, line: '线路1', episode: '第1集', tried: ['线路1'] }) as any
    const text = JSON.stringify(s)
    expect(text).not.toContain('sign=')
    expect(s.地址是http).toBe(true)
    expect(s.线路).toBe('线路1')
  })

  it('状态：降级源最多 10 个，附总数', () => {
    const degraded = Array.from({ length: 25 }, (_, i) => ({ site: `源${i}` }))
    const s = summarizeState({
      version: '0.9.20', sites: 28, ext: 10, degraded, disabled: [],
    }) as any
    expect(s.降级源.length).toBe(10)
    expect(s.降级总数).toBe(25)
    expect(s.版本).toBe('0.9.20')
  })

  it('源清单：只回有问题的（健康的列出来没有信息量）', () => {
    const s = summarizeSources({
      total: 28,
      sites: [
        { key: 'a', name: '好的', degraded: false, disabled: false },
        { key: 'b', name: '降级的', degraded: true, disabled: false },
        { key: 'c', name: '停用的', degraded: false, disabled: true },
      ],
    }) as any
    expect(s.有问题的源.length).toBe(2)
    expect(s.总数).toBe(28)
  })

  it('超过 2KB 截断并标注', () => {
    const big = { x: 'y'.repeat(5000) }
    const out = clampResult(big)
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 20)
    expect(out).toContain('已截断')
  })

  it('工具失败时直接给错误文案（让模型知道失败并能换参数）', () => {
    const out = summarizeForModel('meow_search', { ok: false, error: '后端 500' })
    expect(out).toContain('后端 500')
  })

  it('未知工具走通用截断，不崩', () => {
    expect(() => summarizeForModel('unknown_tool', { a: 1 })).not.toThrow()
  })
})

describe('系统提示词（§4.8 四块）', () => {
  it('编排提示词包含：应用说明、术语、工具原则、禁止、输出要求', () => {
    expect(ORCH_SYSTEM_PROMPT).toContain('影视聚合客户端')
    expect(ORCH_SYSTEM_PROMPT).toContain('线路')
    expect(ORCH_SYSTEM_PROMPT).toContain('parse')
    expect(ORCH_SYSTEM_PROMPT).toContain('什么时候可以调用 meow_search')
    expect(ORCH_SYSTEM_PROMPT).toContain('禁止')
    expect(ORCH_SYSTEM_PROMPT).toContain('不要输出完整 URL')
  })

  it('禁止编造片名（幻觉是最常见的失败模式）', () => {
    expect(ORCH_SYSTEM_PROMPT).toContain('绝不编造片名')
  })

  it('诊断提示词与编排提示词分开（用途不同，混一起会让诊断也去调工具）', () => {
    expect(DIAG_SYSTEM_PROMPT).not.toBe(ORCH_SYSTEM_PROMPT)
    expect(DIAG_SYSTEM_PROMPT).toContain('看片助理')
    // 诊断不该出现工具使用原则
    expect(DIAG_SYSTEM_PROMPT).not.toContain('什么时候可以调用 meow_search')
  })

  it('提示词控制在合理长度（占固定 token 预算，别写成长文）', () => {
    // 约 2.5 字符/token（中文）。加了人设块（PERSONA）与缓存用法两段后
    // 上限从 1500 提到 2200 ≈ 880 token，仍远小于模型上下文，但能拦住
    // "顺手往里加长文"导致每轮 prompt 膨胀。
    expect(ORCH_SYSTEM_PROMPT.length).toBeLessThan(2200)
  })
})

describe('编排实现里的关键约束（源码级）', () => {
  const SRC = readFileSync(join(__dirname, '..', 'src', 'ai', 'orchestrate.ts'), 'utf8')

  it('有死循环判定：同工具同参数连续 2 次终止', () => {
    expect(SRC).toMatch(/sig\(/)
    expect(SRC).toMatch(/sameCount >= 2/)
    expect(SRC).toMatch(/stopReason: 'loop'/)
  })

  it('历史裁剪保留 system + 已有历史 + 本轮 user，再留最近 N 轮', () => {
    expect(SRC).toMatch(/KEEP_ROUNDS/)
    // 2026-10-27 改：带上对话历史后边界不能写死 2
    // （写死会把 history 当成工具往返裁掉，上下文白传）
    expect(SRC).toMatch(/baseLen/)
    expect(SRC).toMatch(/messages\.slice\(0, baseLen\)/)
  })

  it('工具结果作为 user 消息回灌（assistant 会让模型以为自己做完了）', () => {
    expect(SRC).toMatch(/role: 'user', content: `工具 \$\{name\} 返回/)
  })

  it('每轮都有超时，且工具调用也受同一个超时保护', () => {
    const hits = SRC.match(/withTimeout\(/g) || []
    expect(hits.length, '模型与工具都要包超时').toBeGreaterThanOrEqual(3)
  })
})

describe('面板渲染（2026-10-27 改成消息列表）', () => {
  const PANEL = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ai', 'AiPanel.vue'),
    'utf8',
  )

  it('每条消息内各元素独立 v-if，不挤成 v-else-if 链', () => {
    // 历史踩过：trace 后面紧跟 v-else-if="step"、v-else-if="answer"，
    // 于是 trace 非空时整条链后面全被跳过 —— 模型给了回答，面板却只显示
    // "已查：meow_state"。
    // 改成消息列表后同样的原则：trace / 正文 / error / 卡片各自判定。
    const noComments = PANEL.replace(/<!--[\s\S]*?-->/g, '')
    expect(noComments, 'trace 独立判定').toMatch(/v-if="m\.trace\?\.length"/)
    expect(noComments, '正文独立判定').toMatch(/v-if="m\.text"/)
    expect(noComments, '错误独立判定').toMatch(/v-if="m\.error"/)
    expect(noComments, '卡片独立判定').toMatch(/v-if="m\.hits\?\.length"/)
  })

  it('空态只在完全没有消息时出现', () => {
    expect(PANEL).toMatch(/v-if="!msgs[.]length"/)
  })

  it('新消息追加后要滚到底（否则看不到刚发的内容）', () => {
    expect(PANEL).toMatch(/scrollToBottom/)
    expect(PANEL).toMatch(/scrollTop = el\.scrollHeight/)
  })
})

describe('meow_play 的请求形态（实测踩过，2026-10-27）', () => {
  const TOOLS_SRC = readFileSync(
    join(__dirname, '..', 'src', 'ai', 'tools.ts'),
    'utf8',
  )

  it('detail / play 必须用 POST，不能用 GET + query', () => {
    // 踩过：/api/{site}/{action} 的分派只读 body（ApiServer 里是
    // `read(ex.getRequestBody())` 后直接 call），写成 ?ids=xxx 会拿到空 body。
    // 表现是 meow_play 四条线路全报"详情为空（源可能已失效）"，
    // AI 反复重试直到轮数耗尽 —— 但手动点播放完全正常，所以极难归因。
    expect(TOOLS_SRC, 'detail 必须 postJson').toMatch(
      /postJson<any>\(`\/api\/\$\{encodeURIComponent\(site\)\}\/detail`/,
    )
    expect(TOOLS_SRC, 'play 必须 postJson').toMatch(
      /postJson<any>\(`\/api\/\$\{encodeURIComponent\(site\)\}\/play`/,
    )
    // 反向断言：只查**代码行**。不能扫全文——注释里正写着 `?ids=xxx` 当反例说明，
    // 扫全文会被自己的说明文字误伤（实测踩过）。
    const codeOnly = TOOLS_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(codeOnly, 'detail 不能再拼 ?ids=').not.toMatch(/\/detail\?ids=/)
    expect(codeOnly, 'play 不能再拼 ?flag=').not.toMatch(/\/play\?flag=/)
  })
})

describe('同工具连续失败的熔断（实测踩过，2026-10-27）', () => {
  const ORCH = readFileSync(
    join(__dirname, '..', 'src', 'ai', 'orchestrate.ts'),
    'utf8',
  )

  it('除了"同参数"还要判"同工具连续失败"', () => {
    // 踩过：只按参数签名判循环时，模型每次重试的参数略有不同
    // （有时带 line 有时不带），签名全部不同 → 熔断失效，
    // 实测连续 4 次 meow_play 失败一路试到 max_rounds。
    expect(ORCH).toMatch(/failTool/)
    expect(ORCH).toMatch(/failCount/)
    expect(ORCH, '连续失败 2 次就停').toMatch(/failCount\s*>=\s*2/)
  })

  it('工具成功要清零失败计数（否则偶发失败会累积成误判）', () => {
    expect(ORCH).toMatch(/failTool = ''/)
  })
})

describe('stopReason 的文案必须分开（实测踩过，2026-10-27）', () => {
  const PANEL = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ai', 'AiPanel.vue'),
    'utf8',
  )

  it('timeout 与 max_rounds 不能共用一句话', () => {
    // 踩过：原来只判 timeout，max_rounds 落进同一句"分析超时了"，
    // 把"AI 试了 8 轮没搞定"误导成"网络慢"。
    expect(PANEL).toMatch(/stopReason === 'max_rounds'/)
    expect(PANEL, '要显示具体失败原因').toMatch(/r[.]error/)
  })
})

describe('对话历史（2026-10-27 新增）', () => {
  const ORCH = readFileSync(
    join(__dirname, '..', 'src', 'ai', 'orchestrate.ts'),
    'utf8',
  )
  const PANEL = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ai', 'AiPanel.vue'),
    'utf8',
  )

  it('orchestrate 接受 history 并插在 system 与本轮 user 之间', () => {
    // 实测：不带上文时模型会直接回"上一轮的片名不在当前上下文里"，
    // 用户必须每句都把片名重说一遍。
    expect(ORCH).toMatch(/history\?: HistoryTurn\[\]/)
    expect(ORCH).toMatch(/\.\.\.\(opts\.history \|\| \[\]\)/)
  })

  it('裁剪边界必须按 history 长度算，不能写死 slice(0, 2)', () => {
    // 踩过风险：写死 2 会把 history 当成工具往返裁掉，上下文白传。
    expect(ORCH).toMatch(/baseLen/)
    expect(ORCH, '不能再写死 slice(0, 2)').not.toMatch(/messages\.slice\(0,\s*2\)/)
  })

  it('historyRounds 的 0 是合法值（= 不带历史），不能被 || 兜底掉', () => {
    const LLM = readFileSync(join(__dirname, '..', 'src', 'ai', 'llm.ts'), 'utf8')
    expect(LLM).toMatch(/p\.llmHistoryRounds === undefined/)
  })

  it('面板必须显示用户原话（不能只有 AI 回答）', () => {
    // 踩过：原来只显示最后一条答案，用户发完就看不到自己说了什么。
    expect(PANEL).toMatch(/role === 'user'/)
    expect(PANEL).toMatch(/pushMsg\(\{ role: 'user'/)
  })
})

describe('搜索触发条件（实测踩过，2026-10-27）', () => {
  const PANEL = readFileSync(
    join(__dirname, '..', 'src', 'components', 'ai', 'AiPanel.vue'),
    'utf8',
  )
  const PROMPT = readFileSync(join(__dirname, '..', 'src', 'ai', 'prompt.ts'), 'utf8')
  const TOOLS_SRC = readFileSync(join(__dirname, '..', 'src', 'ai', 'tools.ts'), 'utf8')

  it('卡片回填必须用模型真正搜到的那批结果，不能用用户原话重搜', () => {
    // 踩过：meowSearch(text) 拿"那就放它吧"去搜，搜出
    // 「扶你青云反成仇，那就放你尘埃」这种无关片并当结果展示。
    // 现在直接用工具返回的 data —— 它本来就是模型用 args.keyword 搜到的那批，
    // 既不可能是用户原话，也不用重搜一遍（跨 28 源 4–25 秒）。
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code, '要用工具返回的 data').toMatch(/lastSearch\?\.data/)
    // 「未配置模型」那条兜底路径用原文搜索是对的（用户就是拿它当关键词），
    // 所以只断言：走模型编排后回填卡片那段没有再用原文。
    const afterOrch = code.slice(code.indexOf('orchestrate(text'))
    const cardFill = afterOrch.slice(0, afterOrch.indexOf('patchMsg(aiId'))
    expect(cardFill, '编排后不能用原文回填卡片').not.toMatch(/meowSearch\(text/)
    expect(cardFill, '编排后不该再搜一遍').not.toMatch(/await meowSearch\(/)
  })

  it('纯应答词走 confirm 直通，不进搜索', () => {
    expect(PANEL).toMatch(/classifyIntent/)
    expect(PANEL, 'confirm 分支要直接播放').toMatch(/intent\.kind === 'confirm'/)
    expect(PANEL, '有已确认的片就直接播').toMatch(/lastConfirmedHits/)
  })

  it('工具描述必须写清"什么时候不要调用"（模型靠它选工具，和 ZCode 技能同理）', () => {
    // 根因：原 desc 只有"按片名搜索"，模型就把「那就放它吧」当 keyword 传进来。
    // 判断交给模型时，唯一的说明就是这个 desc。
    const ORCH_SRC = readFileSync(
      join(__dirname, '..', 'src', 'ai', 'orchestrate.ts'),
      'utf8',
    )
    expect(ORCH_SRC).toMatch(/以下情况\*\*不要\*\*调用/)
    expect(ORCH_SRC, 'meow_play 要说明复用上一轮 id').toMatch(/不要为了拿 id 重新搜索/)
  })

  it('工具层对无实义关键词要直接拒绝', () => {
    // 代码级兜底：提示词约束对弱模型不可靠
    expect(TOOLS_SRC).toMatch(/NON_TITLE_RE/)
    expect(TOOLS_SRC).toMatch(/不是片名，不能用来搜索/)
  })

  it('提示词要写明"什么时候不搜"，而不是只说"什么时候搜"', () => {
    expect(PROMPT).toMatch(/绝对不要搜索/)
    expect(PROMPT).toMatch(/那就放它吧/)
  })
})

describe('工具清单完整性（2026-10-27 实测漏了 3 个）', () => {
  const TOOLS_SRC = readFileSync(join(__dirname, '..', 'src', 'ai', 'tools.ts'), 'utf8')
  const ORCH_SRC = readFileSync(join(__dirname, '..', 'src', 'ai', 'orchestrate.ts'), 'utf8')

  it('tools.ts 的 TOOL_DEFS 里每个工具，orchestrate 都必须注册给模型', () => {
    // 踩过：TOOL_DEFS 有 9 个，orchestrate 的 TOOLS 只注册了 6 个，
    // meow_danmaku / meow_live / meow_cache 模型根本看不见 ——
    // 用户问"这部为什么没弹幕"时它只能瞎猜。
    const declared = [...TOOLS_SRC.matchAll(/name: '(meow_[a-z]+)'/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThanOrEqual(9)
    for (const name of new Set(declared)) {
      expect(ORCH_SRC, `${name} 必须注册进编排表`).toMatch(
        new RegExp(`\n  ${name}: \{`),
      )
    }
  })

  it('每个注册的工具都要有非空 desc（模型唯一的判断依据）', () => {
    const blocks = [...ORCH_SRC.matchAll(/\n  (meow_[a-z]+): \{[\s\S]*?\n  \},/g)]
    expect(blocks.length).toBeGreaterThanOrEqual(9)
    for (const b of blocks) {
      const name = b[1]
      expect(b[0], `${name} 缺少 desc`).toMatch(/desc:/)
      // desc 不能只是一句"某某功能"，要写明触发场景
      expect(b[0].length, `${name} 的 desc 太短，写不清什么时候用`).toBeGreaterThan(60)
    }
  })
})

describe('外部 MCP 工具桥（docs/47 §1.8 方案 A）', () => {
  const BRIDGE = readFileSync(join(__dirname, '..', 'src', 'ai', 'bridge.ts'), 'utf8')
  const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8')

  it('桥要在 main.ts 里装（否则壳调用不到）', () => {
    expect(MAIN).toMatch(/installToolBridge\(\)/)
  })

  it('三个入口缺一不可：直调 / 投任务 / 取结果', () => {
    // PC 用 __meowTool（CDP 支持 awaitPromise）；
    // TV 的 evaluateJavascript 是同步回调，只能走 Start + Poll。
    expect(BRIDGE).toMatch(/__meowTool\b/)
    expect(BRIDGE).toMatch(/__meowToolStart/)
    expect(BRIDGE).toMatch(/__meowToolPoll/)
  })

  it('桥的工具集必须与 orchestrate 的 9 个一致', () => {
    // 两边漂移会让外部 AI 调不到应用内能用的工具
    const inBridge = [...BRIDGE.matchAll(/^\s{2}(meow_[a-z]+):/gm)].map((m) => m[1])
    const ORCH_SRC = readFileSync(join(__dirname, '..', 'src', 'ai', 'orchestrate.ts'), 'utf8')
    const inOrch = [...ORCH_SRC.matchAll(/\n  (meow_[a-z]+): \{/g)].map((m) => m[1])
    expect(new Set(inBridge)).toEqual(new Set(inOrch))
  })

  it('写操作不能进桥（外部 AI 不该能触发下载/转码）', () => {
    // 缓存只暴露 list
    expect(BRIDGE).toMatch(/meow_cache: \(\) => tools\.meowCache\('list'\)/)
  })

  it('投任务通道要能回收过期任务（否则内存只增不减）', () => {
    expect(BRIDGE).toMatch(/PENDING_TTL_MS/)
    expect(BRIDGE).toMatch(/gcPending/)
  })
})
