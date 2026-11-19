#!/usr/bin/env node
/**
 * 构建前的生成步骤。
 *
 * 技术文档已经迁到 site/docs/dev/ 并纳入版本管理，不再需要复制与链接重写。
 * 这里只剩三件事：
 *   - 更新日志：从仓库 CHANGELOG.md 裁出面向用户的正文
 *   - 品牌资源：从 client/brand/ 复制到 docs/public/
 *   - 独立编排：从 deploy/docker/ 复制到 docs/public/（供「不 clone 直接下」）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const siteRoot = join(here, '..')

/**
 * 发版信息：只认「形成发版资产」的 tag（全量 release-v*；部分发版 fpk-v* / tv-v* /
 * pc-v* / plugins-v* / tv-plugins-* / ipa-v*）。无前缀 v* 只是版本标记、不产出资产，不算发版。
 * 只取当前 HEAD 可达的 tag：公开库的更新日志只列公开历史里真实发过的版本。
 * 没有 tag（浅克隆等）时返回空表，调用方回退为「不过滤」。
 */
function releaseInfo() {
  let out = ''
  try {
    // ★ 用 execFileSync 而不是 execSync：Windows 的 execSync 走 cmd，
    //   format 里的 `|` 会被当成管道（单引号在 cmd 不生效），命令直接失败。
    //   git ref 名不允许空格，所以用空格分隔两个字段是安全的。
    out = execFileSync(
      'git',
      ['for-each-ref', '--merged=HEAD', '--format=%(refname:short) %(creatordate:short)', 'refs/tags'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return { dates: {}, released: new Set() }
  }
  const prefixes = ['tv-plugins-', 'release-', 'plugins-', 'docker-', 'fpk-', 'ipa-', 'pc-', 'tv-']
  const rankOf = (p) => (p === 'release-' ? 0 : 2)
  const best = {}
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const tag = parts[0]
    const date = parts[1]
    const pref = prefixes.find((p) => tag.startsWith(p))
    if (!pref) continue // 无前缀 v* 等只是标记，不算发版资产
    const ver = tag.slice(pref.length).replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+(?:-fix\d+)?$/.test(ver)) continue
    const rank = rankOf(pref)
    if (!best[ver] || rank < best[ver].rank) best[ver] = { rank, date }
  }
  const dates = {}
  for (const [ver, v] of Object.entries(best)) dates[ver] = v.date
  return { dates, released: new Set(Object.keys(best)) }
}

function syncChangelog() {
  const src = join(repoRoot, 'CHANGELOG.md')
  if (!existsSync(src)) throw new Error('缺少 CHANGELOG.md')

  const raw = readFileSync(src, 'utf8')
  // 第一个版本小节之前是「怎么写」等维护说明，对访客是噪音
  const start = raw.search(/^## \d/m)
  if (start < 0) throw new Error('CHANGELOG.md 里找不到版本小节')

  // 版本日期取自发版 tag；CHANGELOG.md 本体保持不带日期，verify.ps1 的格式门禁不受影响。
  // 日期渲染成标题下方的小字（时间轴样式见 theme/custom.css 的 .changelog-page）。
  const { dates, released } = releaseInfo()
  const kept = []
  for (const block of raw.slice(start).trim().split(/\n(?=## )/)) {
    const m = /^## (\d+\.\d+\.\d+(?:-fix\d+)?)[ \t]*\r?\n/.exec(block)
    if (!m) continue
    const ver = m[1]
    // 没形成发版资产的版本不进站点（如只写进 CHANGELOG、未打 release tag 的修正版）
    if (released.size > 0 && !released.has(ver)) continue
    const date = dates[ver]
    const rest = block.slice(m[0].length).trim()
    kept.push(`## ${ver}` + (date ? `\n\n<p class="cl-date">${date}</p>` : '') + '\n\n' + rest)
  }
  if (kept.length === 0) throw new Error('过滤后没有任何版本可展示（tag 或 CHANGELOG 异常）')
  const versions = kept.join('\n\n')
  const page = `---
outline: [2, 3]
editLink: false
pageClass: changelog-page
---

# 更新日志

> 本页由仓库根目录的 [CHANGELOG.md](https://github.com/upchr/meow/blob/main/CHANGELOG.md)
> 自动生成，**改它请改那份文件**，不要改这里。客户端内的更新弹框读的也是同一份。
> 本页只列已形成发版资产的版本（全量发版或部分发版）；日期取自发版 tag。

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

function copyCompose() {
  const src = join(repoRoot, 'deploy', 'docker', 'docker-compose.standalone.yml')
  if (!existsSync(src)) throw new Error('缺少 deploy/docker/docker-compose.standalone.yml')
  const publicDir = join(siteRoot, 'docs', 'public')
  mkdirSync(publicDir, { recursive: true })
  copyFileSync(src, join(publicDir, 'docker-compose.yml'))
  console.log('[sync] 独立编排 → docs/public/docker-compose.yml')
}

syncChangelog()
copyBrand()
copyCompose()
