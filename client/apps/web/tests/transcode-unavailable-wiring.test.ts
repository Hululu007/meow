import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「本端没有转码能力」这条链路的接线门禁（2026-11-27 用户实报）。
 *
 * 事故形态：iOS 上播片库的 MKV → 扩展名预判直接起转码 → 后端 502
 * 「找不到 ffmpeg（policy.json 或 PATH 均未配置）」→ 错误页大字显示这句
 * 与影片无关的技术原因，诊断卡还把它判成「网络超时 high / 换一条线路」。
 *
 * 四条不能回退的约束：
 *   1. 能力预检收在 tryTranscode / tryLibraryTranscode 的**函数入口**
 *      （片库 7 个调用点里原来漏了 2 个，逐点补必然再漏）；
 *   2. transcodeAvailable 必须三态：null 是"没问到"，不能当 false
 *      （否则后端重启一次、老后端、Vite 代理错端口都会误杀 PC/Docker）；
 *   3. ffmpeg 插件装完要让缓存失效（否则本会话一直显示"不支持"）；
 *   4. 错误页命中 ffmpeg 文案时换成人话，原始 msg 只进诊断证据。
 *
 * 只做字符串/结构断言 —— 语义正确性靠 ai-diagnose.test.ts 的真跑用例。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const PLAY = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'), 'utf8')
const LIB = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'library.ts'), 'utf8')
const SETTINGS = readFileSync(
  join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
  'utf8',
)
const DIAG = readFileSync(join(ROOT, 'client', 'apps', 'web', 'src', 'ai', 'diagnose.ts'), 'utf8')

describe('转码能力预检收在函数入口', () => {
  it('tryTranscode 开头做 ensureTranscodeProbe', () => {
    const at = PLAY.indexOf('async function tryTranscode(')
    expect(at).toBeGreaterThan(0)
    expect(PLAY.slice(at, at + 900)).toContain('ensureTranscodeProbe()')
  })

  it('tryLibraryTranscode 开头做 ensureTranscodeProbe（片库预判/兜底两条都走这里）', () => {
    const at = PLAY.indexOf('async function tryLibraryTranscode(')
    expect(at).toBeGreaterThan(0)
    expect(PLAY.slice(at, at + 900)).toContain('ensureTranscodeProbe()')
  })

  it('预检失败走统一收尾（清 loading / 恢复直连 / 给人话文案）', () => {
    expect(PLAY).toContain('function handleTranscodeUnavailable(silent: boolean): void')
    expect(PLAY).toContain('handleTranscodeUnavailable(repair)')
    // 遮罩与"封锁直连"必须一起清，否则页面卡在加载态
    const body = PLAY.slice(
      PLAY.indexOf('function handleTranscodeUnavailable'),
      PLAY.indexOf('const errorMainText'),
    )
    expect(body).toContain('loading.value = false')
    expect(body).toContain('libraryNoDirect.value = false')
  })
})

describe('transcodeAvailable 三态', () => {
  it('返回 boolean | null（null = 没问到）', () => {
    expect(LIB).toMatch(/export async function transcodeAvailable\(\): Promise<boolean \| null>/)
  })

  it('只有后端明确给出布尔值才算回答；非 2xx / 网络失败一律 null', () => {
    const at = LIB.indexOf('export async function transcodeAvailable(')
    const body = LIB.slice(at, at + 1200)
    expect(body).toContain("typeof j.available === 'boolean'")
    expect(body).not.toContain('if (!r.ok) return false')
    expect(body).toContain('catch')
    expect(body).toContain('value = null')
  })

  it('有 30 秒 TTL，且能被主动失效', () => {
    expect(LIB).toContain('TRANSCODE_CAPS_TTL_MS')
    expect(LIB).toContain('export function invalidateTranscodeProbe()')
  })

  it('null 在播放页按"可用"处理（真不能转由后端 502 兜）', () => {
    const at = PLAY.indexOf('async function ensureTranscodeProbe(')
    const body = PLAY.slice(at, at + 900)
    expect(body).toContain('if (v === null) return true')
  })
})

describe('ffmpeg 插件装完后能力缓存失效', () => {
  it('SettingsView 导入并调用 invalidateTranscodeProbe', () => {
    expect(SETTINGS).toContain('invalidateTranscodeProbe')
    expect(SETTINGS).toMatch(/import \{[^}]*invalidateTranscodeProbe[^}]*\} from '@\/api\/library'/)
    expect(SETTINGS).toMatch(/await store\.boot\(\)[\s\S]{0,400}invalidateTranscodeProbe\(\)/)
  })
})

describe('错误页文案降级', () => {
  it('模板用 errorMainText / errorSubText，不再直接渲染技术 msg', () => {
    expect(PLAY).toContain('{{ errorMainText }}')
    expect(PLAY).toContain('{{ errorSubText }}')
    expect(PLAY).not.toContain('（{{ hopError }}）')
  })

  it('命中 ffmpeg 文案时给可执行的下一步', () => {
    expect(PLAY).toContain('function isTranscodeUnavailableText')
    const body = PLAY.slice(
      PLAY.indexOf('const errorSubText = computed'),
      PLAY.indexOf('const errorSubText = computed') + 700,
    )
    expect(body).toContain('ffmpeg')
    expect(body).toMatch(/MP4\/HLS/)
  })
})

describe('诊断拿到 hopError', () => {
  it('播放页诊断入参带 hopError', () => {
    expect(PLAY).toMatch(/hopError: hopError\.value/)
  })

  it('诊断规则表里有 TRANSCODE_UNAVAILABLE，且与 NETWORK_TIMEOUT 互斥', () => {
    expect(DIAG).toContain('TRANSCODE_UNAVAILABLE')
    expect(DIAG).toContain('function isTranscodeMissing')
    // NETWORK_TIMEOUT 的 match 必须先排除"转码缺失"，否则看门狗到期仍会误判
    const at = DIAG.indexOf("code: 'NETWORK_TIMEOUT'")
    expect(DIAG.slice(at, at + 400)).toContain('!isTranscodeMissing(s)')
  })

  it('ffmpeg 缺失时 CODEC_UNSUPPORTED 不给 transcode 建议', () => {
    const at = DIAG.indexOf("code: 'CODEC_UNSUPPORTED'")
    expect(DIAG.slice(at, at + 900)).toContain('isTranscodeMissing(s)')
  })
})
