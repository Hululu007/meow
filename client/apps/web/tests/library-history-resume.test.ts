import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 片库进度/历史落库（2026-11-23 用户点单）。
 *
 * 片库没有 VOD 的 site/vod_id；用 `库id|剧目录` 作为稳定键、相对文件路径当 ep_url，
 * 播放页就能走同一套 saveProgress/applyResume；历史页再按 site=__library__ 特判跳转。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const LIB = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'LibraryView.vue'), 'utf8')
const PLAY = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'), 'utf8')
const HIS = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'HistoryView.vue'), 'utf8')

describe('片库历史/续播', () => {
  it('进播放页带稳定键（库|目录）、文件路径与海报', () => {
    expect(LIB).toContain('query.vod = `${currentLib.value}|${dir}`')
    expect(LIB).toContain('query.id = filePath')
    expect(LIB).toContain('query.pic = pic')
  })

  it('播放页：片库不拉 detail、不预取播放地址，但进度照常写', () => {
    // ensurePlaylist 与 maybePrefetchNextPlay 都要跳过片库
    expect(PLAY).toContain('// 片库的剧集表由 LibraryView 随 query.list 带过来')
    expect(PLAY).toContain('if (isLibraryPlay.value) return\n  if (!Number.isFinite(pos)')
    // 历史里显示"片库"而不是 __library__
    expect(PLAY).toContain("isLibraryPlay.value ? '片库'")
  })

  it('切集保留 vod/id/pic，续播键不丢', () => {
    const i = PLAY.indexOf('if (isLibraryPlay.value && libraryLib.value)')
    const body = PLAY.slice(i, i + 700)
    expect(body).toContain('vod: vodId || undefined')
    expect(body).toContain('id: file || undefined')
  })

  it('历史页按 site=__library__ 特判：直达播放 / 回片库目录', () => {
    expect(HIS).toContain("it.site !== '__library__'")
    expect(HIS).toContain('libraryStream(l.lib, it.ep_url)')
    expect(HIS).toContain("name: 'library'")
  })
})
