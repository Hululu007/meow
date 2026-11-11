import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页的 `.set-sub` 是「小标题 + 说明 + 右侧动作」的单行标题栏
 * （宽屏 flex row，窄屏 column）。它只能当标题行，不能拿来当整块内容容器。
 *
 * 2026-11-11 排查「该换行没生效」时发现两处同类问题：
 *   - UpdateCenter 根容器误用 `.set-sub`，首行和“最近检查”被拉到标题行；
 *   - GitAccelPanel 根容器误用 `.set-sub`，令牌说明被排到输入框右边。
 * 两处都改成普通块级容器 + 显式字号/颜色。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const GIT = join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'common', 'GitAccelPanel.vue')
const CENTER = join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'common', 'UpdateCenter.vue')
const FPK = join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'common', 'FpkUpgradePanel.vue')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')

describe('设置页面板根容器不许复用 .set-sub', () => {
  it('GitHub 加速面板：内容块用普通块级容器', () => {
    const src = readFileSync(GIT, 'utf8')
    expect(src, '根容器又变成 flex 标题栏，说明会被排到输入框右边').not.toContain(
      'class="set-sub mt-3 border-t border-line pt-3" data-git-accel',
    )
    expect(src).toContain('text-[11px] text-ink-2" data-git-accel')
  })

  it('更新中心：内容块用普通块级容器', () => {
    const src = readFileSync(CENTER, 'utf8')
    expect(src).not.toContain('class="set-sub mt-3 border-t border-line pt-3"')
    expect(src).toContain('text-[11px] text-ink-2" data-update-center')
  })

  it('应用更新源 / fpk 内容与标题左对齐，不再额外缩进两格', () => {
    /*
     * 实测（2026-11-11 TV）：内容块还带着 `px-4`，而标题行没有，
     * 于是「已是最新版本 / 更新源 / 备用源」整体右移 16px，
     * 看起来像凭空多了两个空格。内容块自己的上下留白保留即可。
     */
    expect(readFileSync(SETTINGS, 'utf8')).not.toContain('class="px-4 pb-3 text-[12px]"')
    expect(readFileSync(FPK, 'utf8')).not.toContain('class="px-4 pb-3')
  })
})
