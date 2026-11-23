import { describe, it, expect } from 'vitest'
import router from '../src/router'

/**
 * 路由兜底（2026-11-23 实报「内容区黑屏、点 logo 才恢复」）。
 *
 * 顶栏是 App 外壳、永远渲染；路由没匹配时 <router-view> 是空的。
 * `#/home` 是自动化脚本/旧书签里常见的错路径（真实首页是 `/`），
 * 必须落到首页而不是白屏。
 */
describe('路由兜底', () => {
  it('#/home 落到首页', async () => {
    await router.push('/home')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('未知路径落到首页', async () => {
    await router.push('/no-such-page-xyz')
    expect(router.currentRoute.value.path).toBe('/')
  })
})
