/**
 * 顶栏品牌 logo 的「扫光动图」门禁（2026-11-18）。
 *
 * 背景：飞牛桌面/应用中心的图标是静态文件直出，只能靠**动图内容**做扫光
 * （米恋泥 fndesk 的 ICON.PNG 就是 35 帧动画 WebP）。应用内顶栏为了和它
 * 看起来是同一样东西，也用同一套生成的动图。
 *
 * 三条不能退：
 *  ① 资产必须是**动画** WebP（不是静态图改后缀）——静态图不会有任何动效；
 *  ② URL 必须走 BASE_URL —— fpk 挂在 /app/meow/ 下，写死 /xxx 会 404；
 *  ③ 必须尊重 prefers-reduced-motion —— 动图 WebP 不听 CSS 的规则，只能换源。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', '..')
const web = (...p: string[]) => readFileSync(join(ROOT, 'client', 'apps', 'web', ...p), 'utf8')
const logo = join(ROOT, 'client', 'apps', 'web', 'public', 'logo-anim.webp')

describe('顶栏品牌 logo 扫光动图', () => {
  it('public/logo-anim.webp 是动画 WebP（RIFF/WEBP + ANIM + 35 帧）', () => {
    const buf = readFileSync(logo)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(buf.subarray(8, 12).toString('latin1')).toBe('WEBP')
    // ANIM 块（循环次数）与 ANMF（每帧）必须存在，否则只是静态 WebP
    expect(buf.includes(Buffer.from('ANIM'))).toBe(true)
    const frames = buf.toString('latin1').match(/ANMF/g)?.length ?? 0
    expect(frames).toBe(35)
  })

  it('顶栏用 BASE_URL 取图，且 reduced-motion 退回静态 PNG', () => {
    const src = web('src', 'components', 'layout', 'AppHeader.vue')
    expect(src).toContain("import.meta.env.BASE_URL")
    expect(src).toContain('logo-anim.webp')
    expect(src).toContain("'(prefers-reduced-motion: reduce)'")
    // 退回的必须是静态图，不能还是动图
    expect(src).toContain("reduceMotion.value ? 'icon-192.png' : 'logo-anim.webp'")
    // 不允许再写死站点根路径
    expect(src).not.toContain('src="/icon-192.png"')
  })
})
