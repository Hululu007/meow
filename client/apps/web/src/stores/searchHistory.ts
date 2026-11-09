/**
 * 搜索关键词历史。
 *
 * 只有最近 N 个词、去重、最新在前——不需要时间戳以外的语义，
 * 也不需要和观看历史混在一起（两者用途完全不同）。
 *
 * 存储放 localStorage，随设置备份一起上传 WebDAV：
 * 换台设备也能看到自己常搜的词。
 */

const KEY = 'meow.search.history'
const MAX = 20

function read(): string[] {
  try {
    const s = localStorage.getItem(KEY)
    if (!s) return []
    const arr = JSON.parse(s)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : []
  } catch {
    return []
  }
}

function write(items: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* 配额满时忽略 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:search-history'))
  }
}

/** 按最近使用排序的关键词列表 */
export function listSearchHistory(): string[] {
  return read()
}

/** 记录一次搜索。重复词提到最前，不再新增一条。 */
export function addSearchHistory(word: string): string[] {
  const w = word.trim()
  if (!w) return read()
  const rest = read().filter((x) => x !== w)
  const next = [w, ...rest].slice(0, MAX)
  write(next)
  return next
}

/** 删掉一个词 */
export function removeSearchHistory(word: string): string[] {
  const next = read().filter((x) => x !== word)
  write(next)
  return next
}

/** 清空 */
export function clearSearchHistory(): string[] {
  write([])
  return []
}

/** 供 WebDAV 备份读写 */
export function exportSearchHistory(): string[] {
  return read()
}

export function importSearchHistory(items: unknown): void {
  if (!Array.isArray(items)) return
  const clean = items
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .slice(0, MAX)
  write(clean)
}
