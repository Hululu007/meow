import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearLineHealth,
  getLineHealth,
  lineBudget,
  lineScore,
  noteLineFail,
  noteLineOk,
  sortLinesByHealth,
} from '../src/stores/lineHealth'
import {
  clearLiveHealth,
  isLiveBad,
  liveHealthOf,
  noteLiveFail,
  noteLiveOk,
  sortLiveByHealth,
} from '../src/stores/liveHealth'

describe('线路健康（#16）：失败记忆/短看门狗/排序', () => {
  beforeEach(() => {
    localStorage.clear()
    clearLineHealth()
  })

  it('未验证线路用默认看门狗（不误杀 4K 冷启动 10–14s）', () => {
    expect(lineBudget('s', 'A')).toEqual({ startup: 0, stall: 0 })
  })

  it('连续失败 2 次且从未成功 → 8s/6s 短预算', () => {
    noteLineFail('s', 'A')
    noteLineFail('s', 'A')
    expect(getLineHealth('s', 'A')?.fail).toBe(2)
    expect(lineBudget('s', 'A')).toEqual({ startup: 8_000, stall: 6_000 })
  })

  it('成功一次把失败折半：源修好后不被旧失败压太久', () => {
    noteLineFail('s', 'A')
    noteLineFail('s', 'A')
    noteLineOk('s', 'A')
    const e = getLineHealth('s', 'A')
    expect(e?.ok).toBe(1)
    expect(e?.fail).toBe(1)
    // 1 成功 1 失败 → 未达"失败占多数"，回默认预算
    expect(lineBudget('s', 'A')).toEqual({ startup: 0, stall: 0 })
  })

  it('排序：稳定成功的在前、未验证中间、全失败最后', () => {
    for (let i = 0; i < 3; i++) noteLineOk('s', 'GOOD')
    for (let i = 0; i < 4; i++) noteLineFail('s', 'BAD')
    const list = [{ name: 'BAD' }, { name: 'NEW' }, { name: 'GOOD' }]
    expect(sortLinesByHealth('s', list).map((x) => x.name)).toEqual(['GOOD', 'NEW', 'BAD'])
    expect(lineScore('s', 'GOOD')).toBeGreaterThan(lineScore('s', 'NEW'))
    expect(lineScore('s', 'NEW')).toBeGreaterThan(lineScore('s', 'BAD'))
  })

  it('按站隔离：A 站的失败不影响 B 站同名线路', () => {
    noteLineFail('siteA', '线路1')
    noteLineFail('siteA', '线路1')
    expect(lineBudget('siteA', '线路1').startup).toBe(8_000)
    expect(lineBudget('siteB', '线路1').startup).toBe(0)
  })
})

describe('直播频道健康（#1）：单次不判死、24h TTL、坏台排后', () => {
  beforeEach(() => {
    localStorage.clear()
    clearLiveHealth()
  })

  it('单次失败不灰显，连续 2 次才判"上次不可播"', () => {
    noteLiveFail('CCTV-1')
    expect(isLiveBad('CCTV-1')).toBe(false)
    noteLiveFail('CCTV-1')
    expect(isLiveBad('CCTV-1')).toBe(true)
  })

  it('成功一次清掉失败计数（源修好了就不灰）', () => {
    noteLiveFail('CCTV-1')
    noteLiveFail('CCTV-1')
    noteLiveOk('CCTV-1')
    expect(liveHealthOf('CCTV-1')?.fails).toBe(0)
    expect(isLiveBad('CCTV-1')).toBe(false)
  })

  it('超过 24h 的旧记录自动失效（不许永久判死）', () => {
    localStorage.setItem(
      'meow.live.health.v1',
      JSON.stringify({
        OLD: { fails: 9, lastFailAt: Date.now() - 25 * 3600 * 1000, lastOkAt: 0 },
      }),
    )
    expect(liveHealthOf('OLD')).toBeNull()
    expect(isLiveBad('OLD')).toBe(false)
  })

  it('排序：坏台挪到末尾，其余保持原顺序', () => {
    noteLiveFail('B')
    noteLiveFail('B')
    const list = [{ name: 'A' }, { name: 'B' }, { name: 'C' }]
    expect(sortLiveByHealth(list).map((x) => x.name)).toEqual(['A', 'C', 'B'])
  })
})
