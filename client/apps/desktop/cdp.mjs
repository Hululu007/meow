#!/usr/bin/env node
/**
 * 极简 CDP 客户端：给 Tauri/WebView2 窗口做截图、执行 JS、点击。
 *
 * 用法：
 *   node cdp.mjs list
 *   node cdp.mjs eval "document.title"
 *   node cdp.mjs shot out.png
 *   node cdp.mjs click "重试"          # 按可见文本点按钮
 *   node cdp.mjs nav "#/settings"       # 改 hash 路由
 *   node cdp.mjs wait 2000
 *
 * 环境变量：CDP_PORT（默认 9222）
 */
const PORT = process.env.CDP_PORT || '9222'
const BASE = `http://127.0.0.1:${PORT}`

async function targets() {
  const r = await fetch(`${BASE}/json/list`)
  return r.json()
}

async function pickTarget() {
  const list = await targets()
  // CDP_URL_FILTER 可指定只匹配某个 URL 片段（浏览器里开了扩展时很有用）
  const filter = process.env.CDP_URL_FILTER
  const pages = list.filter((t) => t.type === 'page')
  const page = filter
    ? pages.find((t) => t.url.includes(filter))
    : pages.find((t) => /^https?:/.test(t.url))
  if (!page) {
    const seen = pages.map((t) => t.url).join('\n  ')
    throw new Error(
      `no matching page target at ${BASE}${filter ? ` for filter "${filter}"` : ''}\n  ${seen}`,
    )
  }
  return page
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('ws connect failed')), { once: true })
    })
    return new CDP(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
    return r.result.value
  }
  close() { this.ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cmd = process.argv[2]
const page = await pickTarget()
const cdp = await CDP.connect(page.webSocketDebuggerUrl)

try {
  switch (cmd) {
    case 'list': {
      console.log(JSON.stringify(await targets(), null, 2))
      break
    }
    case 'eval': {
      console.log(JSON.stringify(await cdp.eval(process.argv[3]), null, 2))
      break
    }
    case 'shot': {
      const out = process.argv[3] || 'shot.png'
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(out, Buffer.from(data, 'base64'))
      console.log(`saved ${out} (${Buffer.from(data, 'base64').length} bytes)`)
      break
    }
    case 'click': {
      const text = process.argv[3]
      const r = await cdp.eval(`(() => {
        const t = ${JSON.stringify(text)};
        const nodes = [...document.querySelectorAll('button,a,[role=button]')];
        const el = nodes.find(n => (n.innerText || '').trim() === t) || nodes.find(n => (n.innerText || '').includes(t));
        if (!el) return { ok:false, seen: nodes.map(n => (n.innerText||'').trim()).filter(Boolean).slice(0,20) };
        el.click();
        return { ok:true, tag: el.tagName, text:(el.innerText||'').trim() };
      })()`)
      console.log(JSON.stringify(r, null, 2))
      break
    }
    case 'nav': {
      const hash = process.argv[3]
      await cdp.eval(`location.hash = ${JSON.stringify(hash)}`)
      await sleep(600)
      console.log(await cdp.eval('location.href'))
      break
    }
    case 'wait': {
      await sleep(Number(process.argv[3] || 1000))
      console.log('ok')
      break
    }
    case 'move': {
      // 派发真实鼠标移动（Input 域），能触发 Vue/React 的 onmousemove
      const x = Number(process.argv[3] || 400)
      const y = Number(process.argv[4] || 300)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
      await sleep(200)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 1, y: y + 1, button: 'none', clickCount: 0 })
      console.log(`moved to ${x},${y}`)
      break
    }
    case 'clickxy': {
      const x = Number(process.argv[3] || 400)
      const y = Number(process.argv[4] || 300)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      console.log(`clicked ${x},${y}`)
      break
    }
    case 'text': {
      console.log(await cdp.eval('document.body.innerText'))
      break
    }
    default:
      console.log('usage: node cdp.mjs <list|eval|shot|click|nav|wait|text> [arg]')
  }
} finally {
  cdp.close()
}
