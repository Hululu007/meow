import { describe, expect, it } from 'vitest'
import { proxyStream } from '../src/api'

function queryOf(u: string): URLSearchParams {
  const i = u.indexOf('?')
  return new URLSearchParams(i >= 0 ? u.slice(i + 1) : '')
}

/**
 * 分片代理必须透传源站要求的**全部**请求头。
 *
 * 原生播放器（ExoPlayer）拿的是完整头表，我们只转 Referer/UA 的话，
 * 靠 Cookie / Origin / 自定义 token 鉴权的源在 Web 端会永久 403——
 * 用户看到的是"同一条线路原生能播、我们播不了"。
 */
describe('proxyStream 请求头', () => {
  it('额外的头塞进 headers 参数，Referer/UA 不重复', () => {
    const u = proxyStream('https://cdn.example/a.m3u8', {
      Referer: 'https://page.example/',
      'User-Agent': 'UA/1.0',
      Cookie: 'sid=abc',
      'X-Token': 't-1',
    })
    const q = queryOf(u)
    expect(q.get('referer')).toBe('https://page.example/')
    expect(q.get('ua')).toBe('UA/1.0')
    const extra = JSON.parse(q.get('headers') || '{}') as Record<string, string>
    expect(extra.Cookie).toBe('sid=abc')
    expect(extra['X-Token']).toBe('t-1')
    expect(extra.Referer).toBeUndefined()
    expect(extra['User-Agent']).toBeUndefined()
  })

  it('没有额外头时不带 headers 参数（地址保持干净）', () => {
    const u = proxyStream('https://cdn.example/a.m3u8', { Referer: 'https://p/' })
    expect(queryOf(u).has('headers')).toBe(false)
  })

  it('header 是 JSON 字符串时同样解析', () => {
    const u = proxyStream('https://cdn.example/a.m3u8', '{"Cookie":"k=v"}')
    expect(JSON.parse(queryOf(u).get('headers') || '{}').Cookie).toBe('k=v')
  })
})
