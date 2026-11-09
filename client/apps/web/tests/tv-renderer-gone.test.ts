import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 渲染进程崩溃不能带走整个应用（2026-11-05 实测）。
 *
 * MuMu 上页面渲染进程 SIGSEGV 后，因为壳里没有 onRenderProcessGone，
 * Chromium 直接把主进程 abort：
 *   Abort message: 'Render process (65100)'s crash wasn't handled by all
 *   associated webviews, triggering application crash.'
 * 用户看到的是"应用闪退"，实际只是网页进程死了。
 */
const MAIN = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'tv',
    'app',
    'src',
    'main',
    'java',
    'com',
    'meow',
    'tv',
    'MainActivity.java',
  ),
  'utf8',
)

describe('WebView 渲染进程崩溃兜底', () => {
  it('重写了 onRenderProcessGone 并返回 true（返回 false 会连带杀应用）', () => {
    expect(MAIN).toContain('public boolean onRenderProcessGone')
    const i = MAIN.indexOf('public boolean onRenderProcessGone')
    const body = MAIN.slice(i, i + 1600)
    expect(body).toMatch(/return true/)
    // 旧 WebView 必须销毁，否则重建后仍指向坏掉的渲染进程
    expect(body).toContain('view.destroy()')
    // 重建 Activity 拿一个全新的 WebView
    expect(body).toContain('recreate()')
  })

  it('有崩溃循环保护（连续崩不再自动重建，改走原生失败页）', () => {
    expect(MAIN).toContain('RENDERER_GONE_WINDOW_MS')
    expect(MAIN).toContain('RENDERER_GONE_MAX')
    const i = MAIN.indexOf('public boolean onRenderProcessGone')
    const body = MAIN.slice(i, i + 1800)
    expect(body).toContain('rendererGoneCount > RENDERER_GONE_MAX')
    expect(body).toContain('showLoadError')
  })
})
