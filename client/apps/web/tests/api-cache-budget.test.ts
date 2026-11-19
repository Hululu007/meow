import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 后端内存缓存的**容量预算**（2026-11-19）。
 *
 * 背景：TtlCache 的 map 是 accessOrder=true 的 LinkedHashMap。
 * 淘汰循环里若用 map.get(victimKey) 取 value，这次 get 会把键记成一次访问
 * 并令 modCount++，紧接着 it.remove() 抛 ConcurrentModificationException；
 * 而 put 已经把新条目写进去了 —— 结果是**每次超限都只抛异常、从不淘汰**。
 * 实测 NAS 512m 堆上缓存涨到 31 条 / 12.6M 字符（上限是 8 条 / 16M）。
 * 这条门禁锁住“用 entrySet 迭代器取值”的写法，别改回去。
 */
const API = join(__dirname, '..', '..', '..', '..', 'server', 'host', 'src', 'shared', 'ApiServer.java')
const src = readFileSync(API, 'utf8')

describe('TtlCache 双预算真的能淘汰', () => {
  const i = src.indexOf('synchronized void put(String key, String value, long ttlMs)')
  const body = src.slice(i, i + 1400)

  it('淘汰循环用 entrySet 迭代器，不在循环里 map.get', () => {
    expect(i, '找不到 TtlCache.put').toBeGreaterThan(0)
    expect(body, '没用 entrySet 迭代器').toContain('map.entrySet().iterator()')
    // map.get 在 accessOrder 的 LinkedHashMap 上会改 modCount → it.remove() 抛 CME
    expect(body).not.toContain('map.get(victimKey);')
  })

  it('弹幕缓存上限是 8 条 / 16M 字符', () => {
    expect(src).toContain('DANMAKU_CACHE = new TtlCache(8, 16_000_000L)')
  })

  it('搜索缓存写入口加锁（LinkedHashMap 不支持并发 put）', () => {
    expect(src).toMatch(/synchronized void put\(String site, String wd, String pg, String value\)/)
  })
})
