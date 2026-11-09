import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CORS / 写请求门禁的行为门禁（2026-11-02）。
 *
 * 背景：用户报「通过 tailscale 连接的新加坡服务器，部署的 docker 应用全被
 * cors 了」。实测根因两条：
 *   ① `isPrivateHost()` 只放行 RFC1918，Tailscale 的 `100.x`（CGNAT
 *      100.64/10）不在里面 → GET 响应不下发 Allow-Origin；
 *   ② `originAllowed()`（写请求门禁）手抄了另一份白名单，**连 192.168 都
 *      没放行** → 局域网/隧道访问时所有 POST 直接 403。
 *      首页第一个请求 `/api/Douban/home` 就是 POST，所以整页空白。
 *
 * 这两条都是"看一眼代码觉得没问题"的类型，必须用真实 HTTP 验证。
 *
 * 跑法：需要一个已编译并启动的实例，地址由环境变量 `MEOW_TEST_API` 提供；
 * 未提供时整组跳过（CI 里没有 java 实例，不该因此 fail）。
 *
 *   cd server/host && ./build.bat
 *   MEOW_PORT=19971 java -cp "classes;libs/*" ApiServer --data-dir=<tmp>
 *   MEOW_TEST_API=http://127.0.0.1:19971 npx vitest run tests/cors-origin.test.ts
 */
const API = process.env.MEOW_TEST_API || ''
const REPO = join(__dirname, '..', '..', '..', '..')
const SRC = readFileSync(join(REPO, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')

/** 去掉注释，避免注释里描述"原来有这个问题"把断言骗过去。 */
function codeOnly(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 发一个 POST，返回状态码 */
async function post(origin: string | null): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (origin !== null) headers.Origin = origin
  const r = await fetch(`${API}/api/policy`, { method: 'POST', headers, body: '{}' })
  return r.status
}

/** 发一个 GET，返回 Access-Control-Allow-Origin（没有则空串） */
async function getAcao(origin: string): Promise<string> {
  const r = await fetch(`${API}/api/health`, { headers: { Origin: origin } })
  return r.headers.get('access-control-allow-origin') || ''
}

const suite = API ? describe : describe.skip

suite('默认策略：不拦截（用户明确要求「默认不拦截」）', () => {
  it('任意公网来源也能读能写（MEOW_CORS 未设置 = *）', async () => {
    // 这条是策略本身：部署形态太多，靠猜网段必然漏
    expect(await getAcao('http://8.8.8.8:30010')).toBe('http://8.8.8.8:30010')
    expect(await post('http://evil.example.com')).toBe(200)
    // 曾经被拦的 Tailscale CGNAT 地址
    expect(await post('http://100.64.0.1:30010')).toBe(200)
  })

  it('各种部署形态都能用', async () => {
    for (const o of [
      'http://192.168.1.5:30010',
      'http://10.3.4.8:30010',
      'http://172.20.1.1:30010',
      'http://localhost:5187',
      'http://127.0.0.1:5187',
      'http://[::1]:30010',
      'http://[::1]',
      'http://sg.tailnet-abc.ts.net:30010',
      'http://meow.local:30010',
      'null',
      'tauri://localhost',
      'http://tauri.localhost',
      'https://appassets.androidplatform.net',
      'https://meow.example.com',
    ]) {
      expect(await post(o), o).toBe(200)
    }
  })

  it('无 Origin 的请求不受影响（curl / TV / 同源）', async () => {
    expect(await post(null)).toBe(200)
  })
})

describe('判据单一真源（防止两份白名单再次漂移）', () => {
  const code = codeOnly(SRC)

  it('originAllowed 不得自己手抄白名单', () => {
    const i = code.indexOf('private static boolean originAllowed')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 1600)
    // 只要出现任何"自己判 host"的痕迹，就说明又在复制一份
    expect(body).not.toContain('startsWith("http://192.168')
    expect(body).not.toContain('startsWith("http://10.')
    expect(body).toContain('corsAllowedOrigin')
  })

  it('默认策略是不拦截（corsAllowList 为空 → 返回 null）', () => {
    const i = code.indexOf('private static String[] corsAllowList')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 1800)
    // 未配置时必须落到"返回 null"这条分支
    expect(body).toMatch(/MEOW_CORS/)
    expect(body).toContain('return null')
  })

  it('IPv6 host 提取不能靠 lastIndexOf(冒号)', () => {
    const i = code.indexOf('private static String hostOf')
    expect(i).toBeGreaterThan(-1)
    const body = code.slice(i, i + 900)
    // 必须先处理方括号
    expect(body).toContain('startsWith("[")')
    expect(body).toContain("indexOf(']')")
  })
})
