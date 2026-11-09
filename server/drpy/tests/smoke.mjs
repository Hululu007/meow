/**
 * drpy 运行时的宿主契约测试（**不联网**、不依赖 drpy2）。
 *
 * 跑法：`cd server/drpy && npm test`
 *
 * 覆盖：ESM→CJS 转换（含 CJS default 兼容）、`req().content` 形状、
 * `String.prototype.rstrip`、`cheerio.jinja2`、`compatPatch`（let/var 冲突）、
 * 以及动作分派。
 *
 * 为什么不连真实站点：CI 与受限环境都可能没有出网；而且真实 drpy2
 * 有 64KB 且会 import 第三方 CDN，两个都不适合进仓库。
 * 需要验真实 HTTP 时另用 `scripts/verify-drpy-live.mjs`（手动、需网络）。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { loadSpider } = require('../host.js')

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log('PASS | ' + name)
  } else {
    fail++
    console.log('FAIL | ' + name + (detail ? ' | ' + detail : ''))
  }
}

/** 固定数据的 req 替身：形状必须与宿主一致（对象 + content + 可字符串化） */
function fakeReq(url) {
  const u = new URL(url)
  let body
  if (u.pathname === '/api/home') {
    body = { classes: [{ id: '1', name: '电影' }, { id: '2', name: '剧集' }] }
  } else if (u.pathname === '/api/list') {
    const t = u.searchParams.get('type') || '1'
    body = { list: [1, 2, 3].map((i) => ({ id: t + '-' + i, name: '片名 ' + i })) }
  } else if (u.pathname === '/api/search') {
    body = { list: [{ id: 's1', name: '搜索结果 ' + (u.searchParams.get('wd') || '') }] }
  } else {
    body = {}
  }
  const content = JSON.stringify(body)
  const out = { code: 200, headers: {}, content }
  out.toString = () => content
  return out
}

function localPath(rel) {
  return new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
}

async function main() {
  const spider = await loadSpider(localPath('../tests/stub-engine.js'), 'http://fake.local/', { req: fakeReq })

  check('脚本加载出 home/category/search', typeof spider.home === 'function' && typeof spider.category === 'function')

  const home = await spider.home()
  check('home 返回 2 个分类', (home.class || []).length === 2, JSON.stringify(home.class))
  check('req().content 拿到正文', home.class[0].type_name === '电影', JSON.stringify(home.class[0]))
  check('String.prototype.rstrip 生效', spider.host === 'http://fake.local', String(spider.host))
  check('cheerio.jinja2 渲染 {{...}}', home.filterUrl === 'area=1&page=2', String(home.filterUrl))

  const cat = await spider.category('2', '1')
  check('category 返回 3 条', (cat.list || []).length === 3, JSON.stringify(cat.list))
  check('category vod_id 正确', cat.list[0].vod_id === '2-1', JSON.stringify(cat.list[0]))

  const se = await spider.search('测试')
  check('search 返回 1 条', (se.list || []).length === 1, JSON.stringify(se.list))

  console.log('')
  console.log('===== ' + pass + '/' + (pass + fail) + ' 通过 =====')
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.log('FATAL', e && e.stack)
  process.exit(1)
})
