import { describe, expect, it } from 'vitest'
import { isStrmFile, isVideoFile } from '../src/api/library'

/** #6：.strm 要当视频条目列出来，且能被识别成"直链文件"。 */
describe('片库 .strm 识别', () => {
  it('.strm 是视频条目（Emby/Jellyfin 同款）', () => {
    expect(isVideoFile('电影.strm')).toBe(true)
    expect(isVideoFile('S01E01.STRM')).toBe(true)
  })

  it('普通文本不被当视频', () => {
    expect(isVideoFile('说明.txt')).toBe(false)
    expect(isVideoFile('movie.nfo')).toBe(false)
  })

  it('isStrmFile 不区分大小写，但不误伤 .strmx', () => {
    expect(isStrmFile('a.strm')).toBe(true)
    expect(isStrmFile('A.STRM')).toBe(true)
    expect(isStrmFile('a.strmx')).toBe(false)
  })
})
