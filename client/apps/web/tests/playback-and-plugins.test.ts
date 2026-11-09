import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 本轮（2026-10-31）用户报的一批问题的结构门禁。
 *
 * 这些问题都不是"没实现"，而是分支/判据写错。静态断言锁不住运行时行为，
 * 但能防止改动时被无意识改回去。
 */
const WEB = join(__dirname, '..')
const REPO = join(WEB, '..', '..', '..')

function read(rel: string): string {
  return readFileSync(join(WEB, rel), 'utf8')
}
function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}
function codeOnly(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('问题0：跳过提示条要能被遥控器够到', () => {
  const code = codeOnly(read('src/components/player/VideoPlayer.vue'))

  it('跳过条与取消按钮都有稳定标记', () => {
    expect(code).toContain('data-skip-bar="intro"')
    expect(code).toContain('data-skip-bar="outro"')
    expect(code).toContain('data-skip-cancel="intro"')
    expect(code).toContain('data-skip-cancel="outro"')
  })

  it('进入区间时主动聚焦（否则几何选焦走不到这个浮层）', () => {
    expect(code).toContain('focusSkipBar')
    expect(code).toMatch(/watch\(inIntro[\s\S]{0,200}focusSkipBar/)
  })
})

describe('问题1：设置同步时间戳必须按后端隔离', () => {
  const src = codeOnly(read('src/main.ts'))

  it('syncedAt 的 key 带后端标识', () => {
    expect(src).toContain('syncedAtKey()')
    expect(src).toContain('prefsSyncScope')
    // 不能再用裸的全局 key
    expect(src).not.toMatch(/localStorage\.getItem\(PREFS_SYNCED_AT\)/)
    expect(src).not.toMatch(/localStorage\.setItem\(PREFS_SYNCED_AT,/)
  })
})

describe('问题3：观看时长要能记上（小数秒累积）', () => {
  const src = codeOnly(read('src/stores/watchStats.ts'))

  it('不再用 Math.round 丢弃不足 1 秒的增量', () => {
    const i = src.indexOf('export function addWatchTime')
    expect(i).toBeGreaterThan(-1)
    const body = src.slice(i, i + 1200)
    expect(body).toContain('carrySeconds')
    expect(body).not.toMatch(/Math\.round\(seconds\)/)
  })
})

describe('问题5：偶发播放失败', () => {
  const code = codeOnly(read('src/components/player/VideoPlayer.vue'))
  const pv = codeOnly(read('src/views/PlayView.vue'))

  it('分片加载成功要重置恢复计数（只算"连续"失败）', () => {
    const i = code.indexOf('FRAG_LOADED')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 1200)
    expect(body).toContain('recoverAttempts = 0')
  })

  it('换集要清掉失败线路记录（否则后续集数无候选可换）', () => {
    const i = pv.indexOf('function switchEpisode')
    expect(i).toBeGreaterThan(-1)
    const body = pv.slice(i, i + 1400)
    expect(body).toContain('removeItem(FAILED_KEY)')
  })
})

describe('问题6：换集保持全屏', () => {
  const code = codeOnly(read('src/components/player/VideoPlayer.vue'))

  it('全屏意图持久化 + 换集后恢复', () => {
    expect(code).toContain('FS_INTENT_KEY')
    expect(code).toContain('rememberFsIntent')
    expect(code).toContain('restoreFsIntent')
    expect(code).toMatch(/onMounted\([\s\S]{0,160}restoreFsIntent/)
  })

  it('卸载中不改写意图（否则换集时被自己清掉）', () => {
    expect(code).toContain('unmounting')
    expect(code).toMatch(/onBeforeUnmount\([\s\S]{0,120}unmounting = true/)
  })

  it('用户主动退出全屏仍会清掉意图', () => {
    const i = code.indexOf('function onFullscreenChange')
    const body = code.slice(i, i + 800)
    expect(body).toContain('rememberFsIntent(false)')
    expect(body).toContain('!unmounting')
  })
})

describe('插件列表不显示重复（.bak 等残留目录）', () => {
  const rs = readRepo('client/apps/desktop/src-tauri/src/plugins.rs')

  it('discover 跳过备份/临时目录', () => {
    // 只在 discover 函数体内判断顺序（文件里别处也有 manifest.json 读取）
    const start = rs.indexOf('pub fn discover(')
    expect(start).toBeGreaterThan(-1)
    const body = rs.slice(start, start + 3000)
    expect(body).toContain('.ends_with(".bak")')
    expect(body).toContain('.ends_with(".tmp")')
    const skipIdx = body.indexOf('.ends_with(".bak")')
    const mfIdx = body.indexOf('dir.join("manifest.json")')
    expect(skipIdx).toBeGreaterThan(-1)
    expect(mfIdx).toBeGreaterThan(-1)
    expect(skipIdx).toBeLessThan(mfIdx)
  })
})
