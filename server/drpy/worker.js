/**
 * 单个源请求的 worker 执行体。
 *
 * 为什么必须开 worker 而不是在主进程里跑：
 * drpy 脚本里的 `req()` 走 `sync-fetch`，它用 **SharedArrayBuffer + Atomics.wait
 * 阻塞当前线程** —— 这在 Node 主线程上会把整个事件循环钉死。
 * 实测后果（2026-10-30 OECT）：226 个脚本源并发进来，前一个卡在
 * sync-fetch 上，后面的全排队，连 `/health` 都超时（容器报 unhealthy
 * 但 CPU 只有 2.3%，看起来"没在干活"，极具迷惑性）。
 *
 * 隔离后阻塞只影响这个 worker，主线程照常 accept 新请求和响应健康检查。
 */
'use strict'

const { parentPort } = require('worker_threads')

let host = null
const cache = new Map()

function getSpider(api, ext) {
  const key = api + '|' + ext
  if (!cache.has(key)) {
    cache.set(
      key,
      host.loadSpider(api, ext).catch((e) => {
        cache.delete(key)
        throw e
      }),
    )
  }
  return cache.get(key)
}

async function dispatch(spider, action, body) {
  const b = body || {}
  switch (action) {
    case 'home': {
      const fn = spider.homeContent || spider.home
      if (typeof fn !== 'function') return {}
      return await fn.call(spider, false)
    }
    case 'category': {
      const fn = spider.categoryContent
      if (typeof fn !== 'function') return {}
      return await fn.call(
        spider,
        String(b.tid ?? b.id ?? ''),
        String(b.pg ?? b.page ?? '1'),
        b.filter === true,
        b.extend || {},
      )
    }
    case 'detail': {
      const fn = spider.detailContent
      if (typeof fn !== 'function') return {}
      const ids = Array.isArray(b.ids) ? b.ids : [b.id ?? b.ids ?? '']
      return await fn.call(spider, ids.map(String))
    }
    case 'search': {
      const fn = spider.searchContent
      if (typeof fn !== 'function') return {}
      return await fn.call(spider, b.wd ?? b.key ?? '', b.quick === true, String(b.pg ?? '1'))
    }
    case 'play': {
      const fn = spider.playerContent
      if (typeof fn !== 'function') return {}
      return await fn.call(spider, String(b.flag ?? ''), String(b.id ?? ''), b.vipFlags || [])
    }
    case 'action': {
      const fn = spider.action
      if (typeof fn !== 'function') return {}
      return await fn.call(spider, String(b.action ?? ''))
    }
    case 'proxy': {
      const fn = spider.localProxy
      if (typeof fn !== 'function') return {}
      return await fn.call(spider, b)
    }
    default:
      throw new Error('unknown action: ' + action)
  }
}

function toJson(v) {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

parentPort.on('message', async (msg) => {
  const { id, api, ext, action, body } = msg
  try {
    if (!host) host = require('./host')
    const spider = await getSpider(api, ext)
    const out = await dispatch(spider, action, body)
    parentPort.postMessage({ id, ok: true, text: toJson(out) })
  } catch (e) {
    const text = String((e && e.message) || e)
    parentPort.postMessage({ id, ok: false, error: text })
  }
})
