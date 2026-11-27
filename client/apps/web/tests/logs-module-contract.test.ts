import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 日志模块的系统级契约（2026-11-27 审计后落地）。
 *
 * 这一组断言锁的是「用户/开发者能不能靠日志定位问题」，不是实现细节：
 *
 *   1. 500 必须进环形缓冲（原来只在 stderr，面板里一个字都没有）；
 *   2. 高频轮询必须被过滤（缓存/转码/搜索快照/进度同步），否则 2000 条
 *      缓冲十几分钟就被冲干净；
 *   3. 环形缓冲要有字节上限 + 丢弃计数（不显示 dropped，用户会以为
 *      "面板里就是全部"）；
 *   4. 前端只渲染有上界的行数（实测 2000 行时，每次新日志到达有一次
 *      133ms 长帧；400 行时 0 长帧）。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const API = join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java')
const BUFFER = join(ROOT, 'server', 'host', 'src', 'shared', 'core', 'LogBuffer.java')
const ROUTES = join(ROOT, 'server', 'host', 'src', 'shared', 'routes', 'LogRoutes.java')
const TRANSCODE = join(ROOT, 'server', 'host', 'src', 'shared', 'core', 'Transcode.java')
const VIEW = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'LogsView.vue')
const CLIENT = join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'logs.ts')

const read = (p: string) => readFileSync(p, 'utf8')

describe('日志模块：错误必须可定位', () => {
  it('顶层 catch 把未捕获异常写进环形缓冲（带堆栈）', () => {
    const s = read(API)
    // 锚点用这条唯一文案（文件里 catch 很多，按 catch 定位会落到别的方法里）
    const i = s.indexOf('path + " → " + root.getClass().getSimpleName()')
    expect(i).toBeGreaterThan(-1)
    const seg = s.slice(Math.max(0, i - 260), i + 320)
    expect(seg).toContain('core.LogBuffer.error("api"')
    expect(seg).toContain('unwrap(t)')
    // 堆栈要进日志：error(tag, text, Throwable) 的重载（末尾传 t）
    expect(seg).toMatch(/firstLine\(root\.getMessage\(\)\)\),\s*t\)/)
  })

  it('转码失败写进环形缓冲（原来只有 System.err）', () => {
    const s = read(TRANSCODE)
    expect(s).toContain('private static void noteFail')
    expect(s).toContain('core.LogBuffer.error("transcode"')
    // 至少覆盖：无 ffmpeg / 卡住被杀 / 退出码失败
    expect(s).toContain('noteFail(j, "no_ffmpeg"')
    expect(s).toContain('noteFail(j, "stalled"')
    expect(s).toContain('noteFail(j, j.code, j.error)')
  })
})

describe('日志模块：噪音必须被挡住', () => {
  const s = read(ROUTES)

  it('isNoisyPath 用三态匹配（精确 / 子路径），不能只写带斜杠的前缀', () => {
    expect(s).toContain('private static boolean hit(String path, String base)')
    expect(s).toContain('path.equals(base) || path.startsWith(base + "/")')
    // 不能再出现老的 startsWith("/api/xxx/") 写法（`/api/cache?id=` 会漏）
    expect(s).not.toContain('path.startsWith("/api/cache/")')
  })

  it('缓存/转码/搜索轮询/进度同步都算噪音', () => {
    for (const p of ['/api/cache', '/api/transcode', '/api/search/task', '/api/state', '/api/health']) {
      expect(s, `漏了 ${p}`).toContain(`hit(path, "${p}")`)
    }
  })

  it('[req] 的 stdout 与环形缓冲同一条判据', () => {
    const api = read(API)
    const i = api.indexOf('boolean noisy = routes.LogRoutes.isNoisyPath(path)')
    expect(i).toBeGreaterThan(-1)
    const seg = api.slice(i, i + 400)
    expect(seg).toContain('if (!noisy)')
    expect(seg).toContain('System.out.println("[req] "')
  })
})

describe('日志模块：缓冲本身要稳', () => {
  const s = read(BUFFER)

  it('有字节上限与丢弃计数（只限条数会被长堆栈撑爆）', () => {
    expect(s).toContain('MAX_BYTES')
    expect(s).toContain('dropped++')
    // stats 必须把 dropped 暴露给面板
    expect(s).toContain('.put("dropped", d)')
  })

  it('有 debug 级别开关（调试打印不该写死在 stdout）', () => {
    expect(s).toContain('MEOW_LOG_LEVEL')
    expect(s).toContain('public static boolean debugEnabled()')
  })

  it('落盘（重启后的现场）', () => {
    expect(s).toContain('public static void attachFile(String path)')
    expect(read(API)).toContain('core.LogBuffer.attachFile')
  })

  it('相邻重复合并（刷屏只占一行）', () => {
    expect(s).toContain('last.count++')
    expect(s).toContain('.put("count", count)')
  })
})

describe('日志页：渲染有上界 + 计数可见', () => {
  const s = read(VIEW)

  it('只渲染最近 N 条，数据仍是全部', () => {
    expect(s).toContain('const ROWS_STEP = 400')
    expect(s).toContain('v-for="it in shown"')
    expect(s).toContain('加载更早')
  })

  it('默认单行省略、点击展开（多行 pre-wrap 是滚动/重排的大头）', () => {
    expect(s).toContain('expandedKey === it.key ? \'whitespace-pre-wrap break-all\' : \'block truncate\'')
  })

  it('显示丢弃数与落盘路径', () => {
    expect(s).toContain('serverStats.dropped')
    expect(s).toContain('serverStats.file')
  })

  it('「暂停刷新」名副其实（原来叫暂停滚动，实际停的是轮询）', () => {
    expect(s).toContain('暂停刷新')
    expect(s).not.toContain('>暂停滚动<')
  })

  it('客户端带上写令牌（_clientlog 已纳入写鉴权）', () => {
    expect(read(CLIENT)).toContain('tail')
    expect(read(join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'index.ts'))).toContain(
      "'X-Meow-Token': token",
    )
  })
})

/**
 * AI 面板排障能力补齐（2026-11-27 第二批）。
 *
 * 锁的是"模型能不能回答这三类问题"：
 *   · 为什么点什么都慢  → health 的线程池水位 + 上次搜索耗时
 *   · 为什么一直转不完  → /api/transcode?action=list + meow_transcode 工具
 *   · 为什么搜不到      → 搜索规模进诊断（SEARCH_ALL_EMPTY / SOURCES_MOSTLY_BROKEN）
 */
describe('AI 面板：线程池 / 转码 / 搜索诊断', () => {
  const API_SRC = read(API)
  const TOOLS = read(join(ROOT, 'client', 'apps', 'web', 'src', 'ai', 'tools.ts'))
  const DIAG = read(join(ROOT, 'client', 'apps', 'web', 'src', 'ai', 'diagnose.ts'))
  const ORCH = read(join(ROOT, 'client', 'apps', 'web', 'src', 'ai', 'orchestrate.ts'))
  const BRIDGE = read(join(ROOT, 'client', 'apps', 'web', 'src', 'ai', 'bridge.ts'))
  const TC = read(TRANSCODE)

  it('health 暴露线程池水位与上次搜索耗时', () => {
    expect(API_SRC).toContain('o.put("poolActive"')
    expect(API_SRC).toContain('o.put("poolQueue"')
    expect(API_SRC).toContain('o.put("poolMax"')
    expect(API_SRC).toContain('o.put("lastSearchMs"')
    // 同步/异步两条搜索路径都要记耗时
    expect(API_SRC).toContain('LAST_SEARCH_MS = System.currentTimeMillis() - t0')
  })

  it('转码可列任务（含失败码与空闲时长）', () => {
    expect(TC).toContain('public static JSONObject listJson()')
    expect(TC).toContain('o.put("idleSec"')
    expect(TC).toContain('o.put("code", j.code)')
    // 源地址要脱敏 + 截断
    expect(TC).toContain('core.LogBuffer.scrub(s)')
    expect(API_SRC).toContain('if ("list".equals(q.get("action")))')
  })

  it('meow_transcode 在三条通路上都注册了（UI / MCP / 提示词）', () => {
    expect(TOOLS).toContain('export async function meowTranscode')
    expect(TOOLS).toContain("{ name: 'meow_transcode'")
    expect(ORCH).toContain('meow_transcode: {')
    expect(BRIDGE).toContain('meow_transcode: () => tools.meowTranscode()')
    expect(read(join(ROOT, 'client', 'apps', 'web', 'src', 'ai', 'prompt.ts'))).toContain('meow_transcode')
  })

  it('搜索规模进诊断：区分"源全失败"与"确实没这部片"', () => {
    expect(DIAG).toContain("code: 'SEARCH_ALL_EMPTY'")
    expect(DIAG).toContain("code: 'SOURCES_MOSTLY_BROKEN'")
    // 判据必须用到 total/returned，否则两种情况的建议会一样
    expect(DIAG).toContain('s.search.returned')
    expect(DIAG).toContain('countBackend(')
    // meow_search 要写规模快照，collectSources 要读
    expect(TOOLS).toContain('__meowSearchStats')
    expect(DIAG).toContain('__meowSearchStats')
  })

  it('AI 自身失败写日志（面板事件 + 宿主上送）', () => {
    expect(ORCH).toContain('function noteAiFailure')
    expect(ORCH).toContain("logEvent('warn', 'ai'")
    expect(ORCH).toContain('reportClientLog(')
  })

  it('meow_logs 支持增量 sinceId', () => {
    expect(TOOLS).toContain('sinceId?: number')
    expect(TOOLS).toContain('fetchServerLogs({ since, limit: 500 })')
    expect(BRIDGE).toContain('sinceId: typeof a.sinceId')
  })
})
