/**
 * 是不是「本机」地址（127.0.0.1 / localhost / [::1]）。
 *
 * <p>桌面端启动时要区分两种手填地址：
 * - **远端**（OECT / Tailscale / 反代）：已经 7×24 在跑，不必等本地 sidecar；
 * - **本机回环**：很可能就是本地插件自己的地址，必须继续等它 bind。
 *
 * <p>踩过（2026-11-09）：用户在设置页存了 `http://127.0.0.1:9979` 后，
 * `initBackend()` 把它当"远端地址"立刻返回，页面在插件 autostart 还没
 * bind 端口时就 ping 了一次 → 闪出「后端未连接」，要点两次重试才进首页。
 */
export function isLoopbackUrl(url: string): boolean {
  if (!url) return false
  const raw = url.trim()
  // 没有协议的写法（如 `127.0.0.1:9979`）`new URL` 会抛；先按主机名判一次。
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(raw)) return true
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
}
