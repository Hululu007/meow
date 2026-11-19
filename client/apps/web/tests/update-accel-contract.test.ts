/**
 * 更新加速的三条公共契约（2026-11-19 收口）：
 *
 *  ① 数值契约 `ACCEL_LIMITS` —— PC(curl)/TV(OkHttp)/Web(fetch) 三端同一份阈值；
 *  ② 成功线路记忆 —— 只降级失败（冷却）不够，还要"记住上次能用的"；
 *  ③ 并发竞速 —— 清单/索引用并发取首个**内容合法**的，但**排除 jsDelivr**
 *     （CDN 小时级缓存会抢答旧清单，把「有新版本」判成「已是最新」）。
 *
 * 这三条都是"改动小、但踩错就退化成慢或漏报"的地方，所以单独锁住。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACCEL_LIMITS,
  accelRaceDisabled,
  accelSlowDisabled,
  DEFAULT_GIT_ACCEL,
  gitAccelCandidates,
  isLineTooSlow,
  markAccelResult,
  raceFirst,
  rememberAccelWinner,
  resetAccelMemory,
  resetGitAccelHealth,
  resetWarmHosts,
  warmUpdateHosts,
  type AccelCandidate,
} from '../src/api/gitAccel'

const RAW = 'https://raw.githubusercontent.com/upchr/meow/main/packages.json'

function ids(url = RAW, index = true): string[] {
  return gitAccelCandidates(url, DEFAULT_GIT_ACCEL, { for: 'appUpdate', index }).map(
    (c) => c.proxyId || 'direct-or-unknown',
  )
}

beforeEach(() => {
  localStorage.clear()
  resetAccelMemory()
  resetGitAccelHealth()
  resetWarmHosts()
  document.head.innerHTML = ''
})

describe('数值契约 ACCEL_LIMITS（三端同一份）', () => {
  it('阈值与文档一致：20MB / 32KB/s × 8s / 5MB 起判 / 竞速 3 条', () => {
    expect(ACCEL_LIMITS.jsdelivrMaxBytes).toBe(20_000_000)
    expect(ACCEL_LIMITS.slowSpeedBps).toBe(32 * 1024)
    expect(ACCEL_LIMITS.slowWindowMs).toBe(8000)
    expect(ACCEL_LIMITS.slowMinBytes).toBe(5 * 1024 * 1024)
    expect(ACCEL_LIMITS.raceMaxCandidates).toBe(3)
  })

  it('≥20MB 的文件不再生成 jsDelivr 候选；<20MB 才有', () => {
    const big = gitAccelCandidates(RAW, DEFAULT_GIT_ACCEL, {
      for: 'appUpdate',
      size: ACCEL_LIMITS.jsdelivrMaxBytes,
    }).map((c) => c.proxyId)
    expect(big).not.toContain('jsdelivr')

    const small = gitAccelCandidates(RAW, DEFAULT_GIT_ACCEL, {
      for: 'appUpdate',
      size: ACCEL_LIMITS.jsdelivrMaxBytes - 1,
    }).map((c) => c.proxyId)
    expect(small).toContain('jsdelivr')
  })
})

describe('低速判定（三端同一口径）', () => {
  it('窗口平均 < 32KB/s 判慢；到线就判过', () => {
    // 8 秒 200KB ≈ 25KB/s → 慢
    expect(isLineTooSlow(200 * 1024, 8000)).toBe(true)
    // 8 秒 512KB = 64KB/s → 不慢
    expect(isLineTooSlow(512 * 1024, 8000)).toBe(false)
    // 正好 32KB/s（8 秒 256KB）→ 不算慢（严格小于才换）
    expect(isLineTooSlow(ACCEL_LIMITS.slowSpeedBps * 8, 8000)).toBe(false)
    // 非法窗口（0ms）→ 不判慢，避免首包瞬间误杀
    expect(isLineTooSlow(0, 0)).toBe(false)
  })
})

describe('成功线路记忆', () => {
  it('记住的线路被提到直连之后，且不影响另一类（index / file 分开记）', () => {
    // 索引类：jsDelivr 有入场资格；文件类不知道大小时没有（原行为）
    expect(ids(RAW, true)).toEqual(['direct', 'gh-proxy', 'ghfast', 'ghproxy-net', 'jsdelivr'])
    expect(ids(RAW, false)).toEqual(['direct', 'gh-proxy', 'ghfast', 'ghproxy-net'])

    rememberAccelWinner('index', { url: 'x', baseUrl: 'x', proxyId: 'ghfast' } as AccelCandidate)
    expect(ids(RAW, true)).toEqual(['direct', 'ghfast', 'gh-proxy', 'ghproxy-net', 'jsdelivr'])
    // 文件类没记过 → 原顺序（不受 index 记忆影响）
    expect(ids(RAW, false)).toEqual(['direct', 'gh-proxy', 'ghfast', 'ghproxy-net'])
  })

  it('记的线路失败后，记忆立刻作废，且这条线路进冷却被暂时剔除', () => {
    rememberAccelWinner('index', { url: 'x', baseUrl: 'x', proxyId: 'ghfast' } as AccelCandidate)
    markAccelResult({ url: 'x', baseUrl: 'x', proxyId: 'ghfast' } as AccelCandidate, false)
    // 冷却期：这条线路整个不在候选里（existing 行为），其余保持默认顺序
    expect(ids(RAW, true)).toEqual(['direct', 'gh-proxy', 'ghproxy-net', 'jsdelivr'])
    // 冷却清掉后回到原顺序（记忆确实被清了，没有"提前"）
    resetGitAccelHealth()
    expect(ids(RAW, true)).toEqual(['direct', 'gh-proxy', 'ghfast', 'ghproxy-net', 'jsdelivr'])
  })

  it('jsDelivr 永远不进记忆（它的响应可能是小时级缓存）', () => {
    rememberAccelWinner('index', { url: 'x', baseUrl: 'x', proxyId: 'jsdelivr' } as AccelCandidate)
    expect(localStorage.getItem('meow.accel.best')).toBeNull()
  })
})

describe('并发竞速 raceFirst', () => {
  it('按完成顺序取第一个通过校验的（失败/非法都被跳过）', async () => {
    const calls: string[] = []
    const r = await raceFirst(
      ['a', 'b', 'c'],
      async (k) => {
        calls.push(k)
        if (k === 'a') throw new Error('挂了')
        if (k === 'b') return '<html>代理错误页</html>'
        return '{"packages":{}}'
      },
      (t) => t.startsWith('{'),
    )
    expect(r.item).toBe('c')
    expect(r.text).toContain('packages')
    expect(calls.length).toBe(3)
  })

  it('全部失败/非法 → 抛错（调用方据此落回串行兜底）', async () => {
    await expect(
      raceFirst(['a', 'b'], async () => '<html>', (t) => t.startsWith('{')),
    ).rejects.toThrow()
  })

  it('最多只发出 raceMaxCandidates 条', async () => {
    let n = 0
    await raceFirst(
      ['a', 'b', 'c', 'd', 'e'],
      async () => {
        n++
        return '{}'
      },
      () => true,
    )
    expect(n).toBe(ACCEL_LIMITS.raceMaxCandidates)
  })
})

describe('preconnect 预热', () => {
  it('只加 link 不发请求；每会话一次；可被测试重置', () => {
    warmUpdateHosts(DEFAULT_GIT_ACCEL)
    const links = [...document.head.querySelectorAll('link[rel=preconnect]')]
    expect(links.length).toBeGreaterThan(0)
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toContain('https://github.com')
    expect(hrefs).toContain('https://raw.githubusercontent.com')

    // 第二次调用不重复追加
    const before = links.length
    warmUpdateHosts(DEFAULT_GIT_ACCEL)
    expect(document.head.querySelectorAll('link[rel=preconnect]').length).toBe(before)
  })
})

describe('两个回退开关（出问题不用等发版）', () => {
  it('竞速：默认开，置 0 退回串行', () => {
    expect(accelRaceDisabled()).toBe(false)
    localStorage.setItem('meow.accel.race', '0')
    expect(accelRaceDisabled()).toBe(true)
  })

  it('低速换线：默认开，置 0 关掉（极慢但能通的网络仍能慢慢下完）', () => {
    expect(accelSlowDisabled()).toBe(false)
    localStorage.setItem('meow.accel.slow', '0')
    expect(accelSlowDisabled()).toBe(true)
  })
})
