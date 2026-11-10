#!/usr/bin/env node
/**
 * 把仓库里的技术文档同步进文档站。
 *
 * 为什么是生成而不是手工复制：`docs/` 与 `CHANGELOG.md` 是唯一真源，
 * 复制一份进站就会出现两处维护、慢慢分叉。
 *
 * 生成物：
 *   docs/dev/*.md             ← docs/��的 9 篇技术文档（链接已重写）
 *   docs/dev/index.md         ← docs/00-目录索引.md（改写成站内索引）
 *   docs/reference/changelog.md ← CHANGELOG.md（裁掉「怎么写」等维护小节）
 *
 * 这些文件都在 .gitignore 里，构建前由 `pnpm run sync` 重建。
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const siteRoot = join(here, '..')
const docsOut = join(siteRoot, 'docs', 'dev')
const repoDocs = join(repoRoot, 'docs')
const GH = 'https://github.com/upchr/meow'
const GH_BLOB = `${GH}/blob/main`
const GH_RAW = `${GH}/raw/main`

/** 只有列在这里的文档才进站（公开壳只保留架构与实现相关文档）。 */
const DEV_DOCS = [
  { file: '25-三端架构.md', slug: 'architecture' },
  { file: '26-接口契约.md', slug: 'api-contract' },
  { file: '27-前端手册.md', slug: 'frontend' },
  { file: '28-TV接入.md', slug: 'tv-integration' },
  { file: '33-插件系统.md', slug: 'plugin-system' },
  { file: '36-Docker部署.md', slug: 'docker' },
  { file: '37-片库与离线缓存.md', slug: 'library-cache' },
  { file: '46-TV签名.md', slug: 'tv-signing' },
  { file: '47-AI助手.md', slug: 'ai-assistant' },
]

const slugByFile = new Map(DEV_DOCS.map((d) => [d.file, d.slug]))

/** 把文档里的相对链接改写成站内链接或 GitHub 链接，否则 VitePress 会报死链。 */
function rewriteLinks(content, sourceFile) {
  const fromDir = 'docs'

  return content.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, bang, text, href, title = '') => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(href)) return whole

    const [rawPath, ...hashParts] = href.split('#')
    const hash = hashParts.length ? `#${hashParts.join('#')}` : ''
    if (!rawPath) return whole

    // 同目录的技术文档：按 slug 重命名后仍留在 ./dev/ 下
    const base = posix.basename(rawPath)
    const slug = slugByFile.get(base)
    if (slug) return `${bang}[${text}](./${slug}.md${hash})`

    // 其他仓库内相对路径：解析成 GitHub 上的绝对地址
    const resolved = posix.normalize(posix.join(fromDir, rawPath))
    const url = bang ? `${GH_RAW}/${resolved}` : `${GH_BLOB}/${resolved}`
    return `${bang}[${text}](${url}${hash})${title}`
  })
}

function syncDevDocs() {
  mkdirSync(docsOut, { recursive: true })

  for (const { file, slug } of DEV_DOCS) {
    const src = join(repoDocs, file)
    if (!existsSync(src)) {
      throw new Error(`缺少技术文档：docs/${file}`)
    }
    const body = rewriteLinks(readFileSync(src, 'utf8'), file)
    const banner = `<!-- 由 site/scripts/sync-docs.mjs 从 docs/${file} 生成，请勿直接编辑 -->\n\n`
    writeFileSync(join(docsOut, `${slug}.md`), banner + body, 'utf8')
  }

  // 目录索引改写成站内索引（原文的链接已被 rewriteLinks 处理过）
  const indexSrc = join(repoDocs, '00-目录索引.md')
  if (existsSync(indexSrc)) {
    const body = rewriteLinks(readFileSync(indexSrc, 'utf8'), '00-目录索引.md')
    const banner = '<!-- 由 site/scripts/sync-docs.mjs 从 docs/00-目录索引.md 生成，请勿直接编辑 -->\n\n'
    writeFileSync(join(docsOut, 'index.md'), banner + body, 'utf8')
  }

  console.log(`[sync] 技术文档 ${DEV_DOCS.length} 篇 → docs/dev/`)
}

function syncChangelog() {
  const src = join(repoRoot, 'CHANGELOG.md')
  if (!existsSync(src)) throw new Error('缺少 CHANGELOG.md')
  mkdirSync(join(siteRoot, 'docs', 'reference'), { recursive: true })

  const raw = readFileSync(src, 'utf8')
  // 第一个版本小节之前是「怎么写」等维护说明，对访客是噪音
  const start = raw.search(/^## \d/m)
  if (start < 0) throw new Error('CHANGELOG.md 里找不到版本小节')

  const versions = raw.slice(start).trim()
  const page = `---
outline: [2, 3]
---

# 更新日志

每个版本的改动说明。客户端内的更新弹框读取的也是这份内容。

> 版本号与打包产物的对应关系见 [下载与版本](../reference/downloads.md)。

${versions}
`
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

syncDevDocs()
syncChangelog()
copyBrand()
