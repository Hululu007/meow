import { beforeEach, describe, expect, it } from 'vitest'
import { applyBackup, makeBackup } from '../src/stores/prefs'
import { listFavorites, toggleFavorite } from '../src/stores/favorites'
import type { FavoriteItem } from '../src/stores/favorites'

const FAV_KEY = 'meow.favorites.list'
const PREFS_KEY = 'meow.prefs'
const HIST_KEY = 'meow.history.list'

const fav = (site: string, id: string, at: number, name = ''): FavoriteItem => ({
  site,
  vod_id: id,
  vod_name: name || `${site}-${id}`,
  vod_pic: '',
  vod_remarks: '',
  flag: '',
  at,
})

describe('备份：收藏往返', () => {
  beforeEach(() => {
    localStorage.removeItem(FAV_KEY)
    localStorage.removeItem(HIST_KEY)
    localStorage.removeItem(PREFS_KEY)
  })

  it('makeBackup 带上收藏', () => {
    toggleFavorite(fav('A', '1', 1000, '片甲'))
    toggleFavorite(fav('B', '2', 2000, '片乙'))
    const b = makeBackup([], [], listFavorites())
    expect(b.favorites).toHaveLength(2)
    expect((b.favorites as FavoriteItem[]).map((x) => x.vod_name).sort()).toEqual([
      '片乙',
      '片甲',
    ])
  })

  it('导出再导入：收藏原样回来', () => {
    toggleFavorite(fav('A', '1', 1000, '片甲'))
    toggleFavorite(fav('B', '2', 2000, '片乙'))
    const b = makeBackup([], [], listFavorites())
    // 清空后导入
    localStorage.removeItem(FAV_KEY)
    expect(listFavorites()).toHaveLength(0)
    expect(applyBackup(JSON.parse(JSON.stringify(b)))).toBe(true)
    const back = listFavorites()
    expect(back).toHaveLength(2)
    expect(back.map((x) => x.vod_name).sort()).toEqual(['片乙', '片甲'])
  })

  it('还原是覆盖：本地多出来的收藏会消失', () => {
    toggleFavorite(fav('Old', 'o1', 1000))
    const backup = makeBackup([], [], [fav('New', 'n1', 5000, '备份里的')])
    // 本地再加一条备份里没有的
    toggleFavorite(fav('Extra', 'e1', 9000))
    expect(listFavorites()).toHaveLength(2)
    applyBackup(backup)
    const names = listFavorites().map((x) => x.site)
    expect(names).toEqual(['New'])
  })

  it('老备份没有 favorites 字段时不动本地收藏', () => {
    toggleFavorite(fav('Keep', 'k1', 1000))
    const legacy = {
      version: 1 as const,
      exportedAt: Date.now(),
      prefs: {},
      history: [],
    }
    applyBackup(legacy)
    expect(listFavorites().map((x) => x.site)).toEqual(['Keep'])
  })

  it('备份里 favorites 是空数组时清空本地（与"缺失"区分）', () => {
    toggleFavorite(fav('A', '1', 1000))
    applyBackup({
      version: 1,
      exportedAt: Date.now(),
      prefs: {},
      history: [],
      favorites: [],
    })
    expect(listFavorites()).toHaveLength(0)
  })

  it('重复条目按 at 去重（同 site+vod_id 只留一条）', () => {
    applyBackup({
      version: 1,
      exportedAt: Date.now(),
      prefs: {},
      history: [],
      favorites: [fav('A', '1', 1000, '旧'), fav('A', '1', 5000, '新')],
    })
    const list = listFavorites()
    expect(list).toHaveLength(1)
    expect(list[0].vod_name).toBe('新')
  })

  it('坏条目被丢掉，不影响其余', () => {
    applyBackup({
      version: 1,
      exportedAt: Date.now(),
      prefs: {},
      history: [],
      favorites: [{ site: 'A' }, { site: 'B', vod_id: '2', at: 1 } as FavoriteItem],
    })
    expect(listFavorites().map((x) => x.site)).toEqual(['B'])
  })

  it('还原会派发 restore 事件（供同步层重建后端那份）', () => {
    const seen: string[] = []
    const h = (e: Event) => seen.push((e as CustomEvent).detail?.action)
    window.addEventListener('meow:favorites-changed', h)
    applyBackup({
      version: 1,
      exportedAt: Date.now(),
      prefs: {},
      history: [],
      favorites: [fav('A', '1', 1000)],
    })
    window.removeEventListener('meow:favorites-changed', h)
    expect(seen).toEqual(['restore'])
  })
})
