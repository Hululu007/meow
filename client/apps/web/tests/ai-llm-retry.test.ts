import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chat, chatWithTools, effectiveMaxTokens, llmConfig } from '../src/ai/llm'
import { __resetPrefsCache } from '../src/stores/prefs'
import { MIN_ROUND_TOKENS } from '../src/ai/orchestrate'

/**
 * 模型返回空正文时的翻倍重试（2026-11-02）。
 *
 * 真实现场：偏好 `llmMaxTokens` 默认 300（设置页没有这个字段，用户改不了），
 * 推理模型在"11 个工具 schema + 工具结果 + 历史"的上下文里把 300 全烧在
 * 思维链上 → `finish_reason='length'`、content 与 tool_calls 都为空 →
 * 面板显示"分析超时了（模型返回空内容）"。
 *
 * 判据是 finish_reason 而不是模型名：deepseek-v4.1-flash 这类名字
 * 匹配不到 REASONING_MODEL_RE，靠名字永远兜不住。
 */

function setPrefs(patch: Record<string, unknown>) {
  localStorage.setItem(
    'meow.prefs',
    JSON.stringify({
      llmEnabled: true,
      llmBaseUrl: 'http://model.test/v1',
      llmApiKey: 'k-test',
      llmModel: 'some-flash',
      llmTimeoutMs: 8000,
      llmMaxTokens: 300,
      ...patch,
    }),
  )
  __resetPrefsCache()
}

interface Seen {
  max_tokens: number
  toolNames?: string[]
}

/** 按顺序回放给定的响应体，并记录每次请求的 max_tokens */
function stubFetch(replies: any[]): Seen[] {
  const seen: Seen[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body).body
      seen.push({
        max_tokens: body.max_tokens,
        toolNames: body.tools?.map((t: any) => t.function.name),
      })
      const r = replies[Math.min(seen.length - 1, replies.length - 1)]
      return { ok: true, status: 200, json: async () => r } as any
    }),
  )
  return seen
}

const emptyLen = {
  choices: [{ finish_reason: 'length', message: { content: '' } }],
}
const okText = {
  choices: [{ finish_reason: 'stop', message: { content: '好的，这就办。' } }],
}

beforeEach(() => {
  localStorage.clear()
  __resetPrefsCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('空正文 + finish_reason=length 要翻倍重试', () => {
  it('第一次 300 被截断 → 第二次用更大预算并成功', async () => {
    setPrefs({})
    const seen = stubFetch([emptyLen, okText])
    const r = await chat([{ role: 'user', content: '你好' }])
    expect(r.ok).toBe(true)
    expect(r.ok && r.text).toBe('好的，这就办。')
    expect(seen).toHaveLength(2)
    expect(seen[0].max_tokens).toBe(300)
    // min(max(300*4, 2000), 8000) = 2000
    expect(seen[1].max_tokens).toBe(2000)
  })

  it('第二次仍然空 → 返回失败，不再无限重试', async () => {
    setPrefs({})
    const seen = stubFetch([emptyLen, emptyLen, emptyLen])
    const r = await chat([{ role: 'user', content: '你好' }])
    expect(r.ok).toBe(false)
    expect(seen).toHaveLength(2)
    expect(r.ok === false && r.error).toContain('空内容')
  })

  it('finish_reason=stop 但空内容 → 不重试（不是预算问题）', async () => {
    setPrefs({})
    const seen = stubFetch([
      { choices: [{ finish_reason: 'stop', message: { content: '' } }] },
      okText,
    ])
    const r = await chat([{ role: 'user', content: '你好' }])
    expect(r.ok).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('有正文时不重试', async () => {
    setPrefs({})
    const seen = stubFetch([okText, okText])
    const r = await chat([{ role: 'user', content: '你好' }])
    expect(r.ok).toBe(true)
    expect(seen).toHaveLength(1)
  })
})

describe('编排的一轮有 token 下限', () => {
  it('偏好 300 也会被抬到 MIN_ROUND_TOKENS', async () => {
    setPrefs({})
    const seen = stubFetch([okText])
    await chatWithTools([{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'meow_state' } }], {
      minTokens: MIN_ROUND_TOKENS,
    })
    expect(seen[0].max_tokens).toBe(MIN_ROUND_TOKENS)
    expect(seen[0].toolNames).toEqual(['meow_state'])
  })

  it('推理模型（名字命中 r1）仍然拿到 3000 的预算', async () => {
    setPrefs({ llmModel: 'deepseek-r1:14b' })
    expect(effectiveMaxTokens(llmConfig())).toBe(3000)
    const seen = stubFetch([okText])
    await chatWithTools([{ role: 'user', content: 'hi' }], [], { minTokens: MIN_ROUND_TOKENS })
    expect(seen[0].max_tokens).toBe(3000)
  })
})
