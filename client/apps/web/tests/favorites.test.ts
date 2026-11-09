import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyRemoteFavorites,
  clearFavorites,
  isFavorite,
  listFavorites,
  removeFavorite,
  toggleFavorite,
} from '../src/stores/favorites'
import type { FavoriteItem } from '../src/stores/favorites'

const KEY = 'meow.favorites.list'

const mk = (
  site: string,
  id: string,
  at: number,
  name = '',
  pic = '',
): Omit<FavoriteItem, 'at'> & { at: number } => ({
  site,
  vod_id: id,
  vod_name: name || `${site}-${id}`,
  vod_pic: pic,
  at,
})

describe('收藏：增删与幂等', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
  })

  it('新收藏返回 true 并出现在列表里', () => {
    const on = toggleFavorite(mk('Douban', 'v1', 1000, '庆余年'))
    expect(on).toBe(true)
    const list = listFavorites()
    expect(list).toHaveLength(1)
    expect(list[0].vod_name).toBe('庆余年')
    expect(isFavorite('Douban', 'v1')).toBe(true)
  })

  it('再点一次是取消收藏', () => {
    toggleFavorite(mk('Douban', 'v1', 1000))
    const on = toggleFavorite(mk('Douban', 'v1', 2000))
    expect(on).toBe(false)
    expect(listFavorites()).toHaveLength(0)
  })

  it('同一部片不会重复：第二次点击是取消而不是再加一条', () => {
    toggleFavorite(mk('A', '1', 1000))
    toggleFavorite(mk('A', '1', 2000))
    toggleFavorite(mk('A', '1', 3000))
    expect(listFavorites()).toHaveLength(1)
  })

  it('site 或 vod_id 缺失时不写入', () => {
    expect(toggleFavorite({ site: '', vod_id: 'x', vod_name: 'n' })).toBe(false)
    expect(toggleFavorite({ site: 'A', vod_id: '', vod_name: 'n' })).toBe(false)
    expect(listFavorites()).toHaveLength(0)
  })

  it('列表按 at 倒序（最近收藏在前）', () => {
    toggleFavorite(mk('A', '1', 1000))
    toggleFavorite(mk('B', '2', 5000))
    toggleFavorite(mk('C', '3', 3000))
    expect(listFavorites().map((x) => x.site)).toEqual(['B', 'C', 'A'])
  })

  it('removeFavorite 删掉指定项，不存在的项无副作用', () => {
    toggleFavorite(mk('A', '1', 1000))
    toggleFavorite(mk('B', '2', 2000))
    removeFavorite('A', '1')
    expect(listFavorites().map((x) => x.site)).toEqual(['B'])
    removeFavorite('Nope', 'zzz')
    expect(listFavorites()).toHaveLength(1)
  })

  it('clearFavorites 清空全部', () => {
    toggleFavorite(mk('A', '1', 1000))
    toggleFavorite(mk('B', '2', 2000))
    clearFavorites()
    expect(listFavorites()).toHaveLength(0)
  })

  it('坏数据（非数组 / 缺字段）不会让读取抛错', () => {
    localStorage.setItem(KEY, '{not json')
    expect(listFavorites()).toEqual([])
    localStorage.setItem(KEY, JSON.stringify([{ site: 'A' }, { site: 'B', vod_id: '2', at: 1 }]))
    expect(listFavorites()).toHaveLength(1)
  })
})

describe('收藏：远端合并', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
  })

  it('并集：本地有、远端没有的保留', () => {
    toggleFavorite(mk('Local', 'l1', 1000))
    applyRemoteFavorites([mk('Remote', 'r1', 2000) as FavoriteItem])
    expect(listFavorites().map((x) => x.site).sort()).toEqual(['Local', 'Remote'])
  })

  it('同一部片取 at 较新的元信息', () => {
    toggleFavorite(mk('A', '1', 1000, '旧片名', 'old.jpg'))
    applyRemoteFavorites([
      { site: 'A', vod_id: '1', vod_name: '新片名', vod_pic: 'new.jpg', at: 9000 } as FavoriteItem,
    ])
    const list = listFavorites()
    expect(list).toHaveLength(1)
    expect(list[0].vod_name).toBe('新片名')
    expect(list[0].vod_pic).toBe('new.jpg')
  })

  it('远端更旧时不覆盖本地较新的元信息', () => {
    toggleFavorite(mk('A', '1', 9000, '新片名'))
    applyRemoteFavorites([
      { site: 'A', vod_id: '1', vod_name: '旧片名', at: 1000 } as FavoriteItem,
    ])
    expect(listFavorites()[0].vod_name).toBe('新片名')
  })

  it('空/非数组输入不改动本地', () => {
    toggleFavorite(mk('A', '1', 1000))
    applyRemoteFavorites([])
    applyRemoteFavorites(null as unknown as FavoriteItem[])
    expect(listFavorites()).toHaveLength(1)
  })
})

describe('收藏：变更事件', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
  })

  it('加收藏派发 add 事件并带上条目', () => {
    const seen: Array<{ action: string; site?: string; name?: string }> = []
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail
      seen.push({ action: d.action, site: d.site, name: d.item?.vod_name })
    }
    window.addEventListener('meow:favorites-changed', h)
    toggleFavorite(mk('A', '1', 1000, '庆余年'))
    window.removeEventListener('meow:favorites-changed', h)
    expect(seen).toEqual([{ action: 'add', site: undefined, name: '庆余年' }])
  })

  it('取消收藏派发 remove 事件并带上 site/vod_id', () => {
    toggleFavorite(mk('A', '1', 1000))
    const seen: Array<{ action: string; site?: string; vod_id?: string }> = []
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail
      seen.push({ action: d.action, site: d.site, vod_id: d.vod_id })
    }
    window.addEventListener('meow:favorites-changed', h)
    toggleFavorite(mk('A', '1', 2000))
    window.removeEventListener('meow:favorites-changed', h)
    expect(seen).toEqual([{ action: 'remove', site: 'A', vod_id: '1' }])
  })

  it('远端合并不派发事件（否则拉取会自激成上传）', () => {
    let count = 0
    const h = () => {
      count++
    }
    window.addEventListener('meow:favorites-changed', h)
    applyRemoteFavorites([mk('R', 'r1', 5000) as FavoriteItem])
    window.removeEventListener('meow:favorites-changed', h)
    expect(count).toBe(0)
  })

  it('notify:false 时也不派发事件', () => {
    let count = 0
    const h = () => {
      count++
    }
    window.addEventListener('meow:favorites-changed', h)
    toggleFavorite(mk('A', '1', 1000), { notify: false })
    window.removeEventListener('meow:favorites-changed', h)
    expect(count).toBe(0)
    expect(listFavorites()).toHaveLength(1)
  })
})

describe('远端收藏晚到：广播同步事件（冷启动竞态）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('applyRemoteFavorites 派发 meow:favorites-synced 且不派发 changed', () => {
    let synced = 0
    let changed = 0
    const onSynced = () => (synced += 1)
    const onChanged = () => (changed += 1)
    window.addEventListener('meow:favorites-synced', onSynced)
    window.addEventListener('meow:favorites-changed', onChanged)
    applyRemoteFavorites([mk('A', '1', 5000)])
    window.removeEventListener('meow:favorites-synced', onSynced)
    window.removeEventListener('meow:favorites-changed', onChanged)
    expect(synced).toBe(1)
    expect(changed).toBe(0) // 派发 changed 会触发回推，形成"拉→推→拉"循环
    expect(listFavorites()).toHaveLength(1)
  })
})
