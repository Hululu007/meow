/**
 * 顶栏同步徽标 / 中间档挤压的回归门禁（2026-11-12）。
 *
 * 实测（tmp/2026-11-12-sync-indicator）：徽标 69–80px 且 shrink-0，
 * 在 640–1023 会把搜索输入框压到 34–38px（只剩放大镜），1024 会把
 * 站点名压到 20px。修法：
 *  ① 徽标文字只在 ≥1024 显示，窄屏只留图标；
 *  ③ 「设置」在 <768 撤出顶栏、由「更多」菜单兜住（<640 有底部标签栏）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', 'src')
const header = readFileSync(join(SRC, 'components', 'layout', 'AppHeader.vue'), 'utf8')

describe('顶栏同步徽标', () => {
  it('文字只在 xl（≥1280）显示，窄屏只留图标（title 里保留全文）', () => {
    expect(header).toContain('<span class="hidden xl:inline">{{ syncHint.text }}</span>')
    expect(header).toContain(':title="syncHint.title"')
    // 回退标志：裸文本会让徽标在窄屏占 69–80px
    expect(header).not.toMatch(/\n\s*\{\{ syncHint\.text \}\}\n/)
  })
})

describe('中间档（640–1023）不再挤压搜索框', () => {
  it('顶栏「设置」从 md 起才显示', () => {
    expect(header).toContain(
      'class="hidden rounded-md px-3 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink md:block"',
    )
  })

  it('「更多」菜单在 640–767 提供设置入口（<640 交给底部标签栏）', () => {
    const menu = header.slice(header.indexOf('data-more-menu'))
    expect(menu).toContain('to="/settings"')
    expect(menu).toMatch(
      /class="hidden[^"]*sm:block"[^>]*\n\s*@click="showMore = false"/,
    )
    // 菜单本身仍只在 <768 出现
    expect(header).toContain('class="relative md:hidden" data-more-menu')
  })
})
