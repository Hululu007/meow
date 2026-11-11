import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 手机扫码推送页（TV 壳里的 PushServer）与设置页必须覆盖同一批配置项。
 *
 * 踩过的坑（2026-11-04）：手机页是手写 HTML + 一张 [元素id, 存储键, 类型]
 * 字段表，和 SettingsView 完全没有编译期关联。结果设置页加了 8 个字段
 * （弹幕字号、历史条数、右上角时长、迷你进度条、跳过前倒计时、SafeDNS、
 * syncLibrary、缓存三档单位）而手机页全都没有 —— 用户在手机上看不到、
 * 改不了，也不知道是"没这个功能"还是"坏了"。
 *
 * 这条门禁做两件事：
 *   1. 设置页每个会写 prefs 的字段，手机页字段表里都要有对应的键
 *   2. 手机页字段表里的每个元素 id，模板里都要真的存在
 *
 * 白名单（刻意不覆盖）：见 EXEMPT 的说明。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const PUSH = join(
  ROOT,
  'client',
  'apps',
  'tv',
  'app',
  'src',
  'main',
  'java',
  'com',
  'meow',
  'tv',
  'PushServer.java',
)

/**
 * 刻意不在手机页出现的项，以及理由。
 * 加新条目必须同时写理由，否则下一个人会以为漏了。
 */
const EXEMPT: Record<string, string> = {
  // PC 专属：手机推给 TV 没有意义
  closeToTray: 'PC 托盘行为，TV 壳没有这个概念',
  // 播放态而非配置：手机上改了会在用户不知情时改动正在播的声音/速度
  volume: '播放态，不是配置项；设置页也没有 UI',
  muted: '播放态，不是配置项；设置页也没有 UI',
  rate: '播放态，不是配置项；设置页也没有 UI',
  // 设置页本身没有 UI
  cacheDays: '设置页没有暴露，属历史遗留字段',
}

function settingsFields(): Set<string> {
  const src = readFileSync(SETTINGS, 'utf8')
  const out = new Set<string>()
  // update('xxx') 是设置页写 prefs 的主要入口
  for (const m of src.matchAll(/update\('([a-zA-Z]+)'/g)) out.add(m[1])
  // 密度三键由 setDanmakuDensity 联写，模板里不出现 update()
  for (const k of ['danmakuDensity', 'danmakuDuration', 'danmakuArea']) out.add(k)
  // AI 配置走 persistLlm() → saveLlmConfig()（ai/llm.ts 里 setPref），
  // 不经过 update()。字段名与 llm.ts 的映射见 saveLlmConfig。
  for (const k of [
    'llmEnabled',
    'llmBaseUrl',
    'llmApiKey',
    'llmModel',
    'llmHistoryRounds',
    'llmMaxTokens',
    'llmTimeoutMs',
  ]) {
    out.add(k)
  }
  return out
}

/** 从 PushServer 的 JS 字段表里抽出 [元素id, 存储键] 对。 */
function pushFields(): Array<{ id: string; key: string }> {
  const src = readFileSync(PUSH, 'utf8')
  const out: Array<{ id: string; key: string }> = []
  // 字段表形如 ['p_searchThreads','searchThreads','int']
  // Java 源码里引号被转义成 \" ，所以两种都匹配
  const re = /\['([pguw]_[a-zA-Z]+)',\s*'([a-zA-Z]+)',\s*'(?:bool|int|float|text)'\]/g
  for (const m of src.matchAll(re)) out.push({ id: m[1], key: m[2] })
  return out
}

describe('手机扫码页与设置页配置项对齐', () => {
  it('设置页每个可写的 prefs 字段都能在手机页找到', () => {
    const want = settingsFields()
    const have = new Set(pushFields().map((f) => f.key))
    const missing = [...want].filter((k) => !have.has(k) && !(k in EXEMPT)).sort()
    expect(
      missing,
      `这些字段设置页能改、手机页改不了：${missing.join(', ')}。\n` +
        '要么在 PushServer 的字段表里补上，要么加进本测试的 EXEMPT 并写清理由。',
    ).toEqual([])
  })

  it('不能反向漏：手机页字段表里的 prefs 键也都该在设置页有 UI', () => {
    const have = settingsFields()
    // 只校验 p_ 前缀（写 prefs 的那组）。g_/w_/u_ 分别写 policy.json、
    // meow.webdav、meow.update*，不是 prefs 字段，不该拿 prefs 的 UI 去对。
    const pushOnly = pushFields()
      .filter((f) => f.id.startsWith('p_'))
      .map((f) => f.key)
      .filter((k) => !have.has(k))
    expect(pushOnly, `手机页推了设置页没有 UI 的 prefs 键：${pushOnly.join(', ')}`).toEqual([])
  })

  it('字段表里每个元素 id 在模板里都存在', () => {
    const src = readFileSync(PUSH, 'utf8')
    const missing = pushFields()
      .map((f) => f.id)
      .filter((id) => !src.includes(`id=\\"${id}\\"`) && !src.includes(`id="${id}"`))
    expect(missing, `字段表引用了不存在的元素：${missing.join(', ')}`).toEqual([])
  })

  it('密度必须三键联写（否则档位与参数会不一致）', () => {
    const src = readFileSync(PUSH, 'utf8')
    // 选档后要同时补 duration/area —— 只写 density 会得到
    // 「档位写着密集、实际还是 12s/70%」，getPrefs 的兜底不救这种情况
    expect(src, '手机页缺少 DENSITY 预设表').toMatch(/var DENSITY=\{/)
    expect(src, '选密度后没有联写 duration').toContain('prefs.danmakuDuration=DENSITY[d].duration')
    expect(src, '选密度后没有联写 area').toContain('prefs.danmakuArea=DENSITY[d].area')
  })

  it('推送前必须有基线门禁（防止顶掉电视配置）', () => {
    const src = readFileSync(PUSH, 'utf8')
    // 预填失败时 cur={}，若不拦会把所有复选框的 false 与下拉首项当改动推上去
    expect(src, '缺少 init 预填快照').toMatch(/var init=\{\}/)
    expect(src, 'diff 没有基线判据').toContain('if(base[f[1]]!==undefined)')
    expect(src, '预填失败没有禁用推送按钮').toContain('okPrefs&&okExtra')
  })

  it('枚举选项必须覆盖 prefs 允许的全部值', () => {
    const src = readFileSync(PUSH, 'utf8')
    // 这三处曾漏过：赋一个不在 option 里的值会让 select.value 变成空，
    // 界面显示空白，用户误以为没设置
    for (const [id, val] of [
      ['p_themeMode', 'system'],
      ['p_danmakuDensity', 'custom'],
      ['p_wallpaper', 'custom'],
    ]) {
      const i = src.indexOf(`id=\\"${id}\\"`) >= 0
        ? src.indexOf(`id=\\"${id}\\"`)
        : src.indexOf(`id="${id}"`)
      expect(i, `找不到 ${id}`).toBeGreaterThan(-1)
      const seg = src.slice(i, i + 1600)
      expect(seg, `${id} 缺 value="${val}" 选项`).toContain(val)
    }
  })

  it('safeDns 是 boolean、dnsProvider 才是服务商字符串', () => {
    const src = readFileSync(PUSH, 'utf8')
    // 踩过：把 safeDns 做成下拉框（off/ali/...），而 policy.json 里它是布尔值，
    // 反显时 Boolean(true) 塞进 select 得到空值，永远显示不出电视上的真实状态
    expect(src, 'safeDns 应作 bool 处理').toMatch(
      /\['g_safeDns',\s*'safeDns',\s*'bool'\]/,
    )
    expect(src, 'dnsProvider 是独立字段').toMatch(
      /\['g_dnsProvider',\s*'dnsProvider',\s*'text'\]/,
    )
  })

  it('必须有刷新按钮（否则电视被改过后页面会一直显示过期值）', () => {
    const src = readFileSync(PUSH, 'utf8')
    // 页面只在打开那一刻抓一次配置。电视被遥控器改过、或另一台手机推过之后，
    // 这里显示的就是旧值 —— 不刷新会让用户基于过期数据判断。
    expect(src, '缺少刷新按钮元素').toContain('id=\\"rf\\"')
    expect(src, '刷新没绑定处理函数').toContain('rf.onclick')
    expect(src, '刷新后没重建基线快照').toMatch(/snapshot\(\);updateReady\(\)/)
  })

  it('刷新前必须拦住未推送的改动（不能静默丢弃）', () => {
    const src = readFileSync(PUSH, 'utf8')
    // 刷新会用电视值覆盖表单，本地未推的改动会丢
    expect(src, '缺少 hasPending 判据').toMatch(/function hasPending\(\)/)
    expect(src, '刷新前没有确认').toMatch(/refreshAll\(ask\)/)
    expect(src, '取消刷新后没改提示（会残留"已刷新"误导用户）').toContain('已取消刷新')
  })
})

/**
 * 扫码弹层右侧的"能改什么"清单，必须与手机页实际分组一致。
 *
 * 踩过（2026-11-04）：手机页从 5 组扩到 11 组、50+ 项，而弹层里那份
 * SCAN_PUSH_ITEMS 常量还是最早的 5 组 15 项 —— 用户扫之前看到的清单
 * 和扫进去能改的东西完全对不上（用户截图指出）。
 */
describe('扫码弹层清单与手机页分组一致', () => {
  const SETTINGS_SRC = readFileSync(SETTINGS, 'utf8')
  const PUSH_SRC = readFileSync(PUSH, 'utf8')

  function dialogGroups(): string[] {
    const i = SETTINGS_SRC.indexOf('const SCAN_PUSH_ITEMS')
    expect(i, '找不到 SCAN_PUSH_ITEMS').toBeGreaterThan(-1)
    const end = SETTINGS_SRC.indexOf('\n]', i)
    const body = SETTINGS_SRC.slice(i, end)
    return [...body.matchAll(/group:\s*'([^']+)'/g)].map((m) => m[1])
  }

  function phoneGroups(): string[] {
    // 只取 <section> 内的 h2：令牌遮罩的标题也是 h2，不能算作一个"分组"
    // 生成器按 78 字符切行，<h2> 后可能紧跟字符串边界（引号+换行+加号），
    // 所以字符类里排除引号与换行，只取真正的分组名
    return [...PUSH_SRC.matchAll(/<section>\s*<h2>([^"<\r\n]+)/g)].map((m) => m[1].trim())
  }

  it('弹层分组与手机页分组逐项一致（顺序也要一致）', () => {
    const d = dialogGroups()
    const p = phoneGroups()
    expect(d.length, `弹层只有 ${d.length} 组，手机页有 ${p.length} 组`).toBe(p.length)
    expect(d, '分组名或顺序不一致（以手机页为准同步弹层）').toEqual(p)
  })

  /**
   * 逐条对齐，不只是组名。
   *
   * 踩过（2026-11-04）：组名对上了、条目却是合并写法
   * （「结果缓存三档」「同步历史/设置/搜索词」），用户拿电视上的清单
   * 一条条数，对不上手机页的字段。
   */
  it('每组条目与手机页字段逐条一致（数量 + 文字）', () => {
    const dialog = new Map<string, string[]>()
    for (const m of SETTINGS_SRC.slice(
      SETTINGS_SRC.indexOf('const SCAN_PUSH_ITEMS'),
      SETTINGS_SRC.indexOf('\n]', SETTINGS_SRC.indexOf('const SCAN_PUSH_ITEMS')),
    ).matchAll(/group:\s*'([^']+)'[\s\S]*?items:\s*\[([\s\S]*?)\]/g)) {
      dialog.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]))
    }

    // 手机页在 Java 源码里被切成多个字符串常量：先把 " + " 拼回去，再还原 \"。
    // 顺序不能反 —— 先反转义会把拼接边界上的引号搞乱。
    const joined = PUSH_SRC.replace(/"\s*\r?\n\s*\+\s*"/g, '').replace(/\\"/g, '"')
    const phone = new Map<string, string[]>()
    for (const sec of joined.matchAll(/<section>\s*<h2>([^<]+)[\s\S]*?<\/section>/g)) {
      const name = sec[0].match(/<h2>([^<]+)/)![1].trim()
      phone.set(name, [...sec[0].matchAll(/<span class="k">([^<]+)/g)].map((x) => x[1].trim()))
    }

    // 组数是"源码结构还能被解析出来"的哨兵：数字对不上说明解析规则失效或
    // 手机页被改坏了。加新分组时同步改这里（2026-11-05 加了「直播源」，2026-11-11 加了「维护」）。
    expect(phone.size, '解析手机页失败（源码结构变了？）').toBe(11)
    for (const [group, items] of dialog) {
      const real = phone.get(group)
      expect(real, `手机页没有「${group}」这一组`).toBeTruthy()
      expect(
        items,
        `「${group}」条目与手机页字段不一致。\n弹层：${items.join(' / ')}\n手机页：${(real || []).join(' / ')}`,
      ).toEqual(real)
    }
  })
})

/**
 * 访问令牌：没有它，同 WiFi 里任何人都能读走全部设置并随意改写。
 */
describe('扫码推送的访问令牌', () => {
  const PUSH_SRC = readFileSync(PUSH, 'utf8')
  const SETTINGS_SRC = readFileSync(SETTINGS, 'utf8')

  it('推送服务启动即生成新令牌，停止即清空', () => {
    expect(PUSH_SRC, '没有令牌字段').toMatch(/private static volatile String token/)
    expect(PUSH_SRC, 'start 里没生成令牌').toMatch(/token = newToken\(\)/)
    expect(PUSH_SRC, 'stop 里没清令牌').toMatch(/token = "";/)
    // 每次开启换新令牌："关掉再开"才是有效的泄漏补救
    expect(PUSH_SRC, '没有随机生成').toContain('java.security.SecureRandom')
  })

  it('二维码地址带上令牌（扫码自动带入）', () => {
    expect(PUSH_SRC, 'pushUrl 没带 ?k=').toContain('"?k=" + token')
  })

  it('所有读写端点都要校验令牌，根路径放行', () => {
    expect(PUSH_SRC, '没有校验函数').toMatch(/private static boolean tokenOk\(/)
    // 根路径必须放行：页面要能加载，否则用户没地方输令牌（死锁）
    expect(PUSH_SRC, '根路径没放行').toMatch(/isRootPage = pathOnly\.isEmpty\(\) \|\| "\/"\.equals\(pathOnly\)/)
    // 四个端点都在守卫范围
    for (const p of ['"/push"', '"/prefs"', '"/extra"', '"/act"']) {
      expect(PUSH_SRC, `守卫没覆盖 ${p}`).toContain(p)
    }
    expect(PUSH_SRC, '校验失败没返回 403').toContain('403')
  })

  it('手机页：从 URL 取令牌、存本地、无令牌时显示输入遮罩', () => {
    expect(PUSH_SRC, '手机页没读 URL 里的 k').toContain('function kFromUrl()')
    expect(PUSH_SRC, '令牌没存本地（刷新要重输）').toContain("var K_KEY='meow.push.k'")
    expect(PUSH_SRC, '请求没拼令牌').toContain('function withK(url)')
    expect(PUSH_SRC, '没有输入遮罩').toContain('id=\\"gate\\"')
    // 令牌错了要清掉，否则一直带着错的撞 403
    expect(PUSH_SRC, '令牌无效时没清理').toMatch(/removeItem\(K_KEY\)/)
  })

  it('TV 弹层单独显示令牌（手输地址时要用）', () => {
    expect(SETTINGS_SRC, '弹层没显示令牌').toContain('scanDialog.token')
    expect(SETTINGS_SRC, '没从桥取令牌').toContain('pushToken')
  })
})
