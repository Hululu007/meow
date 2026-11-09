import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROUND_TIMEOUT_MS,
  MODEL_ABORT_MS,
  MIN_ROUND_TOKENS,
  TOOL_TIMEOUT_MS,
  TOTAL_TIMEOUT_MS,
} from '../src/ai/orchestrate'
import { llmConfig, effectiveMaxTokens } from '../src/ai/llm'

/**
 * 模型请求的实际超时（2026-11-02 用户报「AI 总是超时」）。
 *
 * 真因是**两层超时叠在一起、内层比外层小**：编排层写 25 秒，
 * 但 `callModel` 用偏好里的 `llmTimeoutMs`（默认 8000）做 AbortSignal，
 * 于是每一轮最多活 8 秒，25 秒那个预算从未生效。
 * 实测同一条链路一轮 2–3 秒就能回，推理模型偶尔多想几秒就必然撞 8 秒。
 */

const dir = join(__dirname, '..', 'src', 'ai')
const LLM = readFileSync(join(dir, 'llm.ts'), 'utf8')
const ORCH = readFileSync(join(dir, 'orchestrate.ts'), 'utf8')
const PANEL = readFileSync(
  join(__dirname, '..', 'src', 'components', 'ai', 'AiPanel.vue'),
  'utf8',
)

describe('内层 abort 必须比外层竞速宽松', () => {
  it('MODEL_ABORT_MS > ROUND_TIMEOUT_MS', () => {
    expect(MODEL_ABORT_MS).toBeGreaterThan(ROUND_TIMEOUT_MS)
    expect(MODEL_ABORT_MS).toBe(ROUND_TIMEOUT_MS + 3000)
  })

  it('编排层把 MODEL_ABORT_MS 传给 chatWithTools', () => {
    expect(ORCH).toMatch(/timeoutMs:\s*MODEL_ABORT_MS/)
  })

  it('chatWithTools 接受并转发 timeoutMs', () => {
    expect(LLM).toMatch(/opts:\s*\{\s*timeoutMs\?:\s*number;\s*minTokens\?:\s*number\s*\}/)
    expect(LLM).toMatch(/timeoutMs:\s*opts\.timeoutMs/)
    expect(LLM).toMatch(/minTokens:\s*opts\.minTokens/)
  })

  it('callModel 用预算变量，不能直接用 cfg.timeoutMs 掐断', () => {
    // ★ 这一条就是回归点：写成 cfg.timeoutMs 会让编排的 25 秒永远不生效。
    expect(LLM).toMatch(/const budgetMs = Math\.max\(/)
    expect(LLM).toMatch(/AbortSignal\.timeout\(budgetMs\)/)
    expect(LLM).toMatch(/timeoutReject\(budgetMs\)/)
    expect(LLM).not.toMatch(/AbortSignal\.timeout\(cfg\.timeoutMs\)/)
    expect(LLM).not.toMatch(/timeoutReject\(cfg\.timeoutMs\)/)
  })

  it('偏好里的 8 秒仍用于单次解释（不被静默改语义）', () => {
    expect(LLM).toMatch(/extra\.timeoutMs \?\? cfg\.timeoutMs/)
  })

  it('默认配置在"没配过"时是 8000，这是历史值，改动要同步文案', () => {
    // 不 mock localStorage：jsdom 里没配过 → 走 DEFAULTS
    expect(llmConfig().timeoutMs).toBe(8000)
  })

  it('总预算大于单轮，单轮大于工具（否则先被外层砍）', () => {
    expect(TOTAL_TIMEOUT_MS).toBeGreaterThan(ROUND_TIMEOUT_MS)
    expect(ROUND_TIMEOUT_MS).toBeGreaterThan(TOOL_TIMEOUT_MS - 10_000)
  })
})

describe('token 预算：空正文的第二个真因', () => {
  it('编排每轮有硬下限，且高于偏好默认（300）', () => {
    expect(MIN_ROUND_TOKENS).toBeGreaterThanOrEqual(1000)
    expect(ORCH).toMatch(/minTokens:\s*MIN_ROUND_TOKENS/)
  })

  it('名字不含 r1/reasoner 的推理模型不会被 effectiveMaxTokens 放过', () => {
    // deepseek-v4.1-flash 是推理模型（usage.reasoning_tokens 一两百到上千），
    // 但名字匹配不到 REASONING_MODEL_RE —— 所以不能只靠名字。
    const cfg = { ...llmConfig(), model: 'deepseek-v4.1-flash', maxTokens: 300 }
    expect(effectiveMaxTokens(cfg)).toBe(300)
    // 真兜底在 callModel：finish_reason=length 且两样都空 → 翻倍重试
    expect(LLM).toMatch(/finishReason === 'length'/)
    expect(LLM).toMatch(/reason === 'empty'/)
  })

  it('新装默认 max_tokens 足够一轮（不再是被 300 掐死的空内容）', () => {
    expect(llmConfig().maxTokens).toBeGreaterThanOrEqual(800)
  })

  it('重试上限不能无限放大（费用护栏）', () => {
    expect(LLM).toMatch(/Math\.min\(Math\.max\(baseTokens \* 4, 2000\), 8000\)/)
  })
})

describe('超时文案要带原因', () => {
  it('timeout 分支也显示 r.error', () => {
    // 踩过：timeout 分支刻意不带原因，用户只能反复问"为什么超时"。
    expect(PANEL).toMatch(/分析超时了\$\{why\}/)
  })
})

describe('编排后不要再重搜一遍（白等 4–25 秒）', () => {
  // 注释里会引用旧写法做说明，断言前先剥掉注释
  const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('卡片直接用工具返回的 data', () => {
    expect(code).toMatch(/lastSearch\?\.data/)
    expect(code).not.toMatch(/meowSearch\(kw,/)
  })
})
