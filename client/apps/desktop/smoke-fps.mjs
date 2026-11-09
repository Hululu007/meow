const PORT = process.env.CDP_PORT || '9222'

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
const p = list.find(t => t.type === 'page' && t.url.includes('tauri.localhost'))
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 在页面里装一个帧率探针
await ev(`
  window.__fps = { frames: 0, start: 0, long: 0, last: 0, maxGap: 0 };
  (function loop(t) {
    const f = window.__fps;
    if (!f.start) f.start = t;
    if (f.last) {
      const gap = t - f.last;
      if (gap > 50) f.long++;
      if (gap > f.maxGap) f.maxGap = gap;
    }
    f.last = t;
    f.frames++;
    requestAnimationFrame(loop);
  })(performance.now());
  'armed'
`)

async function measure(label, secs = 3) {
  await ev(`(()=>{const f=window.__fps;f.frames=0;f.start=0;f.last=0;f.long=0;f.maxGap=0;return 1})()`)
  await sleep(secs * 1000)
  const r = await ev(`(()=>{const f=window.__fps;const dur=(f.last-f.start)/1000;return JSON.stringify({frames:f.frames,dur:+dur.toFixed(2),fps:+(f.frames/dur).toFixed(1),longFrames:f.long,maxGap:+f.maxGap.toFixed(1)})})()`)
  console.log(label.padEnd(24), r)
  return JSON.parse(r)
}

const info = await ev(`(()=>{const v=document.querySelector('video');const c=[...document.querySelectorAll('canvas')][0];return JSON.stringify({t:+v.currentTime.toFixed(1),rate:v.playbackRate,paused:v.paused,cw:c&&c.width,ch:c&&c.height,visible:!!c})})()`)
console.log('状态:', info, '\n')

console.log('=== 弹幕渲染帧率 ===')
const a = await measure('1x 播放中')

await ev(`(()=>{document.querySelector('video').playbackRate=2;return 1})()`)
await sleep(1200)
const b = await measure('2x 播放中')

console.log('\n=== 结论 ===')
console.log(`1x: ${a.fps} fps, 长帧 ${a.longFrames} 个, 最大间隔 ${a.maxGap}ms`)
console.log(`2x: ${b.fps} fps, 长帧 ${b.longFrames} 个, 最大间隔 ${b.maxGap}ms`)
console.log(a.fps >= 50 ? '✅ 流畅（>=50fps）' : a.fps >= 30 ? '⚠️ 可接受（30-50fps）' : '❌ 卡顿（<30fps）')

ws.close()
