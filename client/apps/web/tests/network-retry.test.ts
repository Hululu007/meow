import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FIRST_RUN_RETRY_MS,
  isNetworkFailure,
  networkErrorText,
  nextRetryDelay,
} from '../src/api/networkRetry'

/**
 * TV 冷启动（尤其装完包第一次打开）时，页面比端内网关（127.0.0.1:9978）先就绪：
 * 首页 `/home`、搜索 `/search`、热播榜 `/category` 都可能撞上 —— fetch 在网络层
 * reject（没有状态码，Chromium 只给 `Failed to fetch`）。旧代码把英文原文直接贴到
 * 界面上、且不重试，用户看到"整页 Failed to fetch / 搜索失败"（2026-11-16 实测）。
 */
describe('网络级失败判定', () => {
  it('认三家浏览器的原始文案（都没有状态码）', () => {
    expect(isNetworkFailure(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isNetworkFailure(new TypeError('Load failed'))).toBe(true)
    expect(isNetworkFailure(new TypeError('Network request failed'))).toBe(true)
  })

  it('字符串形态也认（任务错误是字符串传进来的）', () => {
    expect(isNetworkFailure('Failed to fetch')).toBe(true)
    expect(isNetworkFailure('connect ECONNREFUSED 127.0.0.1:9978')).toBe(true)
  })

  it('有状态码的 HTTP 错误不认 —— 那种重试也没用', () => {
    expect(isNetworkFailure(new Error('HTTP 500'))).toBe(false)
    expect(isNetworkFailure(new Error('搜索服务不可用'))).toBe(false)
    expect(isNetworkFailure(undefined)).toBe(false)
  })
})

describe('首屏第一次请求的退避重试', () => {
  const netErr = new TypeError('Failed to fetch')

  it('第一次 + 网络失败 + 目标没变 → 500ms 后重试', () => {
    expect(nextRetryDelay({ firstRun: true, retry: 0, error: netErr, sameKeyword: true })).toBe(
      FIRST_RUN_RETRY_MS[0],
    )
  })

  it('第二次重试等到 1500ms，第三次不再重试', () => {
    expect(nextRetryDelay({ firstRun: true, retry: 1, error: netErr, sameKeyword: true })).toBe(
      FIRST_RUN_RETRY_MS[1],
    )
    expect(nextRetryDelay({ firstRun: true, retry: 2, error: netErr, sameKeyword: true })).toBeNull()
  })

  it('不是首屏第一次就不重试（之后失败基本是真挂了）', () => {
    expect(nextRetryDelay({ firstRun: false, retry: 0, error: netErr, sameKeyword: true })).toBeNull()
  })

  it('站点/关键词变了就不重试（不能拿旧目标盖新结果）', () => {
    expect(nextRetryDelay({ firstRun: true, retry: 0, error: netErr, sameKeyword: false })).toBeNull()
  })

  it('非网络错误不重试（源站/后端返回的错误重试无用）', () => {
    expect(
      nextRetryDelay({ firstRun: true, retry: 0, error: new Error('HTTP 500'), sameKeyword: true }),
    ).toBeNull()
  })
})

describe('错误文案', () => {
  it('网络失败说人话，并按页面指路到那个按钮', () => {
    const home = networkErrorText(new TypeError('Failed to fetch'), '刷新')
    expect(home).toContain('连不上后端')
    expect(home).toContain('刷新')
    expect(networkErrorText(new TypeError('Failed to fetch'), '重新搜索')).toContain('重新搜索')
    expect(home).not.toContain('Failed to fetch')
  })

  it('其它错误保留原文，空消息有兜底', () => {
    expect(networkErrorText(new Error('HTTP 500'))).toBe('HTTP 500')
    expect(networkErrorText(new Error(''))).toBe('请求失败')
  })
})

/**
 * 上面测的是模块本身；下面防"模块被 import 但没用上"（死代码 = 行为没改）。
 */
const read = (...parts: string[]) => readFileSync(join(__dirname, '..', 'src', ...parts), 'utf8')

describe('搜索页接线', () => {
  const view = read('views', 'SearchView.vue')

  it('首次搜索失败走退避重试，且不再透传英文', () => {
    expect(view).toContain('nextRetryDelay({ firstRun, retry, error: e, sameKeyword: wd.value === k })')
    expect(view).toContain('return run(force, retry + 1)')
    expect(view).not.toContain('error.value = e?.message || String(e)')
    expect(view).toContain("networkErrorText(e, '重新搜索')")
  })

  it('热播榜同样给第一次拉取退避重试', () => {
    expect(view).toContain('async function loadHot(retry = 0)')
    expect(view).toContain(
      'nextRetryDelay({ firstRun: hotFirstRun, retry, error: e, sameKeyword: true })',
    )
    expect(view).toContain('return loadHot(retry + 1)')
    expect(view).toMatch(/finally \{\s*if \(seq === hotSeq\)/)
  })
})

describe('首页接线', () => {
  const view = read('views', 'HomeView.vue')

  it('首屏 /home 失败走退避重试', () => {
    expect(view).toContain('async function loadHome(retry = 0)')
    expect(view).toContain('return loadHome(retry + 1)')
    expect(view).toMatch(/finally \{\s*if \(seq === homeSeq\)/)
  })

  it('三处 catch 都走人话文案，不再有裸 e?.message', () => {
    expect(view).not.toContain('e?.message || String(e)')
    expect(view).toContain("networkErrorText(e, '刷新')")
    expect(view).toContain("networkErrorText(e, '重试')")
  })

  it('「刷新」按钮不能把 MouseEvent 当 retry 传进去', () => {
    expect(view).toContain('@click="loadHome()"')
    expect(view).not.toMatch(/@click="loadHome"\s*\n/)
  })
})
