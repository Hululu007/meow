import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 更新中心的“状态 / 按钮”契约（2026-11-11 用户截图）。
 *
 * 用户原话：「这个怎么有，检查全部 右侧还有检查。还有未安装 未检查。是否合理」。
 * 截图里三处确实不合理：
 *   1. 壳已经「已是最新」，行内还留一个「检查」——和顶部「检查全部」重复；
 *   2. 模块行同时出现「未安装」和「未检查」——版本未知被当成未安装，
 *      再叠一条未检查；实际模块可能正在运行；
 *   3. 「最近检查」把 TV 上根本不存在的「插件 / fpk」也列出来，
 *      而且模块那一项是上次会话留下的时间戳，和本次「未检查」自相矛盾。
 *
 * 这里按源码契约锁住改法，避免以后又退回去。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const CENTER = join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'common', 'UpdateCenter.vue')
const STORE = join(ROOT, 'client', 'apps', 'web', 'src', 'stores', 'updateCenter.ts')

describe('更新中心：状态不重复、按钮不重复', () => {
  const src = readFileSync(CENTER, 'utf8')

  it('模块版本未知显示 —，不拿「未安装」顶替', () => {
    expect(src).toContain("{{ moduleCurrent || '—' }}")
    expect(src, '版本单元格又用未安装冒充未知状态').not.toContain(
      "{{ moduleCurrent || '未安装' }}",
    )
  })

  it('模块只显示一条状态：未安装 / 未检查 / 已是最新', () => {
    const at = src.indexOf('const moduleLabel')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 420)
    expect(block, '未安装判断被未检查挡住了').toMatch(
      /!moduleInstalled\.value\) return '未安装'/,
    )
    expect(block, '比对版本与读安装状态共用一个标志').toContain('!moduleUpdateChecked.value')
  })

  it('已是最新时不再显示行内「检查」', () => {
    expect(src, '壳已检查后按钮还在').toContain('v-else-if="!updChecked || updError"')
    expect(src, '模块已比对后按钮还在').toContain(
      'v-else-if="!moduleUpdateChecked || errors.module"',
    )
  })

  it('模块未安装时给「去安装」，不要求先检查', () => {
    expect(src).toContain('v-else-if="moduleChecked && !moduleInstalled"')
    const at = src.indexOf('v-else-if="moduleChecked && !moduleInstalled"')
    expect(src.slice(at, at + 320), '未安装却只给检查').toContain('去安装')
  })

  it('最近检查只列当前端、本次会话真的查过的渠道', () => {
    expect(src).toContain("if (tv && moduleUpdateChecked.value)")
    expect(src).toContain("if (desktop && pluginChecked.value)")
    expect(src).toContain('if (!desktop && !tv && fpkVisible.value && fpkChecked.value)')
    expect(src, '没有按 lastParts 条件渲染').toContain('v-if="lastParts.length"')
  })

  it('打开更新中心先读本地模块状态（不发网络请求）', () => {
    expect(src).toContain('hydrateModuleState()')
    const store = readFileSync(STORE, 'utf8')
    const at = store.indexOf('export function hydrateModuleState')
    expect(at).toBeGreaterThan(-1)
    const block = store.slice(at, at + 700)
    expect(block, '读状态却发了网络请求').not.toContain('fetch(')
    expect(block).toContain('moduleState?.()')
  })

  it('根容器不能用 .set-sub（它是横向 flex，说明会被排到行尾）', () => {
    /*
     * 实测（2026-11-11 TV）：行内按钮变少后，说明文字不再换行，
     * 直接被 flex 排到「运行时模块」那一行的最右边。根容器改成普通块级。
     */
    expect(src).not.toContain('class="set-sub mt-3 border-t border-line pt-3"')
    expect(src).toContain('text-[11px] text-ink-2" data-update-center')
  })
})
