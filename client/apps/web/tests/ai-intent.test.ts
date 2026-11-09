import { describe, it, expect } from 'vitest'
import { parsePlayIntent } from '../src/ai/intent'

/**
 * 播放意图解析（docs/47 §2.1「规则先行」在这条链路上的落地）。
 *
 * 这个模块的全部价值是"不耗模型就拆出片名和集数"，所以测试重点在
 * **什么时候该拒绝**——猜错片名的代价比多走一次模型大得多。
 */

describe('能正确拆解的标准句式', () => {
  it('播放庆余年第二季第一集', () => {
    expect(parsePlayIntent('播放庆余年第二季第一集')).toEqual({
      title: '庆余年第二季',
      episode: '1',
    })
  })

  it('「第二季」不能被当成集数（季不在 [集话期回] 里）', () => {
    const r = parsePlayIntent('播放庆余年第二季')
    expect(r?.title).toBe('庆余年第二季')
    expect(r?.episode).toBeUndefined()
  })

  it('带空格的片名保留可读形式', () => {
    const r = parsePlayIntent('播放 庆余年 第 3 集')
    expect(r?.title).toBe('庆余年')
    expect(r?.episode).toBe('3')
  })

  it('中文数字集数转阿拉伯', () => {
    expect(parsePlayIntent('播放武林外传第十集')?.episode).toBe('10')
    expect(parsePlayIntent('播放武林外传第七集')?.episode).toBe('7')
  })

  it('EP 形式', () => {
    const r = parsePlayIntent('播放怪奇物语 EP04')
    expect(r?.title).toBe('怪奇物语')
    expect(r?.episode).toBe('4')
  })

  it('各种动词都能认', () => {
    for (const v of ['播放', '放', '看', '打开', '帮我播放', '我想看']) {
      expect(parsePlayIntent(`${v}庆余年第一集`)?.title, `动词「${v}」`).toBe('庆余年')
    }
  })

  it('没有集数也能拆出片名（默认第一集由调用方决定）', () => {
    expect(parsePlayIntent('播放庆余年')).toEqual({ title: '庆余年' })
  })
})

describe('必须拒绝的情况（交回模型）', () => {
  it('没有播放动词 → 可能是问答，不是指令', () => {
    expect(parsePlayIntent('庆余年有没有第二季')).toBeNull()
    expect(parsePlayIntent('庆余年好看吗')).toBeNull()
  })

  it('只有动词没有片名', () => {
    expect(parsePlayIntent('播放')).toBeNull()
    expect(parsePlayIntent('播放 ')).toBeNull()
  })

  it('片名不足 2 字', () => {
    expect(parsePlayIntent('播放1')).toBeNull()
    expect(parsePlayIntent('放A')).toBeNull()
  })

  it('空串', () => {
    expect(parsePlayIntent('')).toBeNull()
    expect(parsePlayIntent('   ')).toBeNull()
  })

  it('动词不在句首时不算（避免"这部剧放完了吗"误判）', () => {
    expect(parsePlayIntent('这部剧放完了吗')).toBeNull()
  })
})

describe('集数归一化（实测踩过：EP04 拆出 04 导致一条都匹配不上）', () => {
  it('前导零必须去掉', () => {
    expect(parsePlayIntent('播放怪奇物语 EP04')?.episode).toBe('4')
    expect(parsePlayIntent('播放怪奇物语第04集')?.episode).toBe('4')
    expect(parsePlayIntent('播放怪奇物语第004集')?.episode).toBe('4')
  })

  it('多位数不能被截断', () => {
    expect(parsePlayIntent('播放某剧第128集')?.episode).toBe('128')
  })
})

describe('episodeNumber：模型会传中文集数（实测踩过）', () => {
  it('中文数字要能解析（模型把「第一集」直接传进来）', async () => {
    const { episodeNumber } = await import('../src/ai/tools')
    expect(episodeNumber('第一集')).toBe(1)
    expect(episodeNumber('第十二集')).toBe(12)
    expect(episodeNumber('第二十集')).toBe(20)
    expect(episodeNumber('第十集')).toBe(10)
  })

  it('阿拉伯与前导零', async () => {
    const { episodeNumber } = await import('../src/ai/tools')
    expect(episodeNumber('第04集')).toBe(4)
    expect(episodeNumber('EP12')).toBe(12)
    expect(episodeNumber('1')).toBe(1)
    expect(episodeNumber('128')).toBe(128)
  })

  it('抽不出数字时返回 null（交给上层换线路，不猜）', async () => {
    const { episodeNumber } = await import('../src/ai/tools')
    expect(episodeNumber('预告')).toBeNull()
    expect(episodeNumber('花絮')).toBeNull()
  })

  it('同片不同集不能串（第14集 ≠ 第4集）', async () => {
    const { episodeNumber } = await import('../src/ai/tools')
    expect(episodeNumber('第14集')).toBe(14)
    expect(episodeNumber('第14集')).not.toBe(4)
  })
})
