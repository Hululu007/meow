import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AI 面板高度 + 菜单键绑定（2026-10-30 用户需求）。
 *
 * 用户原话：「1，AI助手面板能不能初始高一点。 2，同时分析 菜单按键绑定效果。
 * 是否能够绑定AI 助手弹框弹出。」
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const PANEL = join(REPO, 'client', 'apps', 'web', 'src', 'components', 'ai', 'AiPanel.vue')
const MENU = join(REPO, 'client', 'apps', 'web', 'src', 'stores', 'tvMenu.ts')

describe('AI 面板：要给初始高度，不能只有 max-height', () => {
  const src = readFileSync(PANEL, 'utf8')

  it('.ai-panel 有 height（不是只有 max-height）', () => {
    /*
     * 踩过：只写 max-height 时高度由内容决定，刚打开只有一句提示 + 输入框，
     * 被压成 170px 左右一条，对话区几乎看不见。
     */
    const at = src.indexOf('.ai-panel {')
    expect(at, '找不到 .ai-panel 规则').toBeGreaterThan(-1)
    const block = src.slice(at, at + 900)
    /*
     * ★ 2026-11-06 改：原来写 `height: min(70vh, 32rem)`，但 **Chrome 66
     *   （投影仪）不支持 CSS min()** → 整条声明被丢弃 → 又退回"只有 max-height"。
     *   现在拆成 `height: 32rem; max-height: 70vh`（等价、老特性可用）。
     *   断言意图不变：必须有明确的 height 初值。
     */
    expect(block, '只有 max-height 没有 height').toMatch(/\n\s+height:\s*32rem/)
    expect(block).toMatch(/\n\s+max-height:\s*70vh/)
  })

  it('TV 档也要有明确高度（10-foot UI 需要更大）', () => {
    const at = src.indexOf("html[data-tv='1'] .ai-panel")
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 400)
    expect(block).toMatch(/\n\s+height:\s*74vh/)
  })
})

describe('菜单键：无卡片动作时兜底打开 AI 助手', () => {
  const src = readFileSync(MENU, 'utf8')
  const panel = readFileSync(PANEL, 'utf8')

  it('AiPanel 暴露全局开关钩子', () => {
    // `open` 是组件内部 ref，别的模块读不到，必须显式暴露
    expect(panel).toContain('__meowAiOpen')
    expect(panel).toContain('__meowAiIsOpen')
    expect(panel).toContain('__meowAiClose')
    // 只在浮层模式暴露：独立页（/ai）本身就是 AI，再打开没意义
    expect(panel).toMatch(/if \(!props\.inline\) \{[\s\S]{0,80}__meowAiOpen/)
  })

  it('provider 优先，AI 只作兜底', () => {
    /*
     * 顺序必须是：页面钩子 → provider → AI 兜底。
     * 反过来的话，历史/收藏页在卡片上按菜单键会弹 AI 而不是卡片动作。
     */
    const at = src.indexOf('export function openTvMenuFor')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 2600)
    const providerAt = body.indexOf('cur.value = p')
    const aiAt = body.indexOf('__meowAiOpen')
    expect(providerAt, '没有 provider 分支').toBeGreaterThan(-1)
    expect(aiAt, '没有 AI 兜底').toBeGreaterThan(-1)
    expect(providerAt, 'AI 兜底写在 provider 之前 → 会抢走卡片菜单').toBeLessThan(aiAt)
  })

  it('AI 已开时再按菜单键是收起（同一个键开关）', () => {
    const at = src.indexOf('export function openTvMenuFor')
    const body = src.slice(at, at + 2600)
    expect(body).toContain('__meowAiIsOpen')
    expect(body).toContain('__meowAiClose')
  })

  it('AI 打不开时不能抛错（菜单键不能因此失效）', () => {
    const at = src.indexOf('export function openTvMenuFor')
    const body = src.slice(at, at + 2600)
    expect(body).toMatch(/try \{[\s\S]{0,60}__meowAiOpen/)
  })
})
