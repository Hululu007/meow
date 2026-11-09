// 最小 smoke 载荷：验证 TV 端能真的起 node 并对外提供服务。
// 同时跑一个 worker_threads + Atomics.wait 自检 —— 这是 drpy 的 sync-fetch
// 依赖的机制（同步阻塞主线程等 worker 回写），验不过就说明 drpy 在 TV 上跑不了。
'use strict';

const http = require('node:http');
const { Worker } = require('node:worker_threads');

const PORT = Number(process.env.MEOW_NODE_PORT || 19340);

function atomicsSelfTest() {
  return new Promise((resolve) => {
    // 4 字节 Int32 共享内存 + 1 个 worker 写入并 Atomics.notify
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
       const v = new Int32Array(workerData);
       Atomics.store(v, 0, 42);
       Atomics.notify(v, 0);`,
      { eval: true, workerData: sab }
    );
    const timer = setTimeout(() => {
      try { worker.terminate(); } catch (e) {}
      resolve({ ok: false, reason: 'timeout' });
    }, 3000);
    worker.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: String(e && e.message || e) });
    });
    worker.on('exit', () => {
      // 故意不在 exit 里判定：Atomics.wait 要求同步阻塞，这里模拟 sync-fetch
      clearTimeout(timer);
    });
    // 同步阻塞主线程，等 worker notify（这正是 sync-fetch 的模型）
    const waited = Atomics.wait(view, 0, 0, 3000);
    clearTimeout(timer);
    try { worker.terminate(); } catch (e) {}
    resolve({ ok: Atomics.load(view, 0) === 42, wait: waited, value: Atomics.load(view, 0) });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/selftest') {
    const r = await atomicsSelfTest();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node: process.version, pid: process.pid, atomics: r }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    node: process.version,
    pid: process.pid,
    cwd: process.cwd(),
    url: req.url,
    at: Date.now(),
  }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[meow-node] listening on ' + PORT + ' (node ' + process.version + ')');
});
