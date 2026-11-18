/**
 * 「关于」弹框（2026-11-18）：版本历史 + GitHub 入口。
 *
 * 这组用例锁的是**用户可见的行为**，不是实现细节：
 *  · 打开就能看到版本列表，当前版本带「当前」标记；
 *  · 拉取失败给「重试」，点了会真的再拉一次；
 *  · TV 三件套：data-tv-scope（方向键收窄）、data-tv-scroll + tabindex（能滚）；
 *  · GitHub 按钮和返回按钮各自 emit，不自己跳转（TV 上要复制链接，由页面决定）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const fetchHistory = vi.fn()

vi.mock('../src/api/changelog', () => ({
  fetchChangelogHistory: (force?: boolean) => fetchHistory(force),
}))

import AboutDialog from '../src/components/common/AboutDialog.vue'

const ROOT = join(__dirname, '..', '..', '..', '..')
const web = (...p: string[]) => readFileSync(join(ROOT, 'client', 'apps', 'web', ...p), 'utf8')

const SAMPLE = [
  { version: '1.2.16', date: '2026-11-18', lines: ['1. 修复 A', '2. 修复 B'] },
  { version: '1.2.15', lines: ['1. 修复 C'] },
]

beforeEach(() => {
  document.body.innerHTML = ''
  fetchHistory.mockReset()
  fetchHistory.mockResolvedValue(SAMPLE)
})

describe('关于弹框', () => {
  it('渲染版本列表，当前版本带「当前」标记', async () => {
    mount(AboutDialog, { props: { version: '1.2.16' } })
    await flushPromises()

    const text = document.body.textContent || ''
    expect(text).toContain('猫窝 Meow')
    expect(text).toContain('v1.2.16')
    expect(text).toContain('v1.2.15')
    expect(text).toContain('修复 C')
    // 只有和 props.version 相同的那一版有标记
    expect(document.body.querySelectorAll('.bg-accent\\/15').length).toBe(1)
  })

  it('显示发版日期；没有日期的版本不显示占位', async () => {
    mount(AboutDialog, { props: { version: '1.2.16' } })
    await flushPromises()
    const text = document.body.textContent || ''
    expect(text).toContain('2026-11-18')
    // 1.2.15 没有 date 字段：行里不应出现类似 "undefined" 的东西
    expect(text).not.toContain('undefined')
  })

  it('TV 上初始焦点交给 __meowTvFocus（pin），不是裸 focus', async () => {
    const focusSpy = vi.fn()
    ;(window as unknown as { __meowTvNav?: unknown }).__meowTvNav = () => {}
    ;(window as unknown as { __meowTvFocus?: unknown }).__meowTvFocus = focusSpy
    mount(AboutDialog, { props: { version: '1.2.16' } })
    await flushPromises()

    expect(focusSpy).toHaveBeenCalled()
    const [el, pin] = focusSpy.mock.calls[focusSpy.mock.calls.length - 1]
    expect(pin).toBe(true)
    expect((el as HTMLElement).getAttribute('data-tv-scroll')).not.toBeNull()
    delete (window as unknown as { __meowTvNav?: unknown }).__meowTvNav
    delete (window as unknown as { __meowTvFocus?: unknown }).__meowTvFocus
  })

  it('TV 三件套：data-tv-scope + data-tv-scroll + tabindex=0', async () => {
    mount(AboutDialog, { props: { version: '1.2.16' } })
    await flushPromises()

    expect(document.body.querySelector('[data-tv-scope]')).toBeTruthy()
    const scroller = document.body.querySelector('[data-tv-scroll]')
    expect(scroller, '版本历史区缺 data-tv-scroll（TV 方向键滚不动）').toBeTruthy()
    expect(scroller?.getAttribute('tabindex')).toBe('0')
  })

  it('失败给「重试」，点一下会重新拉（force=true）', async () => {
    fetchHistory.mockRejectedValueOnce(new Error('HTTP 403'))
    mount(AboutDialog, { props: { version: '1.2.16' } })
    await flushPromises()

    expect(document.body.textContent).toContain('HTTP 403')
    const retry = [...document.body.querySelectorAll('button')].find((b) =>
      (b.textContent || '').includes('重试'),
    )
    expect(retry).toBeTruthy()

    fetchHistory.mockResolvedValueOnce(SAMPLE)
    retry!.click()
    await flushPromises()
    expect(fetchHistory).toHaveBeenLastCalledWith(true)
    expect(document.body.textContent).toContain('修复 A')
  })

  it('GitHub 按钮与返回按钮只 emit，不自己跳转', async () => {
    const w = mount(AboutDialog, { props: { version: '1.2.16' } })
    await flushPromises()

    const gh = document.body.querySelector('[aria-label="项目主页"]') as HTMLButtonElement
    const back = [...document.body.querySelectorAll('button')].find((b) =>
      (b.textContent || '').trim() === '返回',
    ) as HTMLButtonElement
    expect(gh).toBeTruthy()
    expect(back).toBeTruthy()

    gh.click()
    back.click()
    await flushPromises()
    expect(w.emitted('open-project')).toHaveLength(1)
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('设置页接线', () => {
  const src = web('src', 'views', 'SettingsView.vue')

  it('「关于」tile 改成开弹框（不再直接开浏览器）', () => {
    const at = src.indexOf("key: 'about'")
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 420)
    expect(block).toContain('showAbout.value = true')
    expect(block, '「关于」还在直接开浏览器').not.toContain('openProjectPage()')
  })

  it('弹框挂载点存在，且有项目主页/关闭两个回调', () => {
    expect(src).toContain('<AboutDialog')
    expect(src).toContain('@open-project="openProjectPage()"')
    expect(src).toContain('@close="closeAbout()"')
  })

  it('Escape 分发里登记了「关于」——否则 TV 上 BACK 关不掉', () => {
    const at = src.indexOf('function onSitesKey')
    const block = src.slice(at, at + 500)
    expect(block).toContain('showAbout.value')
    expect(block).toContain('closeAbout()')
  })
})
