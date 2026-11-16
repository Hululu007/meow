import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { __resetPrefsCache } from '../src/stores/prefs'
import {
  episodeNumber,
  findHistoryByTitle,
  normTitleForMatch,
} from '../src/stores/history'

/**
 * 跨源同剧续播（2026-11-16）。
 *
 * 场景：在 A 源看了 3 集，源挂了，换 B 源详情页——原实现按 `site+vod_id`
 * 查历史，两个字段全变，进度/集数全部丢失。
 *
 * 这里锁住两个判据（数据全部来自 OECT 上真实源）：
 *   ① 片名归一化后**完全相等**才算同剧（挡掉解说版/粤语版/第一季）；
 *   ② 集号必须能解析且相等（三个真实源的集名是 第01集 / 01 [1080P] / 1）。
 */
const WEB = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8')
}

describe('片名归一化：同剧要相等，同名的别的东西不能相等', () => {
  const base = normTitleForMatch('庆余年第二季')

  it('实测的真实写法（空格/连接符/年份括号）归一后相等', () => {
    expect(normTitleForMatch('庆余年 第二季')).toBe(base)
    expect(normTitleForMatch('庆余年·第二季')).toBe(base)
    expect(normTitleForMatch('庆余年第二季 (2024)')).toBe(base)
    expect(normTitleForMatch('庆余年 第二季 (2024)')).toBe(base)
    expect(normTitleForMatch('  庆余年　第二季  ')).toBe(base)
  })

  it('同名不同物必须区分（实测聚合搜索里都出现过）', () => {
    expect(normTitleForMatch('庆余年第二季解说版')).not.toBe(base)
    expect(normTitleForMatch('庆余年第二季粤语版')).not.toBe(base)
    expect(normTitleForMatch('庆余年第二季剧情深度解读非正片')).not.toBe(base)
    expect(normTitleForMatch('庆余年第一季')).not.toBe(base)
    expect(normTitleForMatch('一口气看完《庆余年》第二季')).not.toBe(base)
  })

  it('中文数字季号归一（第二季 = 第2季），但「第2季」不等价于「2」', () => {
    expect(normTitleForMatch('庆余年第二季')).toBe(normTitleForMatch('庆余年 第2季'))
    // 保守：B 站上的「庆余年2」全是 UGC 合集，不能和正片等同
    expect(normTitleForMatch('庆余年2')).not.toBe(normTitleForMatch('庆余年第二季'))
  })

  it('空片名返回空串（调用方据此放弃兜底）', () => {
    expect(normTitleForMatch('')).toBe('')
    expect(normTitleForMatch('   ')).toBe('')
  })
})

describe('集号解析：三个真实源的集名必须解析出同一个号', () => {
  it('AppYQK / Gz360 / Gulu 的实际集名', () => {
    expect(episodeNumber('第01集')).toBe(1)
    expect(episodeNumber('01 [1080P]')).toBe(1)
    expect(episodeNumber('1')).toBe(1)
    expect(episodeNumber('第35集')).toBe(35)
  })

  it('优先认「第N集」，不被清晰度/年份数字骗到', () => {
    expect(episodeNumber('4K 第03集')).toBe(3)
    expect(episodeNumber('第12集 1080P')).toBe(12)
    expect(episodeNumber('EP07')).toBe(7)
  })

  it('没有集号的（彩蛋/预告）返回 0 → 调用方必须放弃兜底', () => {
    expect(episodeNumber('彩蛋')).toBe(0)
    expect(episodeNumber('预告')).toBe(0)
    expect(episodeNumber('')).toBe(0)
  })
})

describe('findHistoryByTitle：只认有进度的同名片，按 ep_at 倒序', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('meow.prefs', JSON.stringify({ historyLimit: 30 }))
    __resetPrefsCache()
  })

  it('同剧不同源的记录都能找到，最近真播过的排最前', () => {
    localStorage.setItem(
      'meow.history.list',
      JSON.stringify([
        {
          site: 'Gz360', siteName: '瓜子', vod_id: '60397', vod_name: '庆余年第二季',
          vod_pic: '', at: 1000, pos: 600, dur: 2700, ep: '02 [1080P]', ep_at: 1000,
        },
        {
          site: 'Gulu', siteName: '咕噜', vod_id: '364312', vod_name: '庆余年 第二季',
          vod_pic: '', at: 2000, pos: 1200, dur: 2700, ep: '3', ep_at: 2000,
        },
        {
          site: 'AppYQK', siteName: '一起看', vod_id: '153710', vod_name: '庆余年第二季解说版',
          vod_pic: '', at: 3000, pos: 900, dur: 900, ep: '第4集', ep_at: 3000,
        },
      ]),
    )
    const hits = findHistoryByTitle('庆余年第二季')
    expect(hits.map((h) => h.site)).toEqual(['Gulu', 'Gz360'])
    expect(hits[0].pos).toBe(1200)
  })

  it('只点过封面没播过的条目（无 pos）不算', () => {
    localStorage.setItem(
      'meow.history.list',
      JSON.stringify([
        { site: 'Gz360', siteName: '瓜子', vod_id: '1', vod_name: '庆余年第二季', vod_pic: '', at: 1000 },
      ]),
    )
    expect(findHistoryByTitle('庆余年第二季')).toEqual([])
  })
})

describe('源码门禁：跨源兜底的三个落点', () => {
  const detail = read('src/views/DetailView.vue')
  const play = read('src/views/PlayView.vue')
  const backend = readFileSync(
    join(WEB, '..', '..', '..', 'server', 'host', 'src', 'shared', 'ApiServer.java'),
    'utf8',
  )

  it('详情页：本片无历史时按片名兜底，并按集号定位 + 标明来处', () => {
    expect(detail).toContain('findHistoryByTitle(v.vod_name')
    expect(detail).toContain('episodeNumber(e.name) === want')
    expect(detail).toContain('来自 {{ lastWatched.from }}')
  })

  it('播放页：兜底 + 用当前这集真实 duration 再校验一次', () => {
    expect(play).toContain('findHistoryByTitle(title)')
    // 历史里的 dur 是 A 源的，B 源这集可能更短 → 必须用真实时长再挡一次
    expect(play).toMatch(/realDur > 0 && it\.pos > realDur - 10/)
  })

  it('「从头开始」要清掉兜底来源那条，否则下次又被续播回去', () => {
    expect(play).toContain('resumedFromOther')
    const i = play.indexOf('function restartFromTop')
    expect(i).toBeGreaterThan(-1)
    const body = play.slice(i, i + 900)
    expect(body).toContain('clearProgress(resumedFromOther)')
  })

  it('后端 cleanName：中文空格归一，但保留英文单词间空格', () => {
    // 判据是 lookbehind/lookahead 这两个非字母数字字符类
    expect(backend).toContain('(?<=[^A-Za-z0-9])[ \\\\t]+')
    expect(backend).toContain('[ \\\\t]+(?=[^A-Za-z0-9])')
  })
})
