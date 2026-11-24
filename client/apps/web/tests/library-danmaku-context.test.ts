import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { libraryDanmakuTitle, libraryEpisodeLabel } from '../src/api/library'

/**
 * 片库播放要同点播一样加载弹幕/预取（2026-11-23 用户点单）。
 *
 * 片库路径结构不固定：剧名/集、剧名/S01/集、毛骗/毛骗S01/集、教父/第1部…
 * 弹幕检索名必须剥掉季目录再按季拼回去；集标签统一成「第N集」。
 */
const REPO = join(__dirname, '..', '..', '..', '..')
const LIB = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'LibraryView.vue'), 'utf8')
const PLAY = readFileSync(join(REPO, 'client', 'apps', 'web', 'src', 'views', 'PlayView.vue'), 'utf8')
const VP = readFileSync(
  join(REPO, 'client', 'apps', 'web', 'src', 'components', 'player', 'VideoPlayer.vue'),
  'utf8',
)

describe('片库弹幕检索名/集标签', () => {
  it('普通剧目录：直接用剧名', () => {
    expect(libraryDanmakuTitle('武林外传', ['电视剧', '武林外传'])).toBe('武林外传')
  })

  it('纯季目录（S01 / 第一季）：剧名来自分组名，补上季', () => {
    expect(libraryDanmakuTitle('瑞克和莫蒂', ['动漫', '瑞克和莫蒂', 'S01'])).toBe('瑞克和莫蒂 第一季')
    expect(libraryDanmakuTitle('某剧', ['某剧', '第2季'])).toBe('某剧 第二季')
  })

  it('剧名和季粘在一起（毛骗S01）：同样能识别', () => {
    expect(libraryDanmakuTitle('毛骗', ['电视剧', '毛骗', '毛骗S01'])).toBe('毛骗 第一季')
  })

  it('电影/部：季不影响，集标签用第N部；无集号用文件名', () => {
    expect(libraryDanmakuTitle('教父', ['电影', '教父'])).toBe('教父')
    expect(libraryEpisodeLabel({ episode: 5, part: 0, name: '05.mkv' })).toBe('第5集')
    expect(libraryEpisodeLabel({ episode: 0, part: 1, name: '第1部.mkv' })).toBe('第1部')
    expect(libraryEpisodeLabel({ episode: 0, part: 0, name: 'Movie.2020.mkv' })).toBe('Movie.2020')
  })
})

describe('片库 → 播放页带齐弹幕/预取所需的上下文', () => {
  it('进播放页带上 name / ep / list', () => {
    expect(LIB).toContain('const showTitle = libraryDanmakuTitle(scrapeTitleOf(g)')
    expect(LIB).toContain('query.name = showTitle')
    expect(LIB).toContain('libraryEpisodeLabel(cur)')
    expect(LIB).toContain('query.list = JSON.stringify')
  })

  it('播放页片库切集重算流地址（不调 fetchPlay）', () => {
    expect(PLAY).toContain('if (isLibraryPlay.value && libraryLib.value)')
    expect(PLAY).toContain('libraryStream(libraryLib.value, file)')
    expect(PLAY).toContain('library: libraryLib.value')
  })

  it('片库当前集按 file 匹配（rawId 恒空）', () => {
    expect(PLAY).toContain('isLibraryPlay.value ? libraryFile.value : rawId.value')
  })

  it('预取触发点用真实总时长（转码时 video.duration 只是边缘）', () => {
    expect(PLAY).toContain('libraryTotalDuration.value > 0 ? libraryTotalDuration.value : dur')
    expect(PLAY).toContain('Math.min(mark, total) - prefetchLead.value')
  })
})

describe('手动搜索弹幕框预填片名（片库/点播同一口径）', () => {
  it('默认关键词取片名（title 的「片名 · 第N集」前半段）', () => {
    expect(VP).toContain("const showName = computed(() => (props.title || '').split(' · ')[0].trim())")
    expect(VP).toContain('const dmKeyword = ref(showName.value)')
  })

  it('片名后到/为空时打开面板自动填', () => {
    expect(VP).toContain('if (!dmKeyword.value.trim()) dmKeyword.value = showName.value')
  })

  it('用户手敲过就不覆盖（避免切集切片冲掉输入）', () => {
    expect(VP).toContain('dmKeywordAuto')
    expect(VP).toContain('cur === dmKeywordAuto')
  })
})
