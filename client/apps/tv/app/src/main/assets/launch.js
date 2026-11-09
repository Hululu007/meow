// danmu_api 的启动器。
//
// 为什么需要它：Android 上没有控制台，libnode 的 stdout/stderr 直接被丢弃，
// 服务起不来时只能看到"端口没监听"，看不到任何原因。这里把 console.* 和
// 未捕获异常重定向到 node.log（adb run-as 可读），再动态 import 真正的服务。
//
// 只做转发，不改变 danmu_api 的任何行为。
import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const logPath = path.join(dir, 'node.log')
const log = fs.createWriteStream(logPath, { flags: 'a' })

function write(line) {
  try { log.write(line + '\n') } catch (e) {}
}

for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
  const orig = console[m] ? console[m].bind(console) : () => {}
  console[m] = (...a) => {
    try { write(util.format(...a)) } catch (e) { orig(...a) }
  }
}

process.on('uncaughtException', (e) => write('uncaught: ' + ((e && e.stack) || e)))
process.on('unhandledRejection', (e) => write('unhandled: ' + ((e && e.stack) || e)))

write('--- launcher start ' + new Date().toISOString() + ' cwd=' + process.cwd())

await import('./danmu_api/server.js')
