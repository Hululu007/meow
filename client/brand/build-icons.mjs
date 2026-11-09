#!/usr/bin/env node
/**
 * 从 logo.svg 生成全部图标资产。
 *
 *   node brand/build-icons.mjs
 *
 * 生成：
 *   apps/web/public/  icon.png / icon-192 / apple-touch-icon / favicon-16,32 / favicon.ico
 *   brand/            logo-{1024,512,256,192,128,64,48,32,16}.png + tauri-icon.png
 *
 * 改完 svg 后跑这个，再跑 `npx tauri icon brand/tauri-icon.png` 更新桌面端图标。
 */
import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SVG = path.join(ROOT, 'brand', 'logo.svg')
const PUB = path.join(ROOT, 'apps', 'web', 'public')
const BRAND = path.join(ROOT, 'brand')

const svg = fs.readFileSync(SVG)
const render = (size) => sharp(svg, { density: 512 }).resize(size, size).png()

/** ICO 容器：直接内嵌 PNG（Vista+ 与所有主流浏览器都支持） */
function buildIco(pngs, sizes) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = Buffer.alloc(16 * pngs.length)
  let offset = 6 + 16 * pngs.length
  pngs.forEach((buf, i) => {
    const s = sizes[i]
    const e = 16 * i
    entries.writeUInt8(s >= 256 ? 0 : s, e)
    entries.writeUInt8(s >= 256 ? 0 : s, e + 1)
    entries.writeUInt16LE(1, e + 4)
    entries.writeUInt16LE(32, e + 6)
    entries.writeUInt32LE(buf.length, e + 8)
    entries.writeUInt32LE(offset, e + 12)
    offset += buf.length
  })
  return Buffer.concat([header, entries, ...pngs])
}

// ---- Web ----
const webTargets = [
  ['icon.png', 512],
  ['icon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
]
for (const [name, size] of webTargets) {
  await render(size).toFile(path.join(PUB, name))
  console.log('web   ', name, size)
}

const icoSizes = [16, 24, 32, 48]
const icoPngs = await Promise.all(icoSizes.map((s) => render(s).toBuffer()))
fs.writeFileSync(path.join(PUB, 'favicon.ico'), buildIco(icoPngs, icoSizes))
console.log('web    favicon.ico', icoSizes.join('/'))

// ---- 品牌源 ----
for (const s of [1024, 512, 256, 192, 128, 64, 48, 32, 16]) {
  await render(s).toFile(path.join(BRAND, `logo-${s}.png`))
}
await render(1024).toFile(path.join(BRAND, 'tauri-icon.png'))
console.log('brand  logo-{1024..16}.png + tauri-icon.png')
