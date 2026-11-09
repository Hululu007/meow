const PORT = process.env.CDP_PORT || '9222'

async function page() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
  return list.find(t => t.type === 'page' && t.url.includes('tauri.localhost'))
}

const p = await page()
if (!p) { console.log('no page'); process.exit(1) }

const ws = new WebSocket(p.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))

let id = 0
const pending = new Map()
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) }
})
function send(method, params = {}) {
  const i = ++id
  ws.send(JSON.stringify({ id: i, method, params }))
  return new Promise(r => pending.set(i, r))
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** 取某条弹幕的 x */
const SAMPLE = `(() => {
  const L=[...document.querySelectorAll('div')].find(d=>d.style?.zIndex==='20'&&d.style?.pointerEvents==='none');
  const v=document.querySelector('video');
  const xs=[...L.children].map(c=>{const m=/translate\\((-?[\\d.]+)px/.exec(c.style.transform);return m?Number(m[1]):null}).filter(x=>x!==null);
  return { t: v.currentTime, rate: v.playbackRate, n: xs.length, xs: xs.slice(0,6), avg: xs.length? xs.reduce((a,b)=>a+b,0)/xs.length : null };
})()`

async function snapshot(label) {
  const s = await ev(SAMPLE)
  console.log(label.padEnd(22), JSON.stringify({ t: +s.t.toFixed(2), rate: s.rate, n: s.n, avg: s.avg ? Math.round(s.avg) : null }))
  return s
}

console.log('=== 1x 基线 ===')
await ev(`(()=>{const v=document.querySelector('video');v.playbackRate=1;return 1})()`)
await sleep(1200)
const a = await snapshot('1x t0')
await sleep(1500)
const b = await snapshot('1x t+1.5s')

console.log('\n=== 3x ===')
await ev(`(()=>{const v=document.querySelector('video');v.playbackRate=3;return 1})()`)
await sleep(300)
const c = await snapshot('3x t0')
await sleep(1500)
const d = await snapshot('3x t+1.5s')

console.log('\n=== 判定 ===')
const dt1 = b.t - a.t
const dt3 = d.t - c.t
console.log(`实际时间推进: 1x=${dt1.toFixed(2)}s  3x=${dt3.toFixed(2)}s  (比值 ${(dt3/dt1).toFixed(2)})`)
console.log(`弹幕节点数:   1x ${a.n}->${b.n}   3x ${c.n}->${d.n}`)

// 暂停测试
console.log('\n=== 暂停 ===')
await ev(`(()=>{document.querySelector('video').pause();return 1})()`)
await sleep(300)
const e = await snapshot('暂停 t0')
await sleep(1500)
const f = await snapshot('暂停 t+1.5s')
console.log(`暂停期间时间变化: ${(f.t - e.t).toFixed(3)}s  (应为 0)`)
console.log(`暂停期间弹幕数:   ${e.n} -> ${f.n}`)
if (e.xs.length && f.xs.length) {
  const same = e.xs.every((x, i) => Math.abs(x - f.xs[i]) < 1)
  console.log(`暂停期间位置不变: ${same}  (${JSON.stringify(e.xs.slice(0,3))} vs ${JSON.stringify(f.xs.slice(0,3))})`)
}

ws.close()
