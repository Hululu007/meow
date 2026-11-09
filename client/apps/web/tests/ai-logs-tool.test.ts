import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filterLogs, type LogEntry } from '../src/ai/tools'
import { summarizeLogs, summarizeState, summarizeForModel } from '../src/ai/summarize'
import { toolSchemas } from '../src/ai/orchestrate'

/**
 * meow_logs（2026-11-02）。
 *
 * 起因是实测：`meow_state` 固定取"最后 20 条"，而那 20 条**全是**
 * `GET /api/...` 请求噪音、warn/error 零条 —— AI 拿到的"最近日志"
 * 信息量为零。改成把"多少条 / 什么级别 / 哪个模块 / 多长时间窗"
 * 交给模型自己决定，这里锁住那套筛选语义。
 */

const NOW = new Date('2026-11-02T12:00:00Z').getTime()
const min = 60_000

function entry(
  level: string,
  text: string,
  opts: { tag?: string; agoMin?: number } = {},
): LogEntry {
  return {
    at: NOW - (opts.agoMin ?? 0) * min,
    level,
    tag: opts.tag ?? 'req',
    text,
  }
}

describe('filterLogs 的级别筛选用"以上"而非精确匹配', () => {
  const all = [
    entry('info', 'GET /api/health'),
    entry('warn', 'slow drpy_js_x 8000ms'),
    entry('error', 'spider jar 加载失败'),
  ]

  it('minLevel=warn 同时包含 warn 与 error', () => {
    // 后端 /api/logs 的 level 是**精确**匹配，模型说"warn 以上"是最自然的
    // 表达；如果这里退化成精确匹配，模型永远看不到 error。
    const r = filterLogs(all, { minLevel: 'warn' }, NOW)
    expect(r.items.map((e) => e.level)).toEqual(['warn', 'error'])
    expect(r.matched).toBe(2)
    expect(r.scanned).toBe(3)
  })

  it('minLevel=error 只留 error', () => {
    expect(filterLogs(all, { minLevel: 'error' }, NOW).items).toHaveLength(1)
  })

  it('不传 minLevel 等于 info（全都要）', () => {
    expect(filterLogs(all, {}, NOW).matched).toBe(3)
  })

  it('未知级别按 info 处理，不会被静默丢掉', () => {
    const r = filterLogs([{ at: NOW, level: 'debug', tag: 'x', text: 'y' }], {}, NOW)
    expect(r.matched).toBe(1)
  })
})

describe('filterLogs 的模块与关键词筛选', () => {
  const all = [
    entry('info', 'GET /api/search?wd=abc', { tag: 'req' }),
    entry('warn', 'slow drpy_js_qq 8000ms', { tag: 'spider' }),
    entry('error', 'NoClassDefFoundError merge/g/b', { tag: 'spider' }),
  ]

  it('tag 精确匹配，不做前缀/子串', () => {
    expect(filterLogs(all, { tag: 'spider' }, NOW).matched).toBe(2)
    // "spid" 不该命中 —— 否则模型传半截标签会得到假结果
    expect(filterLogs(all, { tag: 'spid' }, NOW).matched).toBe(0)
  })

  it('关键词不区分大小写，正文与标签都匹配', () => {
    expect(filterLogs(all, { keyword: 'noclassdeffound' }, NOW).matched).toBe(1)
    expect(filterLogs(all, { keyword: 'DRPY' }, NOW).matched).toBe(1)
    // 标签也能被关键词命中，模型不必先知道 tag 的准确拼写
    expect(filterLogs(all, { keyword: 'spider' }, NOW).matched).toBe(2)
  })

  it('条件之间是 AND', () => {
    const r = filterLogs(all, { tag: 'spider', keyword: 'merge/g/b' }, NOW)
    expect(r.items.map((e) => e.level)).toEqual(['error'])
  })
})

describe('filterLogs 的时间窗与条数上限', () => {
  const all = [
    entry('error', 'old failure', { agoMin: 30 }),
    entry('error', 'recent failure', { agoMin: 2 }),
    entry('info', 'now', { agoMin: 0 }),
  ]

  it('minutes 只留时间窗内的', () => {
    const r = filterLogs(all, { minutes: 5 }, NOW)
    expect(r.items.map((e) => e.text)).toEqual(['recent failure', 'now'])
    // matched 反映的是"满足条件的总数"，与本次取了 N 条无关 ——
    // 模型靠这个数字判断"要不要收窄/再看下一批"
    expect(r.matched).toBe(2)
    expect(r.scanned).toBe(3)
  })

  it('limit 取最新的 N 条（而不是最早的）', () => {
    const r = filterLogs(all, { limit: 2 }, NOW)
    expect(r.items.map((e) => e.text)).toEqual(['recent failure', 'now'])
  })

  it('limit 默认 50，上限 500，下限 1', () => {
    const many = Array.from({ length: 600 }, (_, i) => entry('info', `l${i}`))
    expect(filterLogs(many, {}, NOW).items).toHaveLength(50)
    expect(filterLogs(many, { limit: 9999 }, NOW).items).toHaveLength(500)
    expect(filterLogs(many, { limit: 0 }, NOW).items).toHaveLength(50) // 0 → 默认
    expect(filterLogs(many, { limit: -3 }, NOW).items).toHaveLength(1)
  })

  it('minutes 传 0 / 负数视为"不限时间"', () => {
    expect(filterLogs(all, { minutes: 0 }, NOW).matched).toBe(3)
    expect(filterLogs(all, { minutes: -10 }, NOW).matched).toBe(3)
  })
})

describe('summarizeLogs 喂给模型的形状', () => {
  it('带命中数/扫描数，正文截到 160 字', () => {
    const long = 'x'.repeat(400)
    const out = summarizeLogs({
      items: [{ at: NOW, level: 'error', tag: 'spider', text: long }],
      matched: 1,
      scanned: 120,
    }) as Record<string, unknown>
    expect(out['命中']).toBe(1)
    expect(out['扫描']).toBe(120)
    const logs = out['日志'] as Array<Record<string, string>>
    expect(logs[0]['级别']).toBe('error')
    expect(logs[0]['模块']).toBe('spider')
    expect(logs[0]['内容'].length).toBe(160)
  })

  it('走 summarizeForModel 时不再套一层 data', () => {
    const text = summarizeForModel('meow_logs', {
      ok: true,
      summary: 'ignored',
      data: { items: [{ at: NOW, level: 'warn', tag: 'req', text: 'slow' }], matched: 1, scanned: 9 },
    })
    expect(text).toContain('命中')
    expect(text).toContain('slow')
    expect(text).not.toContain('ignored')
  })

  it('失败时给错误文案而不是空对象', () => {
    expect(summarizeForModel('meow_logs', { ok: false, error: '后端版本较旧' })).toContain(
      '后端版本较旧',
    )
  })
})

describe('meow_state 只给日志概况，正文交给 meow_logs', () => {
  it('带上各级条数与可用模块，模型才知道 meow_logs 该填什么 tag', () => {
    const out = summarizeState({
      version: '0.9.40',
      sites: 270,
      degraded: [],
      disabled: [],
      logs: [{ level: 'error', text: 'boom' }],
      logCounts: { info: 198, warn: 1, error: 1 },
      logTags: ['req', 'spider', 'danmu'],
    }) as Record<string, unknown>
    expect(out['日志条数']).toEqual({ info: 198, warn: 1, error: 1 })
    expect(out['日志模块']).toEqual(['req', 'spider', 'danmu'])
  })

  it('旧后端无 /api/logs 时把原因透出去', () => {
    const out = summarizeState({
      version: '0.9.15',
      sites: 40,
      degraded: [],
      disabled: [],
      logHint: '后端版本较旧，无 /api/logs（meow_logs 也不可用）',
    }) as Record<string, unknown>
    expect(out['日志不可用']).toContain('较旧')
  })
})

describe('meow_logs 必须三端都能被调到的注册位置', () => {
  const dir = join(__dirname, '..', 'src', 'ai')
  const TOOLS_SRC = readFileSync(join(dir, 'tools.ts'), 'utf8')
  const ORCH_SRC = readFileSync(join(dir, 'orchestrate.ts'), 'utf8')
  const BRIDGE_SRC = readFileSync(join(dir, 'bridge.ts'), 'utf8')
  const PROMPT_SRC = readFileSync(join(dir, 'prompt.ts'), 'utf8')

  it('tools.ts：定义 + TOOL_DEFS + TOOL_IMPL', () => {
    expect(TOOLS_SRC).toContain('export async function meowLogs')
    expect(TOOLS_SRC).toMatch(/name: 'meow_logs'/)
    expect(TOOLS_SRC).toMatch(/meow_logs: meowLogs/)
  })

  it('orchestrate.ts：应用内 AI 有独立的 TOOLS 表，必须单独登记', () => {
    // ★ 踩过：TOOL_DEFS 是给外部 MCP 的清单，编排循环不读它。
    //   只登记 TOOL_DEFS 会让应用内助手"看不见"这个工具。
    expect(ORCH_SRC).toMatch(/^\s{2}meow_logs: \{/m)
    expect(ORCH_SRC).toContain('meowLogs')
  })

  it('bridge.ts：外部 MCP 壳的转发表', () => {
    expect(BRIDGE_SRC).toMatch(/meow_logs: \(a[^)]*\) =>/)
    expect(BRIDGE_SRC).toMatch(/tools\.meowLogs\(/)
  })

  it('prompt.ts：告诉模型什么场景该调它、条件由谁定', () => {
    expect(PROMPT_SRC).toContain('meow_logs')
    expect(PROMPT_SRC).toMatch(/由你判断/)
  })

  it('toolSchemas 真的把 meow_logs 暴露成 function', () => {
    const schema = toolSchemas().find((s) => s.function.name === 'meow_logs')
    expect(schema).toBeTruthy()
    const props = Object.keys(schema!.function.parameters.properties)
    expect(props).toEqual(['minLevel', 'tag', 'keyword', 'minutes', 'limit'])
    // 没有必填参数 —— 模型可以先不带条件看全局
    expect(schema!.function.parameters.required).toEqual([])
  })
})
