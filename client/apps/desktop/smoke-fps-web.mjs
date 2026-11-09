const list = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json())
const p = list.find(t => t.type === 'page' && t.url.includes('localhost:5173'))
if (!p) { console.log('no page'); process.exit(1) }
const ws = new WebSocket(p.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let id = 0; const pending = new Map()
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise(r => pending.set(i, r)) }
async function ev(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value }
const sleep = ms => new Promise(r => setTimeout(r, ms))
await ev(`window.__fps={frames:0,start:0,long:0,last:0,maxGap:0};(function loop(t){const f=window.__fps;if(!f.start)f.start=t;if(f.last){const g=t-f.last;if(g>50)f.long++;if(g>f.maxGap)f.maxGap=g}f.last=t;f.frames++;requestAnimationFrame(loop)})(performance.now());'ok'`)
async function measure(label, secs=3){ await ev(`(()=>{const f=window.__fps;f.frames=0;f.start=0;f.last=0;f.long=0;f.maxGap=0;return 1})()`); await sleep(secs*1000); const r = await ev(`(()=>{const f=window.__fps;const d=(f.last-f.start)/1000;return JSON.stringify({fps:+(f.frames/d).toFixed(1),long:f.long,maxGap:+f.maxGap.toFixed(1)})})()`); console.log(label.padEnd(20), r); return JSON.parse(r) }
const st = await ev(`(()=>{const v=document.querySelector('video');const c=document.querySelector('canvas');return JSON.stringify({t:+v.currentTime.toFixed(1),rate:v.playbackRate,cw:c&&c.width})})()`)
console.log('状态:', st, '\n=== Web 场景弹幕帧率（位图缓存） ===')
const a = await measure('1x')
await ev(`(()=>{document.querySelector('video').playbackRate=2;return 1})()`); await sleep(1200)
const b = await measure('2x')
await ev(`(()=>{document.querySelector('video').playbackRate=3;return 1})()`); await sleep(1200)
const c = await measure('3x')
console.log('\n结论:', a.fps>=55?'✅ 优秀':a.fps>=50?'✅ 流畅':'⚠️ 仍可优化')
ws.close()
