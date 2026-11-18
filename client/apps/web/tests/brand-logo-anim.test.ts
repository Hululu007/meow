/**
 * 品牌 logo 的「扫光动图」门禁（2026-11-18）。
 *
 * 背景：飞牛桌面/应用中心的图标是静态文件直出，只能靠**动图内容**做扫光
 * （米恋泥 fndesk 的 ICON.PNG 就是 35 帧动画 WebP）。应用内两处跟它对齐：
 *   ① 顶栏 logo —— 一直扫（和桌面图标观感一致）；
 *   ② 更新弹框里的图标 —— **只在下载/安装中扫**（= "在干活"），平时静态。
 *
 * 三条不能退：
 *  · 资产必须是**动画** WebP（不是静态图改后缀）；
 *  · URL 必须走 BASE_URL —— fpk 挂在 /app/meow/ 下，写死 /xxx 会 404；
 *  · 必须尊重 prefers-reduced-motion —— 动图 WebP 不听 CSS 的规则，只能换源。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', '..')
const web = (...p: string[]) => readFileSync(join(ROOT, 'client', 'apps', 'web', ...p), 'utf8')
const logo = join(ROOT, 'client', 'apps', 'web', 'public', 'logo-anim.webp')

// 更新弹框依赖的 store：全部替换成可控 ref（不触网、不读清单）
vi.mock('../src/stores/appUpdate', async () => {
  const { computed, ref } = await import('vue')
  return {
    busy: ref(false),
    phase: ref<'idle' | 'downloading' | 'installing' | 'done'>('idle'),
    percent: ref(0),
    stage: ref(''),
    error: ref(''),
    found: ref({
      version: '9.9.9',
      size: 1024,
      notes: '1. 测试用更新说明',
      kind: 'shell',
      lasttime: '',
    } as unknown),
    platform: computed(() => 'windows-x64'),
    closeDialog: () => true,
    runCancel: () => {},
    runDownloadAndInstall: () => {},
  }
})

import * as store from '../src/stores/appUpdate'
import UpdateDialog from '../src/components/common/UpdateDialog.vue'

/** jsdom 没有 matchMedia：按用例注入，测「开了减少动态效果」时的换源 */
function stubMatchMedia(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  ;(store.busy as unknown as { value: boolean }).value = false
  stubMatchMedia(false)
})

describe('顶栏品牌 logo 扫光动图', () => {
  it('public/logo-anim.webp 是动画 WebP（RIFF/WEBP + ANIM + 35 帧）', () => {
    const buf = readFileSync(logo)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(buf.subarray(8, 12).toString('latin1')).toBe('WEBP')
    expect(buf.includes(Buffer.from('ANIM'))).toBe(true)
    expect(buf.toString('latin1').match(/ANMF/g)?.length ?? 0).toBe(35)
  })

  it('useReducedMotion 监听 (prefers-reduced-motion: reduce)', () => {
    const src = web('src', 'composables', 'useReducedMotion.ts')
    expect(src).toContain("'(prefers-reduced-motion: reduce)'")
    expect(src).toContain('addEventListener')
    expect(src).toContain('removeEventListener')
  })

  it('顶栏用 BASE_URL 取图，且不再写死站点根路径', () => {
    const src = web('src', 'components', 'layout', 'AppHeader.vue')
    expect(src).toContain('import.meta.env.BASE_URL')
    expect(src).toContain('logo-anim.webp')
    expect(src).toContain('useReducedMotion')
    expect(src).not.toContain('src="/icon-192.png"')
  })
})

describe('更新弹框里的图标', () => {
  it('平时静态图，下载/安装中换成动图', async () => {
    const w = mount(UpdateDialog)
    expect(w.find('img').attributes('src')).toContain('icon-192.png')

    ;(store.busy as unknown as { value: boolean }).value = true
    await nextTick()
    expect(w.find('img').attributes('src')).toContain('logo-anim.webp')
    w.unmount()
  })

  it('开了 reduced-motion 时，下载中也保持静态图', async () => {
    stubMatchMedia(true)
    ;(store.busy as unknown as { value: boolean }).value = true
    const w = mount(UpdateDialog)
    expect(w.find('img').attributes('src')).toContain('icon-192.png')
    w.unmount()
  })
})
