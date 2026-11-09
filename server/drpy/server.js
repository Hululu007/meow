/**
 * drpy 运行时的 HTTP 外壳。
 *
 * 契约与我们的后端同形：`POST /{site}/{action}`，body 就是前端原本发给
 * `/api/{site}/{action}` 的那份 JSON。后端用 `X-DRPY-Api` / `X-DRPY-Ext`
 * 两个头告诉我们要加载哪个脚本、用什么 ext。
 *
 * 为什么不在这个进程里做"站点表"：站点表在后端（config.sites.json），
 * 两边各存一份必然漂移。运行时只是"执行器"，配置只有一份。
 */
'use strict'

const http = require('http')
const path = require('path')
const { Worker } = require('worker_threads')

const PORT = Number(process.env.DRPY_PORT || 9330)
const STARTED_AT = Date.now()

/**
 * worker 池大小。
 *
 * 每个 worker 是一个独立的 JS 线程，`sync-fetch` 的阻塞只影响它自己。
 * 池大小 = 能被后端同时打进来的合理并发：后端默认 12 个并发槽，
 * 留一倍余量应对"上一轮残骸还没退出"。再多只会加剧目标站限流。
 */
const POOL_SIZE = Number(process.env.DRPY_POOL || 24)
/**
 * 单请求硬超时。
 *
 * ★ 超时后必须**终止 worker 并重建**，不能只回个错误就算了：
 * workload 是同步阻塞的，`terminate()` 是唯一能真正打断它的手段
 * （和在 Java 侧对 sync-fetch 的结论一致 —— 见 docs/28 §10.6）。
 *
 * ★ 必须**短于后端的单源超时**（后端 SCRIPT_RUNTIME_TIMEOUT_MS = 8s）。
 * 踩过（2026-10-30 OECT 实测）：原来这里 12 秒 > 后端 8 秒，于是后端先放弃、
 * 返回空串并记一次超时，而 worker 还在跑到 12 秒 —— 每次都白等 4 秒。
 * 症状是 `slow drpy_js_*` 全是整齐的 8000ms（后端超时的值），
 * 看起来像"drpy 没响应"，实际是两边超时没对齐。
 *
 * 6 秒 = 给后端 8 秒留 2 秒余量：drpy 先返回
 * `{"code":-1,"msg":"drpy task timeout"}`，后端拿到明确答复
 * （而不是干等满 8 秒），worker 也立刻被回收重建。
 */
const TASK_TIMEOUT_MS = Number(process.env.DRPY_TASK_TIMEOUT || 6_000)

/** 空闲 worker 列表。 */
const idle = []
/** 所有在跑的 worker（含 idle），用于健康统计与关闭。 */
const all = new Set()
/** 请求排队数，超过上限直接 503 —— 让后端快速失败而不是干等。 */
const MAX_QUEUE = Number(process.env.DRPY_MAX_QUEUE || 200)
let waiting = 0
const queue = []
/** 累计统计，给 /health 看。 */
const stat = { served: 0, failed: 0, timedOut: 0, restarted: 0 }

function spawnWorker() {
  const w = new Worker(path.join(__dirname, 'worker.js'))
  w._busy = false
  w._current = null
  w.on('error', (e) => {
    console.error('[drpy] worker error:', e && e.message)
    retire(w)
  })
  w.on('exit', () => {
    const wasKnown = all.delete(w)
    const i = idle.indexOf(w)
    if (i >= 0) idle.splice(i, 1)
    /*
     * worker 自己退出（脚本调 process.exit、OOM 被杀等）时也要补位。
     *
     * `retire()` 里已经补过位的不要再补，否则池子会无限膨胀 ——
     * 用 wasKnown 区分：retire 会先 all.delete，所以走到这里时
     * wasKnown 为 false 就说明是 retire 发起的。
     *
     * 补位同样要**先喂排队者**（理由见 retire 的注释）。
     */
    if (wasKnown && all.size < POOL_SIZE) {
      const nw = spawnWorker()
      if (queue.length) {
        const next = queue.shift()
        waiting--
        next.resolve(nw)
      } else {
        idle.push(nw)
      }
    }
  })
  all.add(w)
  return w
}

/** 丢弃一个（可能已卡死的）worker：terminate 是唯一能打断同步阻塞的手段。 */
function retire(w) {
  all.delete(w)
  const i = idle.indexOf(w)
  if (i >= 0) idle.splice(i, 1)
  const cur = w._current
  w._current = null
  w._busy = false
  try {
    w.terminate()
  } catch (e) {
    /* 已经死了就算了 */
  }
  if (cur) {
    stat.timedOut++
    clearTimeout(cur.timer)
    cur.resolve(`{"code":-1,"msg":"drpy task timeout (worker killed)"}`)
  }
  /*
   * ★ 补位时**必须先喂排队者**，不能直接塞回 idle。
   *
   * 踩过（2026-10-30 OECT 实测）：原来只做 `idle.push(spawnWorker())`，
   * 于是排队者永远拿不到 worker（它们只在 release 里被唤醒，而 retire
   * 走不到 release），新补的 worker 静静躺在 idle 里。
   * 症状是 `/health` 的 `queued` 只增不减 —— 实测静置时
   * `busy=0` 但 `queued=44` 一直不消失，且后续搜索越来越慢。
   */
  if (all.size < POOL_SIZE) {
    const nw = spawnWorker()
    if (queue.length) {
      const next = queue.shift()
      waiting--
      next.resolve(nw)
    } else {
      idle.push(nw)
    }
  }
}

function acquire() {
  if (idle.length) return Promise.resolve(idle.pop())
  if (all.size < POOL_SIZE) return Promise.resolve(spawnWorker())
  if (waiting >= MAX_QUEUE) return Promise.reject(new Error('drpy queue full'))
  waiting++
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject })
  })
}

function release(entry) {
  // 优先唤醒排队者，没有就放回 idle
  if (queue.length) {
    const next = queue.shift()
    waiting--
    next.resolve(entry.w)
    return
  }
  if (all.has(entry.w) && !entry.w._busy) idle.push(entry.w)
}

/**
 * 在 worker 里跑一次源调用。
 *
 * 返回的永远是 JSON 字符串（错误也包成 `{"code":-1,...}`），
 * 与改前的 HTTP 响应语义一致，后端不需要改解析。
 */
async function runInWorker(api, ext, action, body) {
  const w = await acquire()
  return new Promise((resolve) => {
    let done = false
    const finish = (text) => {
      if (done) return
      done = true
      clearTimeout(timer)
      w._current = null
      w._busy = false
      if (all.has(w)) release({ w })
      resolve(text)
    }
    const timer = setTimeout(() => {
      /*
       * 超时：这个 worker 十有八九卡在 sync-fetch 里，terminate 后补一个新的。
       * 不复用是刻意的 —— sync-fetch 用的是共享内存等待，
       * 即便外层不 import 了，那个 worker 也可能永远不返回。
       */
      stat.timedOut++
      retire(w)
      finish(`{"code":-1,"msg":"drpy task timeout after ${TASK_TIMEOUT_MS}ms"}`)
    }, TASK_TIMEOUT_MS)

    w._busy = true
    w._current = { resolve: finish, timer }
    const onMsg = (m) => {
      w.off('message', onMsg)
      if (m && m.ok) {
        stat.served++
        finish(m.text || '{}')
      } else {
        stat.failed++
        const msg = String((m && m.error) || 'unknown')
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
        finish(`{"code":-1,"msg":"${msg}"}`)
      }
    }
    w.once('message', onMsg)
    w.postMessage({
      id: Math.random().toString(36).slice(2),
      api,
      ext,
      action,
      body,
    })
  })
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = Buffer.from(body, 'utf8')
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': data.length,
    'Access-Control-Allow-Origin': '*',
  })
  res.end(data)
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function decodeHeader(req, name) {
  const v = req.headers[name] || ''
  // 后端用 URLEncoder 编过（避免中文 ext 在头里乱码），这里对应解码
  try {
    return v ? decodeURIComponent(v) : ''
  } catch (e) {
    return v
  }
}

/** 共享令牌。设了就必须带；没设则只允许本机来源（见 authorized）。 */
const DRPY_TOKEN = (process.env.DRPY_TOKEN || process.env.MEOW_AUTH_TOKEN || '').trim()

/** 请求方是不是本机（回环地址/本机网卡） */
function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/**
 * 这个请求能不能执行脚本。
 *
 * <p>两种放行方式，任一即可：
 * <ol>
 *   <li>带了正确的 {@code X-DRPY-Token}（跨机部署靠它）</li>
 *   <li>没配 token，且请求来自本机回环（本机浏览器/同机进程）</li>
 * </ol>
 *
 * <p>为什么不再"无条件放行"：这个端点的请求头里能塞任意 JS 源码，
 * 等于把一个执行入口开给整个局域网（见下文 DRPY_STRIP_REMOTE 附近的说明）。
 */
function authorized(req) {
  if (DRPY_TOKEN) {
    const got = (req.headers['x-drpy-token'] || '').trim()
    return got === DRPY_TOKEN
  }
  return isLoopback(req)
}

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const url = new URL(req.url, 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)

  if (url.pathname === '/health' || url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'meow-drpy',
      // ★ 这个接口必须在**主线程**回答且不查任何源状态。
      // 改前它在主线程里等 spider 缓存，而 spider 一旦卡在 sync-fetch 上，
      // 连健康检查都超时 → 容器报 unhealthy 但 CPU 只有 2%（实测 OECT）。
      workers: all.size,
      idle: idle.length,
      busy: all.size - idle.length,
      queued: waiting,
      served: stat.served,
      failed: stat.failed,
      timedOut: stat.timedOut,
      uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    })
  }

  if (req.method !== 'POST' || parts.length < 2) {
    return sendJson(res, 404, { code: -1, msg: 'use POST /{site}/{action}' })
  }

  const site = decodeURIComponent(parts[0])
  const action = decodeURIComponent(parts[1])

  /*
   * ★ 令牌校验（2026-10-30 安全审计修的 C1）。
   *
   * 原来这个服务：
   *   · server.listen(PORT, '0.0.0.0') —— 整个局域网可达
   *   · 直接拿 X-DRPY-Api 头当脚本地址（可以是 `js:<任意源码>`）
   *   · 沙箱里 `__req('child_process')` 能直接拿到 Node 的 require
   * 三者合起来 = **任意能连上端口的人远程执行任意命令**（实测
   * `X-DRPY-Api: js:...execSync('echo pwned')` 的响应体就是执行结果）。
   *
   * 现在：设了 DRPY_TOKEN 就必须带 X-DRPY-Token，不设则只允许本机来源。
   * 两条任何一条满足即可，避免老部署（没配 token）直接不可用。
   */
  if (!authorized(req)) {
    return sendJson(res, 403, { code: -1, msg: 'drpy: unauthorized' })
  }

  const api = decodeHeader(req, 'x-drpy-api')
  const ext = decodeHeader(req, 'x-drpy-ext')
  const raw = await readBody(req)

  if (!api) return sendJson(res, 400, { code: -1, msg: 'missing X-DRPY-Api header' })

  let body
  try {
    body = raw.trim() ? JSON.parse(raw) : {}
  } catch (e) {
    return sendJson(res, 200, `{"code":-1,"msg":"bad json body"}`)
  }

  let text
  try {
    text = await runInWorker(api, ext, action, body)
  } catch (e) {
    /*
     * 队列满：立刻回错误，让后端快速失败。
     * 绝不能在这里排队等待 —— 后端每源只有 1~8 秒预算，
     * 排在几百个卡死请求后面等于必然超时，还会把后端并发槽也拖住。
     */
    stat.failed++
    return sendJson(res, 200, `{"code":-1,"msg":"drpy overloaded: ${e.message}"}`)
  }
  if (process.env.DRPY_DEBUG === '1') {
    console.log(`[drpy] ${site}/${action} ${Date.now() - started}ms -> ${String(text).length}B`)
  }
  send(res, 200, text || '{}')
})

/*
 * 绑 127.0.0.1 而不是 0.0.0.0（2026-10-30 安全审计）。
 *
 * 后端与 drpy 永远同机（Docker 里是同一 network 的两个容器，PC 是同一台机器），
 * 绑回环不影响功能；而绑通配会让整个局域网都能打这个端点 ——
 * 它接受请求头里的任意 JS 源码并执行（见 authorized 的注释）。
 *
 * 确实需要跨机（比如把 drpy 单独放一台机器）时设 DRPY_BIND=0.0.0.0，
 * 并且**必须同时设 DRPY_TOKEN**，否则等于开放匿名代码执行。
 */
const BIND = process.env.DRPY_BIND || '127.0.0.1'
server.listen(PORT, BIND, () => {
  console.log(`[drpy] listening on http://${BIND}:${PORT} pool=${POOL_SIZE} timeout=${TASK_TIMEOUT_MS}ms`)
  if (BIND !== '127.0.0.1' && !DRPY_TOKEN) {
    console.warn('[drpy] ★ 监听在 ' + BIND + ' 但没有设 DRPY_TOKEN：任何能连上端口的人都能执行任意脚本')
  }
  // 预建一半 worker，避免首轮搜索时现开线程拖慢
  for (let i = 0; i < Math.max(2, Math.floor(POOL_SIZE / 2)); i++) idle.push(spawnWorker())
})
