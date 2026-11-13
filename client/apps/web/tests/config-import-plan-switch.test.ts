/**
 * 源导入的「先看结果，再选怎么并」（2026-11-13）。
 *
 * 原来的顺序是：地址 → 导入方式/同名站点/jar → 读取 → 预览 → 确认。
 * 等于让用户在看结果之前先承诺怎么并；而切策略会清空预览、只能重新联网读取，
 * 于是「比较追加 vs 替换」这一步在界面上根本做不到。
 *
 * 现在的契约：
 *  1. 后端 dryRun 一次返回四套 diff（plans），前端切策略**只换索引**：
 *     不清预览、不重新请求。
 *  2. 模板顺序 = 读到什么 → 这次怎么并 → 这样并会 → 确认导入。
 *  3. 老后端没有 plans 时，切过策略就把「确认导入」挡掉（数字已过期）。
 *
 * 这些都是纯字符串/顺序约定，typecheck 与运行时都发现不了，只能锁在源码层面。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const view = readFileSync(join(SRC, 'views', 'SettingsView.vue'), 'utf8')
const api = readFileSync(join(SRC, 'api', 'index.ts'), 'utf8')

/** 只取「搜索与源」这一段，避免命中直播源/维护区里的同名文案 */
const section = (() => {
  const start = view.indexOf('<section data-sec="source"')
  const end = view.indexOf('<section data-sec="live"')
  expect(start, '找不到搜索与源 section').toBeGreaterThan(-1)
  expect(end, '找不到 live section，切片失效').toBeGreaterThan(start)
  return view.slice(start, end)
})()

describe('源导入：读完再选策略', () => {
  it('API 类型里有 plans，merge 按冲突策略分三份', () => {
    expect(api).toContain('plans?: {')
    expect(api).toContain('Partial<Record<ImportConflict, ConfigImportDiff>>')
    expect(api).toContain('replace?: ConfigImportDiff')
  })

  it('diff 从 plans 取，老后端回退到读取时那份', () => {
    expect(view).toContain('p.plans?.merge?.[importConflict.value]')
    expect(view).toContain('p.plans?.replace')
    expect(view).toContain('return fromPlans || p.diff')
  })

  it('切换导入方式不再清空预览（只是换索引）', () => {
    expect(section).toContain('@click="importMode = \'merge\'"')
    expect(section).toContain('@click="importMode = \'replace\'"')
    expect(section).toContain('@click="importConflict = o.value as ImportConflict"')
    // 三处都不许再带 cfgPreview = null —— 带了就等于"切一次重读一次"
    expect(section).not.toContain('importMode = \'merge\'; cfgPreview = null')
    expect(section).not.toContain('importMode = \'replace\'; cfgPreview = null')
    expect(section).not.toContain('o.value as ImportConflict; cfgPreview = null')
  })

  it('jar 复选框也不再清预览（它不影响 diff，只影响写入的 spider 字段）', () => {
    expect(section).not.toContain('@change="cfgPreview = null"')
  })

  it('模板顺序：读到什么 → 怎么并 → 这样并会 → 确认导入', () => {
    // 用带标签的完整片段定位：裸词会命中注释里的说明文字
    const readAt = section.indexOf('{{ cfgPreview.sites }} 个可用站')
    const strategyAt = section.indexOf('<span class="w-16 shrink-0 text-ink-3">导入方式</span>')
    const resultAt = section.indexOf('<span class="font-medium text-ink">这样并会</span>')
    const confirmAt = section.indexOf("{{ cfgBusy ? '写入中…' : '确认导入' }}")
    expect(readAt).toBeGreaterThan(-1)
    expect(strategyAt).toBeGreaterThan(readAt)
    expect(resultAt).toBeGreaterThan(strategyAt)
    expect(confirmAt).toBeGreaterThan(resultAt)
  })

  it('策略控件只在读完之后出现（在 cfgPreview 卡片内部）', () => {
    const cardAt = section.indexOf('data-cfg-preview')
    const strategyAt = section.indexOf('<span class="w-16 shrink-0 text-ink-3">导入方式</span>')
    const confirmAt = section.indexOf("{{ cfgBusy ? '写入中…' : '确认导入' }}")
    expect(cardAt).toBeGreaterThan(-1)
    expect(strategyAt).toBeGreaterThan(cardAt)
    expect(confirmAt).toBeGreaterThan(strategyAt)
  })

  it('确认按钮写清按哪个策略执行，且旧后端切换后禁用', () => {
    expect(section).toContain('{{ cfgApplyLabel }}')
    expect(view).toContain(':disabled="cfgBusy || cfgPlanStale"')
  })
})
