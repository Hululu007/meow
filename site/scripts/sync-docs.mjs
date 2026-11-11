#!/usr/bin/env node
/**
 * 构建前的生成步骤。
 *
 * 技术文档已经迁到 site/docs/dev/ 并纳入版本管理，不再需要复制与链接重写。
 * 这里只剩两件事：
 *   - 更新日志：从仓库 CHANGELOG.md 裁出面向用户的正文
 *   - 品牌资源：从 client/brand/ 复制到 docs/public/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const siteRoot = join(here, '..')

function syncChangelog() {
  const src = join(repoRoot, 'CHANGELOG.md')
  if (!existsSync(src)) throw new Error('缺少 CHANGELOG.md')

  const raw = readFileSync(src, 'utf8')
  // 第一个版本小节之前是「怎么写」等维护说明，对访客是噪音
  const start = raw.search(/^## \d/m)
  if (start < 0) throw new Error('CHANGELOG.md 里找不到版本小节')

  const versions = raw.slice(start).trim()
  const page = `---
outline: [2, 3]
editLink: false
---

# 更新日志

> 本页由仓库根目录的 [CHANGELOG.md](https://github.com/upchr/meow/blob/main/CHANGELOG.md)
> 自动生成，**改它请改那份文件**，不要改这里。客户端内的更新弹框读的也是同一份。

版本号与打包产物的对应关系见 [下载与版本](../reference/downloads.md)。

${versions}
`
  mkdirSync(join(siteRoot, 'docs', 'reference'), { recursive: true })
  writeFileSync(join(siteRoot, 'docs', 'reference', 'changelog.md'), page, 'utf8')
  console.log('[sync] CHANGELOG.md → docs/reference/changelog.md')
}

function copyBrand() {
  const publicDir = join(siteRoot, 'docs', 'public')
  mkdirSync(publicDir, { recursive: true })
  for (const name of ['logo.svg', 'logo-192.png', 'logo-512.png']) {
    const src = join(repoRoot, 'client', 'brand', name)
    if (existsSync(src)) copyFileSync(src, join(publicDir, name))
  }
  console.log('[sync] 品牌资源 → docs/public/')
}

syncChangelog()
copyBrand()
