import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  consumeNewEpisodes,
  getSeenRemarks,
  isUpdated,
  lastCheckedAt,
  markAllSeen,
  markChecked,
  markSeen,
  parseEpisodeCount,
  pendingUpdateCount,
  pruneRemarks,
  recordUpdateHit,
  resetUpdates,
  saveHits,
  savedHits,
  rememberRemarks,
  sessionNewEpisodes,
  shouldCheck,
  updateBaseline,
  updateDelta,
} from '@/stores/favUpdates'

/**
 * 追剧更新提醒（2026-11-05 用户要求"收藏页增加更新提醒标记"）。
 *
 * 这一组锁的是**判定与持久化**，不是 UI 长什么样：
 *  · 基线为空的老收藏也必须能提醒（否则一大批人永远看不到标记）；
 *  · 点进详情页要把"最新 remarks"记为已读（用旧的记 = 角标永远清不掉）；
 *  · 检查结果要落盘（只落"检查时间"的话，离开页面 6 小时内再回来角标全消失）。
 */
const KEY = 'meow.fav.remarks'

beforeEach(() => {
  localStorage.clear()
})

describe('isUpdated：更新判定', () => {
  it('从没收藏过的条目不提醒（没有基线可比）', () => {
    expect(isUpdated('AppRJ', '1', '全24集')).toBe(false)
  })

  it('收藏时源站没给 remarks（基线空）、现在有了 → 算更新', () => {
    rememberRemarks('AppRJ', '1', '')
    expect(isUpdated('AppRJ', '1', '全24集')).toBe(true)
  })

  it('同一句 remarks 不算更新', () => {
    rememberRemarks('AppRJ', '1', '更新至12集')
    expect(isUpdated('AppRJ', '1', '更新至12集')).toBe(false)
  })

  it('集数变了算更新', () => {
    rememberRemarks('AppRJ', '1', '更新至12集')
    expect(isUpdated('AppRJ', '1', '更新至13集')).toBe(true)
  })

  it('现在为空不参与：源站抖动返回空不该报更新', () => {
    rememberRemarks('AppRJ', '1', '更新至12集')
    expect(isUpdated('AppRJ', '1', '')).toBe(false)
    expect(isUpdated('AppRJ', '1', '   ')).toBe(false)
  })

  it('反复点收藏不会把新集数写成基线（否则永不提醒）', () => {
    rememberRemarks('AppRJ', '1', '更新至12集')
    rememberRemarks('AppRJ', '1', '更新至20集')
    expect(getSeenRemarks('AppRJ', '1')).toBe('更新至12集')
    expect(isUpdated('AppRJ', '1', '更新至20集')).toBe(true)
  })
})

describe('更新结果落盘：离开页面再回来角标还在', () => {
  it('saveHits / savedHits 往返，且存的是最新 remarks', () => {
    saveHits({ 'AppRJ|1': '全24集', 'AppDrama2|9': '更新至8集' })
    expect(savedHits()).toEqual({ 'AppRJ|1': '全24集', 'AppDrama2|9': '更新至8集' })
  })

  it('markSeen 用最新值当基线 → 该条从提醒里移除，下次也不再报', () => {
    rememberRemarks('AppRJ', '1', '更新至12集')
    saveHits({ 'AppRJ|1': '更新至13集' })
    markSeen('AppRJ', '1', '更新至13集')
    expect(savedHits()).toEqual({})
    expect(isUpdated('AppRJ', '1', '更新至13集')).toBe(false)
  })

  it('取消收藏 / 清空后 prune 会一并清掉提醒', () => {
    saveHits({ 'AppRJ|1': '全24集', 'AppRJ|2': '全12集' })
    pruneRemarks(['AppRJ|2'])
    expect(savedHits()).toEqual({ 'AppRJ|2': '全12集' })
  })

  it('老数据没有 hits 字段也能读（升级不能白屏）', () => {
    localStorage.setItem(KEY, JSON.stringify({ seen: { 'AppRJ|1': '全1集' }, at: 123 }))
    expect(savedHits()).toEqual({})
    expect(getSeenRemarks('AppRJ', '1')).toBe('全1集')
    expect(lastCheckedAt()).toBe(123)
  })

  it('6 小时节流：刚查过不再自动查，过期后才查', () => {
    markChecked()
    expect(shouldCheck()).toBe(false)
    localStorage.setItem(
      KEY,
      JSON.stringify({ seen: {}, at: Date.now() - 7 * 3600_000, hits: {} }),
    )
    expect(shouldCheck()).toBe(true)
  })
})

describe('收藏页渲染契约', () => {
  const fav = readFileSync(join(__dirname, '..', 'src', 'views', 'FavoritesView.vue'), 'utf8')

  it('状态行真的渲染出来（以前只算 checkMsg、模板里一个字都没有）', () => {
    expect(fav).toContain('statusText')
    expect(fav).toMatch(/\{\{\s*statusText\s*\}\}/)
    expect(fav).toContain('部有更新')
    expect(fav).toContain('还没检查过更新')
  })

  it('有手动「检查更新」按钮，检查中禁用', () => {
    expect(fav).toContain('检查更新')
    expect(fav).toContain('检查中…')
    expect(fav).toContain(':disabled="checking"')
    expect(fav).toContain('@click="checkUpdates()"')
  })

  it('角标状态来自落盘结果，点进详情用最新 remarks 当已读基线', () => {
    expect(fav).toContain('savedHits')
    expect(fav).toContain('saveHits')
    expect(fav).toContain('const latest = updated.value.get(k)')
    expect(fav).toContain('markSeen(it.site, it.vod_id, latest)')
  })

  it('全部请求失败时保留上一轮角标（不能把源站宕机当成"都看完了"）', () => {
    expect(fav).toContain('if (ok)')
  })
})

describe('集数解析：remarks → 集数', () => {
  it('常见形状都能抠出集数', () => {
    expect(parseEpisodeCount('全29集')).toBe(29)
    expect(parseEpisodeCount('更新至第12集')).toBe(12)
    expect(parseEpisodeCount('更新至165集')).toBe(165)
    expect(parseEpisodeCount('更新至 48 集')).toBe(48)
  })

  it('多线路时取最大值（有的源写成「更新至12集 更新至13集」）', () => {
    expect(parseEpisodeCount('更新至12集 更新至13集')).toBe(13)
  })

  it('不是集数的 remarks 抠不出来（时长、画质标签、空）', () => {
    expect(parseEpisodeCount('02:06:00')).toBeNull()
    expect(parseEpisodeCount('蓝光')).toBeNull()
    expect(parseEpisodeCount('高清')).toBeNull()
    expect(parseEpisodeCount('')).toBeNull()
    expect(parseEpisodeCount('   ')).toBeNull()
  })
})

describe('新增集数差值', () => {
  it('用收藏时的基线做减数（不是卡片角签 —— 那个已被刷成最新值）', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    expect(updateDelta('AppRJ', '1', '全29集')).toBe(19)
  })

  it('基线抠不出集数时不给差值（返回 null，不瞎报）', () => {
    rememberRemarks('AppRJ', '1', '蓝光')
    expect(updateDelta('AppRJ', '1', '全29集')).toBeNull()
    rememberRemarks('AppRJ', '2', '全10集')
    expect(updateDelta('AppRJ', '2', '蓝光')).toBeNull()
  })

  it('从没收藏过的不给差值', () => {
    expect(updateDelta('AppRJ', '9', '全29集')).toBeNull()
  })
})

describe('已读 / 重置更新态', () => {
  it('全部已读：清角标 + 基线推到最新（下轮不重复报）', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    rememberRemarks('AppRJ', '2', '全5集')
    saveHits({ 'AppRJ|1': '全29集', 'AppRJ|2': '全8集' })
    expect(pendingUpdateCount()).toBe(2)
    const n = markAllSeen()
    expect(n).toBe(2)
    expect(pendingUpdateCount()).toBe(0)
    // 基线推到了最新 → 再检查不会报更新
    expect(getSeenRemarks('AppRJ', '1')).toBe('全29集')
    expect(isUpdated('AppRJ', '1', '全29集')).toBe(false)
  })

  it('重置更新态：只清角标，基线不动（下轮有新集数仍会报）', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    saveHits({ 'AppRJ|1': '全29集' })
    const n = resetUpdates()
    expect(n).toBe(1)
    expect(pendingUpdateCount()).toBe(0)
    expect(getSeenRemarks('AppRJ', '1')).toBe('全10集')
    expect(isUpdated('AppRJ', '1', '全29集')).toBe(true)
  })

  it('没有更新时这两个操作都是 0（幂等）', () => {
    expect(markAllSeen()).toBe(0)
    expect(resetUpdates()).toBe(0)
  })
})

describe('顶栏角标（性能判据）', () => {
  const header = readFileSync(join(__dirname, '..', 'src', 'components', 'layout', 'AppHeader.vue'), 'utf8')

  it('角标只读模块级缓存，不解析 localStorage、不发请求', () => {
    expect(header).toContain('pendingUpdateCount')
    // 不能在顶栏里直接 localStorage.getItem（那是每次导航都做一遍的活）
    expect(header).not.toMatch(/localStorage\.getItem\('meow\.fav/)
    expect(header).not.toContain('fetchDetail')
  })

  it('检查结果变化时通过事件刷新（不轮询）', () => {
    expect(header).toContain('meow:fav-updates-changed')
    expect(header).toContain('onFavUpdatesChanged')
  })

  it('桌面顶栏是红点，手机「更多」菜单里是文字计数', () => {
    expect(header).toContain('bg-hot')
    expect(header).toContain('部有新集数')
  })
})

describe('收藏页：新增集数与已读按钮', () => {
  const fav = readFileSync(join(__dirname, '..', 'src', 'views', 'FavoritesView.vue'), 'utf8')

  it('角标上显示新增几集（+N）', () => {
    expect(fav).toContain('deltaText')
    expect(fav).toContain('updateDelta')
  })

  it('状态药丸汇总新增集数', () => {
    expect(fav).toContain('共 +')
  })

  it('有「全部已读」和「重置更新态」两个按钮', () => {
    expect(fav).toContain('全部已读')
    expect(fav).toContain('重置更新态')
    expect(fav).toContain('markAllRead()')
    expect(fav).toContain('resetUpdateState()')
  })

  it('★ 自动检查已删（2026-11-06 用户定调：追剧用户走历史，不进收藏页）', () => {
    expect(fav).not.toContain('maybeCheck')
    expect(fav).not.toContain('setTimeout')
    // 手动检查保留
    expect(fav).toContain('检查更新')
  })
})

describe('详情页/播放页标新：快照对比（零请求）', () => {
  it('首次打开（无快照）不标新，只把基线存下来', () => {
    expect(consumeNewEpisodes('AppRJ', '1', '全29集', 29)).toBeNull()
    expect(getSeenRemarks('AppRJ', '1')).toBe('全29集')
    expect(sessionNewEpisodes('AppRJ', '1')).toBeNull()
  })

  it('第二次打开、集数变多 → 返回新增范围，基线推到当前', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    const r = consumeNewEpisodes('AppRJ', '1', '全29集', 29)
    expect(r).toEqual({ from: 11, to: 29, count: 19 })
    expect(getSeenRemarks('AppRJ', '1')).toBe('全29集')
    // 范围进会话：播放页从这读，不再重算（重算恒 0，基线已被推走）
    expect(sessionNewEpisodes('AppRJ', '1')).toEqual({ from: 11, to: 29, count: 19 })
  })

  it('刷新页面再开详情 → 基线已是当前值，不重复提示（消费靠播放/已读）', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    consumeNewEpisodes('AppRJ', '1', '全29集', 29)
    expect(consumeNewEpisodes('AppRJ', '1', '全29集', 29)).toBeNull()
  })

  it('集数没变 / 变少（源站抖动）不标新', () => {
    rememberRemarks('AppRJ', '1', '全29集')
    expect(consumeNewEpisodes('AppRJ', '1', '全29集', 29)).toBeNull()
    rememberRemarks('AppRJ', '2', '全29集')
    expect(consumeNewEpisodes('AppRJ', '2', '全28集', 28)).toBeNull()
  })

  it('remarks 抠不出集数（电影时长）没有可比基准，不标新', () => {
    rememberRemarks('AppRJ', '1', '02:06:00')
    expect(consumeNewEpisodes('AppRJ', '1', '02:07:12', 1)).toBeNull()
  })

  it('totalEps 为 0（无线路）不标新', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    expect(consumeNewEpisodes('AppRJ', '1', '全29集', 0)).toBeNull()
  })

  it('updateBaseline 只推基线，不清未读提醒（清不清由"看了没有"决定）', () => {
    rememberRemarks('AppRJ', '1', '全10集')
    saveHits({ 'AppRJ|1': '全29集' })
    updateBaseline('AppRJ', '1', '全29集')
    expect(pendingUpdateCount()).toBe(1)
    // markSeen 才是"已读"
    markSeen('AppRJ', '1', '全29集')
    expect(pendingUpdateCount()).toBe(0)
  })

  it('recordUpdateHit 挂未读提醒（详情页发现新增时，只对收藏中的剧调）', () => {
    expect(pendingUpdateCount()).toBe(0)
    recordUpdateHit('AppRJ', '1', '全29集')
    expect(savedHits()).toEqual({ 'AppRJ|1': '全29集' })
    expect(pendingUpdateCount()).toBe(1)
  })
})

describe('详情页/播放页标新：接线门禁', () => {
  const detail = readFileSync(join(__dirname, '..', 'src', 'views', 'DetailView.vue'), 'utf8')
  const play = readFileSync(join(__dirname, '..', 'src', 'views', 'PlayView.vue'), 'utf8')
  const player = readFileSync(join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue'), 'utf8')

  it('详情页：load 后对比快照 + 会话复用 + 只给收藏挂提醒', () => {
    expect(detail).toContain('consumeNewEpisodes')
    expect(detail).toContain('sessionNewEpisodes(site, vid)')
    expect(detail).toContain('recordUpdateHit')
    expect(detail).toContain('自上次看新增')
    // 集数格子上要有新标
    expect(detail).toContain('isNewEp(epRange.start + epIdx)')
  })

  it('播放页：复用会话范围，播到新集才消费提醒', () => {
    expect(play).toContain('sessionNewEpisodes(site, vodId)')
    expect(play).toContain('consumeUpdateIfNew')
    expect(play).toContain('new-from-ep')
    // 消费挂在 onProgress（真实播起来了）里，不是起播处（失败/秒退不算看过）
    const inProgress = play.slice(play.indexOf('function onProgress'))
    expect(inProgress.includes('consumeUpdateIfNew()')).toBe(true)
  })

  it('播放器选集面板：新集带红点，不与当前集样式打架', () => {
    expect(player).toContain('newFromEp')
    expect(player).toContain('epCellClass')
    expect(player).toContain('isNewEpIdx')
  })
})
