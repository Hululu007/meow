const PORT = '9222'
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
const p = list.find(t => t.type === 'page' && t.url.includes('localhost:5173'))
if (!p) { console.log('no page'); process.exit(1) }

const ws = new WebSocket(p.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
const send = (method, params = {}) => {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params }))
  return new Promise(r => pending.set(i, r))
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') }
  }
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 1. 直接复现 webdavDownload 的每一步
const step1 = await ev(`(async () => {
  const cfg = JSON.parse(localStorage.getItem('feimao.webdav'));
  const base = cfg.url.replace(/\\/$/, '');
  const dir = cfg.dir.replace(/^\\/|\\/$/g, '');
  const url = base + '/' + dir + '/backup.json';
  const res = await fetch('http://127.0.0.1:9979/api/webdav', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, method: 'GET', user: cfg.user, pass: cfg.pass }),
  });
  const r = await res.json();
  return JSON.stringify({ url, ok: r.ok, status: r.status, len: (r.body||'').length });
})()`)
console.log('1) GET 结果:', step1)

// 2. 点击下载按钮，观察 5 秒内的文本变化
await ev(`window.__t0 = document.body.innerText; 'snap'`)
const btn = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '下载备份');
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()`)
console.log('2) 点击:', btn)

for (const t of [1000, 2500, 5000]) {
  await sleep(t === 1000 ? 1000 : 1500)
  const txt = await ev(`(() => {
    const t = document.body.innerText;
    const i = t.indexOf('WebDAV');
    return t.slice(i, i + 150);
  })()`)
  console.log(`   +${t}ms:`, JSON.stringify(txt))
}

ws.close()
