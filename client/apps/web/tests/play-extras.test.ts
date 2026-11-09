import { describe, expect, it } from 'vitest'
import {
  assToVtt,
  skipWindowFrom,
  srtToVtt,
  startAtFrom,
  subTracksFrom,
  subtitleFormat,
} from '@/api/playExtras'

describe('skipWindowFrom：源站 skips → 片头/片尾绝对秒数', () => {
  it('标准 opening 段（start=0 且有 end）换算成秒', () => {
    expect(skipWindowFrom([{ type: 'opening', start: 0, end: 90000 }])).toEqual({
      openingEnd: 90,
      endingStart: 0,
      middles: [],
    })
  })

  it('ending 只给 start 表示"直到结尾"，合法', () => {
    expect(skipWindowFrom([{ type: 'ending', start: 1350000 }])).toEqual({
      openingEnd: 0,
      endingStart: 1350,
      middles: [],
    })
  })

  it('ending 同时给 start/end 也接受', () => {
    expect(skipWindowFrom([{ type: 'ending', start: 1300000, end: 1400000 }]).endingStart).toBe(1300)
  })

  it('opening 的 start 不是 0 时忽略——那段从中间开始，跳过会丢正片', () => {
    expect(skipWindowFrom([{ type: 'opening', start: 5000, end: 90000 }]).openingEnd).toBe(0)
  })

  it('end 不晚于 start 的段判为非法', () => {
    expect(skipWindowFrom([{ type: 'opening', start: 0, end: 0 }]).openingEnd).toBe(0)
    expect(skipWindowFrom([{ type: 'ending', start: 90000, end: 80000 }]).endingStart).toBe(0)
  })

  it('ending 的 start 必须 > 0', () => {
    expect(skipWindowFrom([{ type: 'ending', start: 0 }]).endingStart).toBe(0)
  })

  it('middle 段按起止解析成秒，并按开始时间排序', () => {
    const w = skipWindowFrom([
      { type: 'middle', start: 600000, end: 660000 },
      { type: 'middle', start: 300000, end: 330000 },
    ])
    expect(w.middles).toEqual([
      { start: 300, end: 330 },
      { start: 600, end: 660 },
    ])
    // 中插不该污染片头/片尾
    expect(w.openingEnd).toBe(0)
    expect(w.endingStart).toBe(0)
  })

  it('middle 缺 end 或 end<=start 时丢弃——不知道跳多久就不该动', () => {
    expect(skipWindowFrom([{ type: 'middle', start: 300000 }]).middles).toEqual([])
    expect(skipWindowFrom([{ type: 'middle', start: 300000, end: 300000 }]).middles).toEqual([])
    expect(skipWindowFrom([{ type: 'middle', start: 0, end: 60000 }]).middles).toEqual([])
  })

  it('多段 opening 取最晚结束，多段 ending 取最早开始（都偏保守）', () => {
    const w = skipWindowFrom([
      { type: 'opening', start: 0, end: 60000 },
      { type: 'opening', start: 0, end: 95000 },
      { type: 'ending', start: 1400000 },
      { type: 'ending', start: 1300000 },
    ])
    expect(w.openingEnd).toBe(95)
    expect(w.endingStart).toBe(1300)
  })

  it('middle（插播）不影响片头片尾边界，单独进 middles', () => {
    const w = skipWindowFrom([{ type: 'middle', start: 300000, end: 360000 }])
    expect(w.openingEnd).toBe(0)
    expect(w.endingStart).toBe(0)
    expect(w.middles).toEqual([{ start: 300, end: 360 }])
  })

  it('字符串数字也接受（不同 spider 输出类型不一致）', () => {
    expect(
      skipWindowFrom([{ type: 'opening', start: '0' as any, end: '45000' as any }]).openingEnd,
    ).toBe(45)
  })

  it('非法输入一律返回 0，不抛', () => {
    for (const bad of [undefined, null, [], [null], [{}], [{ type: 'opening' }], 'x' as any]) {
      expect(skipWindowFrom(bad as any)).toEqual({ openingEnd: 0, endingStart: 0, middles: [] })
    }
  })
})

describe('startAtFrom：起播点毫秒 → 秒', () => {
  it('正常值换算', () => {
    expect(startAtFrom(120000)).toBe(120)
  })
  it('0 / 负数 / 非数字 / undefined 都返回 0', () => {
    for (const bad of [0, -5, 'abc', undefined, null, {}]) {
      expect(startAtFrom(bad as any)).toBe(0)
    }
  })
})

describe('subTracksFrom：只留能真的取到的字幕', () => {
  it('保留 http(s) 条目，丢掉相对路径与空值', () => {
    const out = subTracksFrom([
      { url: 'https://a/1.srt', name: '中文' },
      { url: '/relative/2.srt' },
      { url: '' },
      { name: '没有 url' },
      null as any,
    ])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('中文')
  })
  it('非数组返回空数组', () => {
    expect(subTracksFrom(undefined)).toEqual([])
    expect(subTracksFrom('x' as any)).toEqual([])
  })
})

describe('subtitleFormat：按 format 或扩展名判断', () => {
  it('srt / vtt / 其他', () => {
    expect(subtitleFormat({ url: 'https://a/1.srt' })).toBe('srt')
    expect(subtitleFormat({ url: 'https://a/1.vtt' })).toBe('vtt')
    // .ass 现在能被转换了（见 assToVtt），不再是 other
    expect(subtitleFormat({ url: 'https://a/1.ass' })).toBe('ass')
    // 图形字幕（sub/idx）仍不支持
    expect(subtitleFormat({ url: 'https://a/1.sub' })).toBe('other')
  })
  it('format 字段优先于扩展名', () => {
    expect(subtitleFormat({ url: 'https://a/x.srt', format: 'vtt' })).toBe('vtt')
  })
})

describe('srtToVtt：浏览器只吃 WebVTT', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    '你好，世界',
    '',
    '2',
    '00:00:04,250 --> 00:00:06,000',
    '第二句',
    '',
  ].join('\r\n')

  it('加 WEBVTT 头、逗号换点、去掉序号行、CRLF 归一', () => {
    const vtt = srtToVtt(srt)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500')
    expect(vtt).toContain('00:00:04.250 --> 00:00:06.000')
    expect(vtt).toContain('你好，世界')
    expect(vtt).not.toMatch(/\r/)
    // 序号行被去掉（只剩时间轴与正文）
    expect(vtt.split('\n').filter((l) => /^\s*\d+\s*$/.test(l))).toHaveLength(0)
  })

  it('已经是 VTT 的原文放行（有些源把 vtt 命名成 .srt）', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n'
    expect(srtToVtt(vtt)).toBe(vtt)
  })

  it('去 BOM', () => {
    expect(srtToVtt('\uFEFFWEBVTT\n\n').startsWith('WEBVTT')).toBe(true)
  })

  it('空输入返回空串', () => {
    expect(srtToVtt('')).toBe('')
  })
})

describe('assToVtt：ASS/SSA → WebVTT', () => {
  /** ASS 的换行符是反斜杠+N，TS 字面量里写不好，用字符码拼 */
  const BS = String.fromCharCode(92)
  const SAMPLE = [
    '[Script Info]',
    'Title: test',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize',
    'Style: Default,Arial,20',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,第一句',
    'Dialogue: 0,0:00:04.25,0:00:06.75,Default,,0,0,0,,{\an8}带标签的句子',
    'Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,第一行' + BS + 'N第二行',
    'Comment: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,这是注释不该出现',
    'Dialogue: 0,0:00:12.00,0:00:14.00,Default,,0,0,0,,有一,个,逗号',
  ].join('\n')

  it('提取时间与文字，丢弃 [Events] 之外的段落', () => {
    const vtt = assToVtt(SAMPLE)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.000')
    expect(vtt).toContain('第一句')
    expect(vtt).not.toContain('Script Info')
    expect(vtt).not.toContain('Arial')
  })

  it('百分秒按 1/100 秒换算，而不是毫秒', () => {
    // 0:00:01.50 是 1.5 秒 = 500ms；误当毫秒会变成 1.05 秒
    const vtt = assToVtt(SAMPLE)
    expect(vtt).toContain('00:00:01.500')
    expect(vtt).not.toContain('00:00:01.050')
    // 0:00:04.25 -> 250ms
    expect(vtt).toContain('00:00:04.250')
  })

  it('清掉覆盖标签、把 \N 换成换行', () => {
    const vtt = assToVtt(SAMPLE)
    expect(vtt).not.toContain('{\an8}')
    expect(vtt).toContain('带标签的句子')
    expect(vtt).toContain('第一行\n第二行')
  })

  it('跳过 Comment 行', () => {
    expect(assToVtt(SAMPLE)).not.toContain('这是注释不该出现')
  })

  it('文字里的逗号不被切开', () => {
    expect(assToVtt(SAMPLE)).toContain('有一,个,逗号')
  })

  it('没有 Dialogue 时返回空串（图形字幕不假装支持）', () => {
    expect(assToVtt('[Script Info]\nTitle: x\n')).toBe('')
    expect(assToVtt('')).toBe('')
  })

  it('已经是 VTT 的原样放行', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n'
    expect(assToVtt(vtt)).toBe(vtt)
  })
})

describe('subtitleFormat：识别 ass/ssa', () => {
  it('按 format 或扩展名认出 ass 族', () => {
    expect(subtitleFormat({ format: 'ass' })).toBe('ass')
    expect(subtitleFormat({ url: 'https://x/a.ssa' })).toBe('ass')
    expect(subtitleFormat({ url: 'https://x/a.ass?token=1' })).toBe('ass')
  })
  it('srt/vtt 不受影响', () => {
    expect(subtitleFormat({ url: 'https://x/a.srt' })).toBe('srt')
    expect(subtitleFormat({ url: 'https://x/a.vtt' })).toBe('vtt')
    expect(subtitleFormat({ url: 'https://x/a.sub' })).toBe('other')
  })
})
