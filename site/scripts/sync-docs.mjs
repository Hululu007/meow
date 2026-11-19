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
 * 版本 → 发版日期：取 tag 的提交日期（`creatordate`）。
 * 同一版本可能有多个 tag（release-v* / fpk-v* / tv-v* …），优先 release-v*，其次无前缀 v*。
 * 浅克隆拿不到 tag 时返回空表，页面就不带日期（不会报错）。
 */
function versionDates() {
  let out = ''
  try {
    // ★ 用 execFileSync 而不是 execSync：Windows 的 execSync 走 cmd，
    //   format 里的 `|` 会被当成管道（单引号在 cmd 不生效），命令直接失败。
    //   git ref 名不允许空格，所以用空格分隔两个字段是安全的。
    out = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short) %(creatordate:short)', 'refs/tags'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    return {}
  }
  const prefixes = ['tv-plugins-', 'release-', 'plugins-', 'docker-', 'fpk-', 'ipa-', 'pc-', 'tv-']
  const rankOf = (p) => (p === 'release-' ? 0 : p === '' ? 1 : 2)
  const best = {}
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const tag = parts[0]
    const date = parts[1]
    const pref = prefixes.find((p) => tag.startsWith(p)) ?? ''
    const ver = tag.slice(pref.length).replace(/^v/, '')
    if (!/^\d+\.\d+\.\d+(?:-fix\d+)?$/.test(ver)) continue
    const rank = rankOf(pref)
    if (!best[ver] || rank < best[ver].rank) best[ver] = { rank, date }
  }
  const map = {}
  for (const [ver, v] of Object.entries(best)) map[ver] = v.date
  return map
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
  const dates = versionDates()
  let isFirstVersion = true
  const versions = raw
    .slice(start)
    .trim()
    .replace(/^## (\d+\.\d+\.\d+(?:-fix\d+)?)[ \t]*$/gm, (line, ver) => {
      const first = isFirstVersion
      isFirstVersion = false
      const date = dates[ver]
      if (date) return `## ${ver}\n\n<p class="cl-date">${date}</p>`
      // 只有最新一版可能是「写进 CHANGELOG 但还没打 tag」；更老的版本没 tag 就不显示日期
      return first ? `## ${ver}\n\n<p class="cl-date cl-date--pending">尚未发版</p>` : line
    })
  const page = `---
outline: [2, 3]
editLink: false
pageClass: changelog-page
---

# 更新日志

> 本页由仓库根目录的 [CHANGELOG.md](https://github.com/upchr/meow/blob/main/CHANGELOG.md)
> 自动生成，**改它请改那份文件**，不要改这里。客户端内的更新弹框读的也是同一份。
> 版本号下方的小字是发版日期（取自发版 tag）；尚未发版的版本标注「尚未发版」。

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
