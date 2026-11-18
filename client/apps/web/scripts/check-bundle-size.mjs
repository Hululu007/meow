/**
 * 包体门禁（E13）。
 *
 * 基线：2026-11-18 视觉升级前 dist/assets = 2.5 MiB。
 * 阈值：+10%。超过就失败，提示先看新增大图/字体/壁纸。
 *
 * 用法：node scripts/check-bundle-size.mjs [dist目录]
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(process.argv[2] || 'dist')
const root = join(dist, 'assets')
const BASELINE = 2.5 * 1024 * 1024
const LIMIT = BASELINE * 1.1

if (!existsSync(root)) {
  console.error(`[size] 找不到 ${root}，先跑 pnpm build`)
  process.exit(2)
}

function walk(dir) {
  let total = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) total += walk(p)
    else total += st.size
  }
  return total
}

const size = walk(root)
const mib = size / 1024 / 1024
const limitMib = LIMIT / 1024 / 1024
console.log(`[size] assets = ${mib.toFixed(2)} MiB（基线 2.50，阈值 ${limitMib.toFixed(2)}）`)
if (size > LIMIT) {
  console.error('[size] 超出预算：先检查新增壁纸/字体/未压缩图片')
  process.exit(1)
}
