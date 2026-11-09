import { describe, expect, it } from 'vitest'

/**
 * danmakuStore 的单测。
 *
 * <p>IndexedDB 在 jsdom 里不可用（`indexedDB` 是 undefined），所以这里只测
 * **在没有存储能力时的降级行为**——这恰恰是最需要保证的：存储不可用不能让
 * 播放失败。真实的读写链路已在浏览器里实测过（写入/读回/大文件拒绝/清理）。
 */
describe('弹幕本地存储的降级', () => {
  it('没有 IndexedDB 时读返回 null，不抛异常', async () => {
    const { getLocalDanmaku } = await import('../src/components/player/danmakuStore')
    await expect(getLocalDanmaku('http://x/y')).resolves.toBeNull()
  })

  it('没有 IndexedDB 时写入静默成功（不阻塞调用方）', async () => {
    const { putLocalDanmaku } = await import('../src/components/player/danmakuStore')
    await expect(putLocalDanmaku('http://x/y', '<i></i>', 0, 'test')).resolves.toBeUndefined()
  })

  it('没有 IndexedDB 时统计返回全零', async () => {
    const { localDanmakuStats } = await import('../src/components/player/danmakuStore')
    await expect(localDanmakuStats()).resolves.toEqual({ entries: 0, bytes: 0 })
  })

  it('没有 IndexedDB 时清理返回 0', async () => {
    const { clearLocalDanmaku } = await import('../src/components/player/danmakuStore')
    await expect(clearLocalDanmaku()).resolves.toBe(0)
  })
})
