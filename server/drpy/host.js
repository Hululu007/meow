/**
 * drpy 运行时：在 Node 里执行 `.js` 源脚本。
 *
 * 为什么独立进程而不是嵌进 Java 宿主：
 *   1) CatVod 上游自己就是外挂 Node 服务（`NodeRuntimeApi.SERVICE_CLASS`）；
 *   2) drpy 脚本按 Node/QuickJS 的全局（req/pdfh/pdfa…）编写，Node 下行为最一致；
 *   3) PC 发布包里本来就有 node.exe（danmu 插件带），Docker 加一个容器即可。
 *
 * 本文件只做"宿主全局 + 脚本加载"，不实现任何具体的源逻辑。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const crypto = require('crypto')
const cheerio = require('cheerio')
const fetchSync = require('sync-fetch')

/** 同步等待：drpy 的 sleep() 是同步语义 */
function sleepSync(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(n, 10000))
}

/**
 * drpy 的选择器不是 CSS，而是 `div.item&&a&&href` 这种链式写法：
 *   - 用 `&&` 分段；
 *   - 最后一段是"取什么"：Text / Html / 属性名；
 *   - 前面的段是逐级 CSS 选择。
 * cheerio 原生支持 `:eq(n)` / `:first` / `:contains`，所以前面几段可以直接喂。
 */
function pickExtractor(seg) {
  const s = (seg || '').trim()
  if (!s) return { kind: 'text', name: '' }
  if (/^text$/i.test(s)) return { kind: 'text', name: '' }
  if (/^html$/i.test(s)) return { kind: 'html', name: '' }
  if (/^outerhtml$/i.test(s)) return { kind: 'outer', name: '' }
  return { kind: 'attr', name: s }
}

function splitSelector(selector) {
  const parts = String(selector || '')
    .split('&&')
    .map((x) => x.trim())
    .filter(Boolean)
  // 没有 `&&` 时按 drpy 的约定返回**元素自身 HTML**（这样能接着往下查），
  // 不是文本。想要文本必须写 `&&Text`——脚本里几乎都会显式写。
  if (parts.length === 0) return { steps: [], extract: { kind: 'outer', name: '' } }
  if (parts.length === 1) return { steps: parts, extract: { kind: 'outer', name: '' } }
  return { steps: parts.slice(0, -1), extract: pickExtractor(parts[parts.length - 1]) }
}

/** 解析单条选择器链；`list` 为 true 时返回数组 */
function runQuery(html, selector, list) {
  const { steps, extract } = splitSelector(selector)
  if (!html) return list ? [] : ''
  const $ = cheerio.load(String(html))
  let nodes = null // null 表示"还没选，从文档根开始"
  for (const step of steps) {
    // 首段必须用 `$(step)`：cheerio 函数本身没有 .find()，
    // 写成 `$.find(step)` 会直接 TypeError（实测踩过）。
    nodes = nodes === null ? $(step) : nodes.find(step)
    if (!nodes || nodes.length === 0) return list ? [] : ''
  }
  if (steps.length === 0) nodes = $.root().children()
  if (list) {
    return nodes
      .toArray()
      .map((el) => extractFrom($, el, extract))
      .filter((x) => x !== '')
  }
  const first = nodes.first()
  return first.length ? extractFrom($, first.get(0), extract) : ''
}

function extractFrom($, el, extract) {
  if (extract.kind === 'text') return $(el).text().trim()
  if (extract.kind === 'html') return $(el).html() || ''
  if (extract.kind === 'outer') return $.html(el) || ''
  const v = $(el).attr(extract.name)
  return v === undefined ? '' : String(v)
}

/**
 * 极简 ESM → CJS 转换 + 模块解析。
 *
 * 为什么需要：生态里 221/298 个源都是 `./lib/drpy2.min.js` 这类**ES 模块**
 * （`import cheerio from "assets://js/lib/cheerio.min.js"`）。不转换的话
 * 连脚本都过不了编译，只能跑极少数自包含脚本。
 *
 * 支持的 specifier：
 *   - `assets://js/lib/x.js` → 插件目录下的 lib/x.js（自托管，离线可用）
 *   - `http(s)://`          → 远程拉取，**默认禁止**（见 DRPY_ALLOW_REMOTE）
 *   - 裸名                   → 走 npm 依赖（cheerio / crypto-js）
 *
 * 远程模块默认关闭不是保守，是必要：实测这份 drpy2.min.js 会
 * `import "https://down.nigx.cn/qu.ax/cLFE.js"` 等三个混淆命名的脚本，
 * 纯副作用导入。默认放行等于每次加载源都执行一份不可控的第三方代码。
 */
const ASSET_ROOT = path.join(__dirname, 'lib')
const moduleCache = new Map()

/**
 * 引擎兼容补丁（drpy2 3.9.x）。
 *
 * drpy2 用**直接 eval** 在函数作用域里执行规则里的 `js:` 脚本，而它自己的
 * 函数体写了 `let d=[]` / `let html=...` 这类累加器；规则脚本普遍写 `var d=...`。
 * 按 ES 规范，`var` 不能与同一作用域的 `let` 同名 → Node/V8 抛
 * `SyntaxError: Identifier 'd' has already been declared`；
 * QuickJS（Fongmi 用的内核）更宽松，所以同一份规则在电视上能跑、在我们这里报错。
 *
 * 处理方式是把这几个**累加器**改回 var：它们在函数内只做线性累加、没有依赖
 * 块级作用域的闭包，var 与 let 语义等价。只改确认过的名字，不做全局 let→var
 * （那会破坏循环里每轮独立的绑定）。
 */
function compatPatch(source) {
  // 用 split/join 而不是正则：这几个补丁经历过一次"正则里的  被工具链
  // 变成退格符"的事故，字面量替换没有转义面，也不会误伤。
  const before = source.split('let d=[]').length - 1
  let out = source.split('let d=[]').join('var d=[]').split('let html=').join('var html=')
  if (process.env.DRPY_DEBUG === '1') {
    console.log('[drpy] compatPatch let-d before=' + before + ' after=' + (out.split('let d=[]').length - 1))
  }
  return out
}

function convertEsm(code) {
  // 只用 String.fromCharCode 拼正则，源码里不出现反斜杠。
  // 原因：这个工程里正则字面量被工具链吃掉转义已经发生过两次
  // （`\b` 变成退格、`\s` 变成 s），而 \s 在 RegExp 字符串里又是必需的。
  const BS = String.fromCharCode(92)
  const WS = BS + 's'
  const NL = String.fromCharCode(10)
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const Q = '[' + DQ + SQ + ']'
  const NQ = '[^' + DQ + SQ + ']'
  // 语句分隔符。除了行首分号换行，还要接受 `}` `)`：压缩过的脚本里
  // 常见 `}}export default{...}`（右花括号后直接跟 export），
  // 只认分号/换行会漏掉这一条，表现为 script eval failed: Unexpected token export。
  const SEP = '(^|[;' + NL + '})])'
  const ID = '([^' + WS + ',{}*]+)'

  const f = (fn) => fn
  const rules = [
    // import {a, b as c} from "spec"
    // **必须排在 `import x from "..."` 之前**：那条的标识符正则
    // ([^\s,{}*]+) 遇到 `import{gbkTool}from"x"`（无空格）时会把
    // `{gbkTool}` 整段当成默认导入名，导致命名导入永远匹配不上。
    // 实测 gao 的 drpy2.min.js 就有这种写法，表现为 script eval failed。
    [new RegExp(SEP + WS + '*import' + WS + '*' + '{([^}]*)}' + WS + '*from' + WS + '*' + Q + '(' + NQ + '+)' + Q, 'g'),
      (m, sep, names, spec) => sep + 'const {' + names + '} = __req(' + JSON.stringify(spec) + ');'],
    // import x from "spec"  （兼容 CJS：没有 default 就用模块本身）
    [new RegExp(SEP + WS + '*import' + WS + '+' + ID + WS + '+from' + WS + '*' + Q + '(' + NQ + '+)' + Q, 'g'),
      (m, sep, name, spec) => sep + 'const ' + name + ' = (function(m){return m && m.default ? m.default : m;})(__req(' + JSON.stringify(spec) + '));'],
    // import * as ns from "spec"
    [new RegExp(SEP + WS + '*import' + WS + '*' + BS + '*' + WS + '*as' + WS + '+([^' + WS + ',{}]+)' + WS + '+from' + WS + '*' + Q + '(' + NQ + '+)' + Q, 'g'),
      (m, sep, name, spec) => sep + 'const ' + name + ' = __req(' + JSON.stringify(spec) + ');'],
    // import "spec"
    [new RegExp(SEP + WS + '*import' + WS + '*' + Q + '(' + NQ + '+)' + Q, 'g'),
      (m, sep, spec) => sep + '__req(' + JSON.stringify(spec) + ');'],
    // export default X
    // default 后面用 * 而不是 +：压缩脚本里常见 `export default{...}`
    // （没有空格），要求至少一个空格会漏掉，表现为 Unexpected token export。
    [new RegExp(SEP + WS + '*export' + WS + '+default' + WS + '*', 'g'),
      (m, sep) => sep + 'module.exports.default = '],
    // export {...} 抹掉（标识符仍在作用域，我们只关心 __JS_SPIDER__）
    [new RegExp('export' + WS + '*{[^}]*}' + WS + '*;?', 'g'), () => ';'],
    // export const/let/var/function/class
    [new RegExp('export' + WS + '+(const|let|var|function|class)' + WS + '+', 'g'), (m, kw) => kw + ' '],
  ]

  let out = code
  for (const [re, fn] of rules) out = out.replace(re, fn)
  return out
}

/**
 * 把源码里的转义字面量还原成真实说明符。
 *
 * 为什么需要：部分规则文件把 `import` 说明符整段写成十六进制转义
 * （源码里就是 `\x61\x73\x73\x65\x74\x73\x3a\x2f\x2f...`，为了避开静态扫描）。
 * convertEsm 用正则从源码抓说明符时抓到的是**未解码的文本**，
 * 再 JSON.stringify 一次就成了字面反斜杠串，`startsWith('assets://')`
 * 判断必然失效 → 掉到末尾 require() → 报
 * `Cannot find module '\x61\x73\x73\x65\x74\x73...'`。
 * 实测 lf_js_* 三个站全是这个原因（占 3/10 失败的全部）。
 *
 * 逐字符扫而不用 JSON.parse：JSON 只认 `\uNNNN`，不认 `\xNN`。
 */
function decodeSpecifier(spec) {
  if (typeof spec !== 'string') return spec
  const BS = String.fromCharCode(92)
  if (spec.indexOf(BS) < 0) return spec
  let out = ''
  for (let i = 0; i < spec.length; i++) {
    const c = spec.charAt(i)
    if (c !== BS) { out += c; continue }
    const n = spec.charAt(i + 1)
    if (n === 'x' || n === 'u') {
      const len = n === 'x' ? 2 : 4
      const hex = spec.substr(i + 2, len)
      if (hex.length === len && !/[^0-9a-fA-F]/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 1 + len
        continue
      }
    }
    out += c
  }
  return out
}

function requireModule(rawSpec) {
  const spec = decodeSpecifier(rawSpec)
  if (moduleCache.has(spec)) return moduleCache.get(spec)

  if (spec.startsWith('assets://')) {
    const rel = spec.replace('assets://js/lib/', '').replace('assets://', '')
    const file = path.join(ASSET_ROOT, rel)
    // 自托管优先：lib/ 下放同名文件就用它（离线、可审计）
    if (fs.existsSync(file)) {
      const mod = evalModule(fs.readFileSync(file, 'utf8'), file)
      moduleCache.set(spec, mod)
      return mod
    }
    // 没有本地副本时退到 npm 同名包（cheerio / crypto-js 最常见）
    const bare = rel.replace(/^js\/lib\//, '').replace(/\.min\.js$/, '').replace(/\.js$/, '')
    try {
      let mod = require(bare)
      if (bare === 'cheerio' || bare === 'cheerio.min') mod = withJinja2(mod)
      moduleCache.set(spec, mod)
      return mod
    } catch (e) {
      throw new Error(`assets not found: ${spec}（把 ${rel} 放进插件 lib/ 目录即可）`)
    }
  }

  if (/^https?:\/\//i.test(spec)) {
    // 三档策略，默认最安全：
    //   DRPY_STRIP_REMOTE=1  → 当作空模块（不执行远程代码）
    //   DRPY_ALLOW_REMOTE=1  → 真正拉取并执行
    //   都不设              → 明确报错（不静默，否则会被误判成"源没数据"）
    // 之所以要 strip 这一档：实测 drpy2.min.js 会纯副作用地 import
    // 三个混淆命名的远程脚本，不执行它们引擎本身仍可用。
    if (process.env.DRPY_STRIP_REMOTE === '1') {
      console.warn('[drpy] strip remote module:', spec)
      // 不能返回裸 {}：实测 drpy2 的 init 第一行就是 `模板.getMubans()`，
      // 属性不存在会直接 TypeError，整个 init 被 try 吞掉，规则永远加载不上。
      // 给一个"任何属性都是空函数"的桩，让不依赖真实实现的调用自然走过。
      // 递归桩：既可调用、又能继续取属性，任意链路都返回它自己。
      // 只返回 undefined 的桩会在 `模板.getMubans().jinja2` 这种链式取值上抛
      // "Cannot read properties of undefined"（实测）。
      const stub = new Proxy(function () {}, {
        get: (t, k) => {
          if (k === Symbol.toPrimitive) return () => ''
          if (k === 'toString' || k === 'valueOf') return () => ''
          return stub
        },
        apply: () => stub,
        construct: () => stub,
        has: () => true,
      })
      moduleCache.set(spec, stub)
      return stub
    }
    if (process.env.DRPY_ALLOW_REMOTE !== '1') {
      throw new Error('remote import blocked: ' + spec + '（设 DRPY_ALLOW_REMOTE=1 执行，或 DRPY_STRIP_REMOTE=1 跳过）')
    }
    const res = fetchSync(spec, { timeout: 15000 })
    const mod = evalModule(res.text(), spec)
    moduleCache.set(spec, mod)
    return mod
  }

  /*
   * ★ 裸模块名必须走白名单（2026-10-30 安全审计修的 C1 逃逸路径）。
   *
   * 原来这里直接 `require(spec)`，而沙箱把 `requireModule` 暴露成了 `__req`
   * （见本文件末尾 `sandbox.__req = ...`）。于是规则脚本里一句
   * `__req('child_process').execSync('...')` 就能在宿主机上执行任意命令
   * —— 实测 `__req('child_process').execSync('echo DRPY_RCE_OK')` 直接返回结果。
   *
   * 现在只放行规则真正会用到的库，其余一律抛错。新增依赖要走白名单，
   * 不能靠"反正 require 得到"。
   */
  if (!ALLOWED_BARE_MODULES.has(spec)) {
    throw new Error('module not allowed: ' + spec
      + '（drpy 只允许 ' + Array.from(ALLOWED_BARE_MODULES).join(' / ') + '）')
  }
  const mod = require(spec)
  moduleCache.set(spec, mod)
  return mod
}

/**
 * 规则脚本允许 require 的裸包名。
 *
 * <p>这些是 drpy 规则生态里真实用到的：模板引擎、HTML 解析、加密、编码转换。
 * **绝不能加**的：`child_process` / `fs` / `net` / `http` / `vm` / `process`
 * —— 任何一个都等于任意代码执行或任意文件读写。
 */
const ALLOWED_BARE_MODULES = new Set([
  'cheerio',
  'cheerio.min',
  'crypto-js',
  'crypto',
  'axios',
  'qs',
  'dayjs',
  'moment',
  'lodash',
  'he',
  'iconv-lite',
  'html-entities',
  'uuid',
  'url',
  'path-browserify',
  'buffer',
  'util',
  'events',
  'string_decoder',
])

/**
 * 给 npm cheerio 补上 CatVod 的 `jinja2` 扩展。
 *
 * drpy2 用 `cheerio.jinja2(rule.homeUrl, {rule})` 把规则里的 `{{rule.host}}`
 * 之类占位符渲染成真实地址（实测 2 处，都在 init 与 category 的 URL 拼装）。
 * 只支持 `{{ a.b.c }}` 取值：URL 模板里不会出现控制流，实现 for/if 只会
 * 增加出错面。
 */
function withJinja2(cheerio) {
  if (cheerio && typeof cheerio.jinja2 === 'function') return cheerio
  const pick = (ctx, path) => {
    if (!ctx) return ''
    const parts = String(path).trim().split('.')
    let cur = ctx
    for (const p of parts) {
      if (cur === undefined || cur === null) return ''
      cur = cur[p]
    }
    return cur === undefined || cur === null ? '' : String(cur)
  }
  const out = Object.assign({}, cheerio)
  out.jinja2 = (template, ctx) => {
    if (typeof template !== 'string') return template
    return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expr) => pick(ctx, expr))
  }
  // 让 `cheerio.load` 等仍然可用（它们依赖 this 绑定，直接引用函数即可）
  out.load = cheerio.load
  return out
}

function evalModule(source, name) {
  // 必须先过 convertEsm：`assets://js/lib/gbk.js` 这类自托管库本身就是 ES 模块
  // （`export function gbkTool(){...}`），直接 new Function 会抛
  // `Unexpected token 'export'`。lib/ 里的文件是可信的，转换后照常执行。
  const code = convertEsm(source)
  const mod = { exports: {} }
  const fn = new Function('module', 'exports', '__req', '__filename', code)
  fn(mod, mod.exports, requireModule, name)
  return mod.exports
}

/** 简单 JSONPath 风格取值：`a.b[0].c` */
function pick(obj, expr) {
  if (!expr) return obj
  try {
    return String(expr)
      .split('.')
      .reduce((acc, key) => {
        if (acc === undefined || acc === null) return undefined
        const m = key.match(/^([^\[\]]*)\[(\d+)\]$/)
        if (m) return (acc[m[1]] || [])[Number(m[2])]
        return acc[key]
      }, obj)
  } catch (e) {
    return undefined
  }
}

function joinUrl(base, url) {
  if (!url) return base || ''
  if (/^https?:\/\//i.test(url)) return url
  try {
    return new URL(url, base || undefined).toString()
  } catch (e) {
    return url
  }
}

/**
 * 构造脚本运行环境。
 *
 * 只实现 drpy 最常用的一层全局；没实现的（aes/rsa/jsp/xbpq 等）显式抛
 * "not implemented" 而不是静默返回空——静默会把"缺能力"伪装成"源没数据"。
 */
/**
 * 注入 vm 上下文的内建扩展（CatVod 宿主约定）。
 * 只补引擎真正用到的：`rstrip` 出现 3 次，其余 strip/lstrip 为 0，不预先发明。
 */
const PROTOTYPE_BOOTSTRAP = `
var __sp = Object.getPrototypeOf('');
if (!__sp.rstrip) {
  __sp.rstrip = function (ch) {
    var s = String(this);
    if (ch === undefined || ch === null || ch === '') return s.replace(/\s+$/, '');
    var set = String(ch).split('');
    var i = s.length;
    while (i > 0 && set.indexOf(s.charAt(i - 1)) >= 0) i--;
    return s.slice(0, i);
  };
}
`

function createSandbox(opts) {
  const localStore = {}
  const sandbox = {
    console: {
      log: (...a) => console.log('[drpy]', ...a),
      error: (...a) => console.error('[drpy]', ...a),
      warn: (...a) => console.warn('[drpy]', ...a),
    },
    setTimeout: (fn) => {
      if (typeof fn === 'function') fn()
      return 0
    },
    clearTimeout: () => {},
    // 注意：**不要**把宿主的 String/Object/Array/JSON 等内建注进来。
    // vm.createContext 自带一整套；注入宿主版本会造成"跨 realm 影子化"——
    // 在上下文里写 `String.prototype.x = ...` 改的是宿主那份，而字符串字面量
    // 用的是上下文那份，于是 `"".x` 永远 undefined（实测卡了很久）。
    // 只放 Node 特有的、上下文里没有的东西。
    Buffer,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    parseInt,
    parseFloat,
    isNaN,
    URL,
    URLSearchParams,
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
  }

  sandbox.req = function req(url, options, redirect) {
    if (!url) return ''
    const o = options && typeof options === 'object' ? options : {}
    const init = {
      headers: o.headers || {},
      redirect: redirect === false ? 'manual' : 'follow',
    }
    if (o.method) init.method = String(o.method).toUpperCase()
    if (o.body !== undefined && o.body !== null) {
      init.body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
    }
    if (o.timeout) init.timeout = Number(o.timeout)
    let res
    try {
      res = fetchSync(String(url), init)
    } catch (e) {
      // drpy 约定：网络错误返回空串，脚本自己判空；抛出去会让整站崩
      console.error('[drpy] req failed', url, e.message)
      return o.returnObj ? { code: 0, headers: {}, content: '' } : ''
    }
    const content = res.text()
    if (process.env.DRPY_DEBUG === '1') {
      console.log('[drpy] req', res.status, String(content).length + 'B', String(url).slice(0, 80))
    }
    const headers = {}
    try {
      res.headers.forEach((v, k) => (headers[k] = v))
    } catch (e) {
      /* 某些实现没有 forEach，headers 留空 */
    }
    // CatVod 的 req 契约是返回 {code, headers, content}，**不是字符串**：
    // drpy2 的 request() 里写死了 `let html = res.content || ""`。
    // 同时让对象在字符串上下文里退化成正文，这样老式 `var html = req(u)`
    // 后面直接 pdfh(html) 也不会坏（两种写法生态里都有）。
    const out = { code: res.status, headers, content }
    out.toString = () => content
    out.valueOf = () => content
    out[Symbol.toPrimitive] = () => content
    if (o.returnObj) return out
    if (o.withHeaders) return [out, headers]
    return out
  }

  sandbox.pdfh = (html, selector) => runQuery(html, selector, false)
  sandbox.pdfa = (html, selector) => runQuery(html, selector, true)
  sandbox.pd = (html, selector) => {
    const s = String(selector || '').trim()
    if (/^(Text|Html)$/i.test(s)) return ''
    return sandbox.pdfh(html, selector)
  }
  sandbox.pdf = (html, selector) => sandbox.pdfa(html, selector)
  sandbox.joinUrl = joinUrl
  sandbox.urljoin = joinUrl
  sandbox.md5 = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex')
  sandbox.base64 = function base64(s, mode) {
    const buf = Buffer.from(String(s), 'utf8')
    return mode === 'decode' ? buf.toString('base64') : buf.toString('base64')
  }
  sandbox.base64Encode = (s) => Buffer.from(String(s), 'utf8').toString('base64')
  sandbox.base64Decode = (s) => Buffer.from(String(s), 'base64').toString('utf8')
  sandbox.local = {
    get: (k) => (k === undefined ? localStore : localStore[k]),
    set: (k, v) => {
      localStore[k] = v
      return v
    },
    delete: (k) => {
      delete localStore[k]
    },
  }
  sandbox.log = (...a) => console.log('[drpy]', ...a)
  sandbox.sleep = sleepSync
  sandbox.json2str = (o) => JSON.stringify(o)
  sandbox.str2json = (s) => JSON.parse(s)
  sandbox.isJson = (s) => {
    try {
      JSON.parse(s)
      return true
    } catch (e) {
      return false
    }
  }
  sandbox.pick = pick
  // CatVod 的 JS 宿主会提供若干可变全局，drpy2 引擎直接用。
  // `Object.defineProperty(globalThis,'myValues',{...})` 在只读/不可配置的
  // 全局上会抛 "Cannot redefine property"（实测），所以这里显式给一个
  // 可写对象。
  sandbox.myValues = {}
  sandbox.globalThis = sandbox
  // CatVod 宿主把 crypto-js 挂成全局：不少规则脚本直接写 `CryptoJS.AES...`
  // 而不是 import。不挂就会报 "CryptoJS is not defined"（实测酷云77 的分类）。
  try {
    sandbox.CryptoJS = require('crypto-js')
  } catch (e) {
    /* 没装就算了，只有用到加密的规则会受影响 */
  }
  sandbox.env = opts.env || {}
  sandbox.getProxyUrl = () => ''
  sandbox.openWeb = () => {
    throw new Error('openWeb not implemented in node runtime')
  }
  return sandbox
}

/**
 * 加载并编译一个 `.js` 源脚本。
 *
 * 脚本形态：CatVod 的约定是执行后得到全局 `__JS_SPIDER__`；
 * 也兼容 `module.exports = {...}` 与直接 `return {...}` 两种写法，
 * 因为社区脚本这三种都有人用。
 */
async function loadSpider(api, ext, opts) {
  const source = await fetchScript(api)
  // 规则文件（ext 是 URL/路径时）：**我们自己取，再把源码交给 init**。
  //
  // 为什么不交给 drpy2 自己取：它内部 `request()` 的返回形状与宿主实现强相关
  // （实测在我们这里返回的不是纯字符串），导致 eval 前的 `js.replace` 抛错、
  // 被 init 的 try 吞掉，规则永远是空的——表现是"init 成功但 home 为空"。
  // 我们取规则后走 init 的"字符串即源码"分支，行为确定且可加 SSRF/编码控制。
  let extArg = ext
  let paramsFromUrl = null
  // 只对"脚本类"地址预取：ext 也可能是 drpy 站点的基础 host（不走规则文件），
  // 对那种地址发一次 404 请求既慢又会在日志里制造噪音。
  if (typeof ext === 'string' && /^https?:\/\//i.test(ext) && /\.js(\?|$)/i.test(ext)) {
    try {
      const q = new URL(ext).searchParams
      if (q.get('type') === 'url' && q.get('params')) {
        paramsFromUrl = new URL(q.get('params'), ext).toString()
      }
      const text = await fetchText(ext)
      if (text && text.trim()) extArg = text
    } catch (e) {
      console.warn('[drpy] rule prefetch failed, fallback to url:', e.message)
    }
  } else if (typeof ext === 'string' && ext.trim()) {
    // 本地规则文件：配置里用绝对路径时直接读，省掉一次网络往返。
    // 只在"看起来是路径且确实存在"时才读，避免把规则源码误当路径。
    try {
      const looksPath = /^[a-zA-Z]:[\/]|^\//.test(ext.trim())
      if (looksPath && fs.existsSync(ext.trim())) {
        extArg = fs.readFileSync(ext.trim(), 'utf8')
      }
    } catch (e) {
      /* 读不到就原样传给引擎 */
    }
  }
  const sandbox = createSandbox({ env: {} })
  // 测试注入点：单测不该依赖真实网络（CI 与受限环境都可能没有出网）
  if (opts && typeof opts.req === 'function') sandbox.req = opts.req
  // 部分规则文件（实测 lf_search3_min.js）用 `http(url, opts)` 这个名字拿响应，
  // 与 `req` 同签名。不挂它就抛 "http is not defined"，整站搜索直接失败。
  if (sandbox.http === undefined) sandbox.http = sandbox.req
  const context = vm.createContext(sandbox)
  // CatVod 的 JS 宿主给 String 加了 Python 风格扩展，drpy2 的 init 第一行就用
  // `rule.host.rstrip("/")`。必须注入到 **vm 上下文内部**——在外面改
  // String.prototype 对 context 里的内建对象无效（两套 realm）。
  vm.runInContext(PROTOTYPE_BOOTSTRAP, context)
  let exported = null
  try {
    const mod = { exports: {} }
    sandbox.module = mod
    sandbox.exports = mod.exports
    sandbox.__JS_SPIDER__ = undefined
    // ★ __req 只作为 wrapper 参数注入，不挂 sandbox 全局：
    //   顶层 import 经 convertEsm 改写为 __req(...)，在函数作用域内提供即可。
    //   安全门禁 tests/security-gates.test.ts 禁止 sandbox.__req。
    const code = convertEsm(compatPatch(source))
    const fn = vm.runInContext(
      `(function(module, exports, __req, __filename){
${code}
; return module.exports;
})`,
      context, { filename: api, timeout: 15000 })
    const returned = fn(mod, mod.exports, requireModule, api)
    exported = sandbox.__JS_SPIDER__
    if (!exported && returned && Object.keys(returned).length) {
      const e = returned
      // drpy2 的形态：export default {...}，转换后是 module.exports.default。
      // 不解包的话 exported.init/home 全是 undefined，调用只会返回空——
      // 表现是"引擎加载成功但 home 永远空"，最难查的一种。
      exported = e.default && typeof e.default === 'object' ? e.default : e
    }
    if (!exported) {
      const wrapped = vm.runInContext(`(function(__req){${source}
; return typeof __JS_SPIDER__!=='undefined'?__JS_SPIDER__:null})`, context)
      exported = wrapped(requireModule)
    }
  } catch (e) {
    throw new Error('script eval failed: ' + e.message)
  }
  if (!exported || typeof exported !== 'object') {
    throw new Error('script did not export __JS_SPIDER__')
  }
  if (typeof exported.init === 'function') {
    await exported.init(extArg || '')
  }
  // 规则 URL 上带的 `?type=url&params=`：正常走引擎的 URL 分支时它会自己写进
  // rule.params；我们拦截了取值，所以在这里补回去（getRule 返回的就是同一个对象）。
  if (paramsFromUrl && typeof exported.getRule === 'function') {
    try {
      const r = exported.getRule()
      if (r && typeof r === 'object') r.params = paramsFromUrl
    } catch (e) {
      /* 规则没有 getRule 就算了，params 是少数规则才用 */
    }
  }
  if (process.env.DRPY_DEBUG === '1') {
    try {
      const probe = vm.runInContext(
        'JSON.stringify({t: typeof rule, host: (typeof rule==="object"&&rule)?rule.host:null})',
        context,
      )
      console.log('[drpy] probe', probe)
    } catch (e) {
      console.log('[drpy] probe failed', e.message)
    }
  }
  return exported
}

/** 取远端文本（规则文件用）。失败返回 ''，由调用方决定降级。 */
async function fetchText(url) {
  // 三次尝试：实测 Node 的 TLS 偶发 "socket disconnected before secure
  // connection was established"，一次失败就把规则当空会让整站静默不可用。
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      if (text && text.trim()) return text
      throw new Error('empty body')
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

async function fetchScript(api) {
  if (api.startsWith('js:')) return api.substring(3)
  if (/^https?:\/\//i.test(api)) {
    const res = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) throw new Error('fetch script HTTP ' + res.status)
    return await res.text()
  }
  // 本地路径：支持绝对路径与相对本目录
  const p = path.isAbsolute(api) ? api : path.join(__dirname, api)
  return fs.readFileSync(p, 'utf8')
}

module.exports = { loadSpider, createSandbox, runQuery, joinUrl }
