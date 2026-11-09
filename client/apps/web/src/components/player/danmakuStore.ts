/**
 * 弹幕本地存储（IndexedDB）。
 *
 * **为什么需要它**：后端已经有 30 天的弹幕磁盘缓存（`danmakuDiskGet`），
 * 但那是**后端**的缓存。Web 部署时后端在远端容器里，手机断网连不上后端，
 * 磁盘缓存就成了读不到的死数据。要真离线，弹幕必须落在浏览器侧。
 *
 * **为什么用 IndexedDB 而不是 localStorage**：
 * localStorage 通常只有 5-10MB，而一集热门剧的弹幕 XML 常有几百 KB
 * （庆余年实测 42MB / 全剧）。存不下几集就会写失败，
 * 且 localStorage 是同步 API，写几百 KB 会卡住主线程。
 *
 * **为什么按 danmakuUrl 存**：弹幕地址是 `proxyDanmaku(title, ep)` 生成的，
 * 同一集永远是同一个 URL，天然是稳定的键。不另造键可以避免"算法改了导致
 * 全量失效"。
 */

const DB_NAME = 'meow-danmaku'
const STORE = 'xml'
const DB_VERSION = 1

/** 单集弹幕上限。超过就不存——42MB 那种存进来会撑爆配额。 */
const MAX_BYTES = 2 * 1024 * 1024
/** 最多保留多少集。按 `at` 淘汰最旧的。 */
const MAX_ENTRIES = 300
/** 本地弹幕多久后失效（毫秒）。与后端磁盘缓存一致：30 天。 */
const TTL_MS = 30 * 24 * 3600 * 1000

interface Row {
  key: string
  xml: string
  at: number
  count: number
  source: string
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'key' })
          os.createIndex('at', 'at')
        }
      }
      req.onsuccess = () => resolve(req.result)
      // 隐私模式 / 配额耗尽 / 浏览器禁用：静默降级成"没有本地缓存"，
      // 不要因为存储不可用让播放失败。
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE)
}

/** 读本地弹幕。没有、过期、或存储不可用都返回 null。 */
export async function getLocalDanmaku(url: string): Promise<{ xml: string; source: string } | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = tx(db, 'readonly').get(url)
      req.onsuccess = () => {
        const row = req.result as Row | undefined
        if (!row || !row.xml) {
          resolve(null)
          return
        }
        if (Date.now() - (row.at || 0) > TTL_MS) {
          resolve(null)
          return
        }
        resolve({ xml: row.xml, source: row.source || '' })
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/**
 * 写本地弹幕。
 *
 * 太大的直接跳过：单集 2MB 以上通常是异常数据（或超长剧集），
 * 存进来会很快把配额吃满，而这类集的弹幕本来也未必有人看。
 */
export async function putLocalDanmaku(
  url: string,
  xml: string,
  count: number,
  source: string,
): Promise<void> {
  if (!url || !xml) return
  if (xml.length > MAX_BYTES) return
  const db = await openDb()
  if (!db) return
  const row: Row = { key: url, xml, at: Date.now(), count, source }
  await new Promise<void>((resolve) => {
    try {
      const req = tx(db, 'readwrite').put(row)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  void pruneIfNeeded(db)
}

/** 条目超上限时按 at 淘汰最旧的。失败无所谓，下次写入还会再试。 */
async function pruneIfNeeded(db: IDBDatabase): Promise<void> {
  try {
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const req = tx(db, 'readonly').getAllKeys()
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => resolve([])
    })
    if (keys.length <= MAX_ENTRIES) return
    // 取最旧的 (keys.length - MAX_ENTRIES) 条删掉
    const rows = await new Promise<Row[]>((resolve) => {
      const req = tx(db, 'readonly').getAll()
      req.onsuccess = () => resolve((req.result || []) as Row[])
      req.onerror = () => resolve([])
    })
    rows.sort((a, b) => a.at - b.at)
    const drop = rows.slice(0, rows.length - MAX_ENTRIES)
    const store = tx(db, 'readwrite')
    for (const r of drop) store.delete(r.key)
  } catch {
    /* 淘汰失败不影响主流程 */
  }
}

/** 清空本地弹幕（设置页「清除离线弹幕」用）。 */
export async function clearLocalDanmaku(): Promise<number> {
  const db = await openDb()
  if (!db) return 0
  const n = await new Promise<number>((resolve) => {
    const req = tx(db, 'readonly').count()
    req.onsuccess = () => resolve(req.result || 0)
    req.onerror = () => resolve(0)
  })
  await new Promise<void>((resolve) => {
    try {
      const req = tx(db, 'readwrite').clear()
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  return n
}

/** 本地弹幕统计（设置页展示用）。 */
export async function localDanmakuStats(): Promise<{ entries: number; bytes: number }> {
  const db = await openDb()
  if (!db) return { entries: 0, bytes: 0 }
  const rows = await new Promise<Row[]>((resolve) => {
    try {
      const req = tx(db, 'readonly').getAll()
      req.onsuccess = () => resolve((req.result || []) as Row[])
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
  let bytes = 0
  for (const r of rows) bytes += (r.xml || '').length
  return { entries: rows.length, bytes }
}
