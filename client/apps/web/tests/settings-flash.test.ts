import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 设置页"点导航 → 目标分区闪一下"的边界情况。
 *
 * 踩过的坑（截图实证）：先点「网络」再点「远程调试」，两个分区**同时**
 * 带高亮框。原因是 `flashSection` 只 `clearTimeout`，被清掉的那个 tick
 * 停在哪一帧就永久停在哪一帧（亮/灭交替，正好停在亮帧就常亮）。
 *
 * 这类问题纯字符串/时序问题，单测与 typecheck 都过，只能在源码层面锁住。
 */
const SETTINGS = join(__dirname, '..', 'src', 'views', 'SettingsView.vue')

function readSettings(): string {
  return readFileSync(SETTINGS, 'utf8')
}

/** 取出某个函数的函数体（从 `function name(` 到下一个顶层 `}` 行）。 */
function fnBody(src: string, name: string): string {
  const start = src.indexOf('function ' + name + '(')
  expect(start, `找不到 ${name}`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

describe('设置页闪烁高亮', () => {
  it('切换目标时清掉旧元素上的 is-flashing，而不是只清定时器', () => {
    const body = fnBody(readSettings(), 'flashSection')
    // 必须调用统一的清理函数；只写 clearTimeout 会留下常亮的旧框
    expect(body).toMatch(/clearFlash\(\)/)
  })

  it('clearFlash 同时处理"记录的当前元素"与"按类名兜底扫描"', () => {
    const body = fnBody(readSettings(), 'clearFlash')
    expect(body, '要清定时器').toMatch(/clearTimeout/)
    expect(body, '要摘掉记录中的元素').toMatch(/flashingEl\.classList\.remove\('is-flashing'\)/)
    // 兜底：tick 抛异常 / 节点被替换时，记录会失效，只能扫类名
    expect(body, '要按类名兜底清理').toMatch(/querySelectorAll<HTMLElement>\('\.is-flashing'\)/)
  })

  it('卸载时也走 clearFlash，避免下次进页面残留高亮', () => {
    const src = readSettings()
    const start = src.indexOf('onBeforeUnmount(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n})', start))
    expect(body).toMatch(/clearFlash\(\)/)
  })
})
