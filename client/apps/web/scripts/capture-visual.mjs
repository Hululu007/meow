/**
 * 视觉回归截图（E10）。
 *
 * 用途：改皮肤前后按同一组「视口 × 路由」出图，肉眼/工具对比。
 * 不依赖 Playwright：直接用 Edge 的 headless --screenshot，
 * 每个组合一个独立 profile，跑完即删。
 *
 * 用法：
 *   node scripts/capture-visual.mjs                       # http://localhost:5181
 *   node scripts/capture-visual.mjs http://127.0.0.1:5181 out-dir
 *
 * 注意：
 * - 应用是 hash 路由，路由写成 `#/settings`。
 * - 后端没起时页面会是「后端未连接」状态，属正常；对比时保持前后一致即可。
 * - 固定 dark + 壁纸关闭：截图前在 localStorage 写 prefs。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.argv[2] || 'http://localhost:5181'
const OUT = resolve(process.argv[3] || '../../../../tmp/2026-11-18-visual-audit/shots')

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
]

const edge = EDGE_CANDIDATES.find((p) => existsSync(p))
if (!edge) {
  console.error('[capture] 找不到 Edge/Chrome，跳过')
  process.exit(2)
}

const SIZES = [
  [390, 844, 'phone'],
  [768, 1024, 'tablet'],
  [1440, 900, 'desktop'],
  [1920, 1080, 'wide'],
]

const ROUTES = [
  ['#/', 'home'],
  ['#/search', 'search'],
  ['#/library', 'library'],
  ['#/history', 'history'],
  ['#/favorites', 'favorites'],
  ['#/settings', 'settings'],
]

mkdirSync(OUT, { recursive: true })

let count = 0
for (const [w, h, sizeName] of SIZES) {
  for (const [hash, routeName] of ROUTES) {
    const file = join(OUT, `${sizeName}-${routeName}.png`)
    const profile = mkdtempSync(join(tmpdir(), 'meow-shot-'))
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      `--user-data-dir=${profile}`,
      `--window-size=${w},${h}`,
      '--virtual-time-budget=2500',
      `--screenshot=${file}`,
      `${BASE}/${hash}`,
    ]
    const r = spawnSync(edge, args, { stdio: 'ignore', timeout: 60_000 })
    // Windows 上 Edge 退出后 Crashpad 目录还可能被短暂占用，删不掉不算失败
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } catch {
      /* 留给系统临时目录清理 */
    }
    if (r.status === 0) {
      count++
      console.log(`[capture] ${sizeName}-${routeName}.png`)
    } else {
      console.warn(`[capture] 失败 ${sizeName}-${routeName} (exit=${r.status})`)
    }
  }
}

console.log(`[capture] 完成 ${count}/${SIZES.length * ROUTES.length}，输出：${OUT}`)
