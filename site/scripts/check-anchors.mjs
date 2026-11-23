#!/usr/bin/env node
/**
 * 站内锚点门禁。
 *
 * `vitepress build` 只校验页面链接，不校验 `#片段`：标题里带中文标点时
 * （例如 `## 一、Docker（最省事）` 生成的 id 是 `一、docker-最省事`），
 * 链接写成 `#一-docker-最省事` 也能构建通过，但点击不会跳。
 * 2026-11-23 就是这么漏掉快速开始首屏 4 个锚点的。
 *
 * 用法：node scripts/check-anchors.mjs [dist目录]
 * 退出码 1 = 有坏锚点。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const BASE = '/meow'
const dist = process.argv[2] || '.vitepress/dist'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.html')) out.push(full)
  }
  return out
}

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function collect(html) {
  // 页面内联脚本里有路由数据，先剥掉，避免把 JSON 里的字符串当成 id/href
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const ids = new Set()
  const hrefs = []
  for (const m of body.matchAll(/\sid="([^"]*)"/g)) ids.add(decode(m[1]))
  for (const m of body.matchAll(/<a\b[^>]*\shref="([^"]*)"/gi)) hrefs.push(decode(m[1]))
  return { ids, hrefs }
}

const pages = new Map()
for (const file of walk(dist)) {
  const rel = '/' + relative(dist, file).split(sep).join('/')
  pages.set(rel, collect(readFileSync(file, 'utf8')))
}

const bad = []
let checked = 0

for (const [page, { hrefs }] of pages) {
  for (const href of hrefs) {
    if (!href.includes('#') || /^(?:https?:)?\/\//i.test(href) || href.startsWith('mailto:')) continue
    const [rawTarget, rawFrag = ''] = href.split('#')
    const frag = decode(rawFrag)
    if (!frag || frag === 'top') continue
    checked++

    let target = page
    if (rawTarget) {
      let t = decode(rawTarget)
      if (!t.startsWith('/')) continue // 相对链接交给 vitepress 自己的校验
      if (t === BASE) t = '/'
      else if (t.startsWith(BASE + '/')) t = t.slice(BASE.length)
      if (t.endsWith('/')) t += 'index.html'
      target = t
    }

    const entry = pages.get(target)
    if (!entry) {
      bad.push(`${page} -> ${href} (页面不存在: ${target})`)
      continue
    }
    if (!entry.ids.has(frag)) bad.push(`${page} -> ${href} (锚点不存在: ${target}#${frag})`)
  }
}

const unique = [...new Set(bad)]
console.log(`锚点检查：${pages.size} 页 / ${checked} 个锚点 / ${unique.length} 个失效`)
for (const row of unique) console.log('  ' + row)
if (unique.length) process.exit(1)
