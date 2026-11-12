import { describe, it, expect } from 'vitest'
import {
  COMMANDS,
  TOOL_LABEL,
  completeCommand,
  matchCommands,
  parseCommand,
  parseLogsArg,
  toolLabel,
} from '../src/ai/commands'
import { TOOL_DEFS } from '../src/ai/tools'

/**
 * 斜杠命令（用户主动调用工具链的入口）。
 *
 * 这个模块的价值是"确定性、零 token、没配模型也能跑"，所以测试重点在
 * **什么时候该拒绝**：不是命令的输入必须返回 null，让调用方原样回落
 * 到 intent + 多轮编排 —— 任何误吞都会把自然语言输入变成"没反应"。
 */

describe('parseCommand：认得出的', () => {
  it('中文命令 + 参数', () => {
    const r = parseCommand('/搜索 庆余年')
    expect(r?.spec.name).toBe('搜索')
    expect(r?.arg).toBe('庆余年')
  })

  it('别名与小写（/s 等价于 /搜索）', () => {
    expect(parseCommand('/s 庆余年')?.spec.name).toBe('搜索')
    expect(parseCommand('/SEARCH 庆余年')?.spec.name).toBe('搜索')
    expect(parseCommand('/p 庆余年')?.spec.name).toBe('播放')
    expect(parseCommand('/logs')?.spec.name).toBe('日志')
  })

  it('无参数命令', () => {
    const r = parseCommand('/诊断')
    expect(r?.spec.name).toBe('诊断')
    expect(r?.arg).toBe('')
  })

  it('参数里可以带空格（片名本身含空格）', () => {
    expect(parseCommand('/播放 我不是 大师 第3集')?.arg).toBe('我不是 大师 第3集')
  })

  it('全角斜杠与全角空格也认', () => {
    // 中文输入法下 ／ 极容易打出来，不归一用户会觉得"我打了却没反应"
    expect(parseCommand('／搜索　庆余年')?.spec.name).toBe('搜索')
    expect(parseCommand('／搜索　庆余年')?.arg).toBe('庆余年')
  })

  it('首尾空白不影响', () => {
    expect(parseCommand('  /搜索 庆余年  ')?.arg).toBe('庆余年')
  })
})

describe('parseCommand：必须拒绝的', () => {
  it('普通自然语言', () => {
    expect(parseCommand('播放庆余年')).toBeNull()
    expect(parseCommand('那就放它吧')).toBeNull()
  })

  it('只有一个斜杠', () => {
    // 用户刚打出 "/" 时还是候选态，不能当成命令执行
    expect(parseCommand('/')).toBeNull()
    expect(parseCommand('/   ')).toBeNull()
  })

  it('不认识的命令名（不能猜）', () => {
    expect(parseCommand('/state')).toBeNull()
    expect(parseCommand('/meow_search 庆余年')).toBeNull()
    expect(parseCommand('/xyz')).toBeNull()
  })

  it('空输入', () => {
    expect(parseCommand('')).toBeNull()
  })
})

describe('matchCommands：补全候选', () => {
  it('裸斜杠给全部', () => {
    expect(matchCommands('/')).toHaveLength(COMMANDS.length)
  })

  it('按前缀过滤（中文与别名都算）', () => {
    expect(matchCommands('/搜').map((c) => c.name)).toEqual(['搜索'])
    expect(matchCommands('/s').map((c) => c.name)).toContain('搜索')
    expect(matchCommands('/d').map((c) => c.name)).toEqual(['诊断'])
  })

  it('已经开始填参数 → 不再提示（否则挡住消息区，还会抢走上下键）', () => {
    expect(matchCommands('/搜索 庆余年')).toEqual([])
    expect(matchCommands('/搜索 ')).toEqual([])
  })

  it('不以斜杠开头 → 不提示', () => {
    expect(matchCommands('搜索')).toEqual([])
    expect(matchCommands('')).toEqual([])
  })

  it('没有匹配项时返回空（不是全部）', () => {
    expect(matchCommands('/zzz')).toEqual([])
  })
})

describe('completeCommand：选中后填回输入框', () => {
  it('有参数的命令补一个空格', () => {
    expect(completeCommand(COMMANDS.find((c) => c.name === '搜索')!)).toBe('/搜索 ')
  })

  it('无参数的命令不补空格（选中即执行）', () => {
    expect(completeCommand(COMMANDS.find((c) => c.name === '诊断')!)).toBe('/诊断')
  })
})

describe('parseLogsArg：级别 / 关键词 / tag: 前缀', () => {
  it('空参数 → 不过滤', () => {
    expect(parseLogsArg('')).toEqual({})
  })

  it('裸级别', () => {
    expect(parseLogsArg('warn')).toEqual({ minLevel: 'warn' })
    expect(parseLogsArg('ERROR')).toEqual({ minLevel: 'error' })
  })

  it('中文级别', () => {
    expect(parseLogsArg('错误')).toEqual({ minLevel: 'error' })
    expect(parseLogsArg('警告')).toEqual({ minLevel: 'warn' })
  })

  it('级别 + 关键词（剩余词一律当关键词，模糊匹配正文与标签）', () => {
    expect(parseLogsArg('error 播放')).toEqual({ minLevel: 'error', keyword: '播放' })
  })

  it('tag: 前缀走精确匹配', () => {
    expect(parseLogsArg('tag:req')).toEqual({ tag: 'req' })
    expect(parseLogsArg('warn tag:req')).toEqual({ minLevel: 'warn', tag: 'req' })
  })

  it('关键词可以多词（空格拼回一个串）', () => {
    expect(parseLogsArg('播放 失败')).toEqual({ keyword: '播放 失败' })
  })

  it('级别只认第一个（多写不叠加）', () => {
    expect(parseLogsArg('warn error')).toEqual({ minLevel: 'warn', keyword: 'error' })
  })
})

/**
 * ★ 防漂移门禁：新增 `meow_*` 工具时必须补中文标签。
 *
 * 没有这道门禁，`trace` 会在界面上冒出 `meow_xxx` —— 用户看到的是内部名字，
 * 和命令列表里的「搜索/诊断」两套叫法并存。
 */
describe('TOOL_LABEL 与 TOOL_DEFS 同步', () => {
  it('每个工具都有中文标签', () => {
    const missing = TOOL_DEFS.map((t) => t.name).filter((n) => !TOOL_LABEL[n])
    expect(missing, `缺中文标签：${missing.join('、')}`).toEqual([])
  })

  it('标签里不留 meow_ 前缀（那是给模型看的实现名）', () => {
    for (const [name, label] of Object.entries(TOOL_LABEL)) {
      expect(label, `${name} 的标签还是内部名`).not.toMatch(/^meow_/)
    }
  })

  it('未知名字原样返回，不能显示空白', () => {
    expect(toolLabel('meow_unknown')).toBe('meow_unknown')
    expect(toolLabel('meow_search')).toBe('搜索')
  })
})
