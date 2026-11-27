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

/*
 * 启动即预热（2026-11-27）。
 *
 * 以前 host.js 是**第一单任务**才 require 的，于是那一单要同时做完
 * 「编译 host.js + 解析 cheerio/sync-fetch/crypto-js + 抓源站」三件事，
 * 全部挤在 server.js 的 TASK_TIMEOUT（默认 6s）里。x86 PC 上勉强够，
 * **ARM NAS / 电视盒子上必然超时** → 任务被判超时并 retire(kill) 掉这个 worker
 * → 换上新 worker 又是冷的 → 下一单再超时，形成死循环（实测 OECT 1.2.25
 * 升级后所有 .js 源报 `drpy task timeout (worker killed)`，jar 源照常）。
 *
 * 所以 worker 一被创建就把 host 加载好：之后每个任务只剩"抓站"这一件事，
 * 与 PC 上的耗时一致。
 */
let host = null
try {
  host = require('./host')
} catch (e) {
  // 预热失败不致命：真实任务会再 require 一次并返回带 stack 的错误
  host = null
}

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

async function dispatch(spider, action, body, ext) {
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
      /*
       * vbox/Fongmi 的 JS 蜘蛛把 playerContent 写成
       *   (vodId, sourceName, episodeId)
       * 与 CatVod 标准 (flag, id, vipFlags) 不同。实测上游 vbox-Ai/api 的
       * jumi/tyyszy/daishu 都是这种顺序：按标准传时第 3 参是数组，
       * 脚本里 `episodeId.split(...)` 直接抛 "split is not a function"。
       * 由站点 ext 显式声明 {"playArgOrder":"vbox"}，不猜。
       */
      let vboxOrder = false
      try {
        const e = ext ? JSON.parse(ext) : null
        if (e && typeof e === 'object' && e.playArgOrder === 'vbox') vboxOrder = true
      } catch (_) {
        /* ext 不是 JSON（多数站点是 host 或空）——按标准顺序 */
      }
      if (vboxOrder) {
        return await fn.call(spider, String(b.id ?? ''), String(b.flag ?? ''), String(b.id ?? ''))
      }
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
    const out = await dispatch(spider, action, body, ext)
    parentPort.postMessage({ id, ok: true, text: toJson(out) })
  } catch (e) {
    const text = String((e && e.message) || e)
    parentPort.postMessage({ id, ok: false, error: text })
  }
})
