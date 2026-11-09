/**
 * 判断一个播放地址该交给哪个引擎。
 *
 * <p>背景（2026-11-04 真机实测）：大量源给的播放地址是 `wmm.php?...`、
 * `api.php?url=...` 这种形态，**内容是 m3u8，但字符串里没有 `.m3u8`**。
 * 以前只按 `url.includes('.m3u8')` 判断，于是：
 *   · TV / Android WebView：落到原生 `v.src`，内核自己嗅探清单 → 能播；
 *   · PC / WebView2：没有原生 HLS → `MEDIA_ERR_SRC_NOT_SUPPORTED`，
 *     用户看到"格式不支持或地址已失效"。
 * 同一个源在 TV 能播、PC 播不了，就是这么来的。
 */

/** 明确是"单个媒体文件"的扩展名（不是播放清单） */
const DIRECT_MEDIA_EXT = /\.(mp4|mkv|flv|ts|m4s|mov|webm|avi|wmv|mp3|m4a|aac)(\?|#|$)/i

/** 地址里已经写明是 HLS 清单 */
const HLS_HINT = /\.m3u8|mpegurl/i

/**
 * 该不该走 hls.js。
 *
 * @param url 真正交给播放器的地址（可能是我方 `/api/proxy/stream?url=...`）
 * @param nativeHls 当前内核是否支持原生 HLS（Android WebView 为真，WebView2 为假）
 *
 * <p>三条规则：
 *   1. 地址里写了 `.m3u8` → 走 hls.js（两端一致）
 *   2. 内核有原生 HLS → 交回原生（**保持 TV 现有行为不变**，避免回退）
 *   3. 其余情况：没有明确媒体扩展名 → 按清单试。
 *      猜错也不怕：hls.js 对非清单内容会报 `manifestParsingError`，
 *      VideoPlayer 会回退到原生 `v.src`（代理对非清单内容是原样透传的）。
 */
export function looksLikeHls(url: string, nativeHls: boolean): boolean {
  const u = (url || '').toLowerCase()
  if (!u) return false
  if (HLS_HINT.test(u)) return true
  if (nativeHls) return false
  return !DIRECT_MEDIA_EXT.test(u)
}

/** 地址看起来是单个媒体文件（诊断与回退判据用） */
export function looksLikeDirectMedia(url: string): boolean {
  return DIRECT_MEDIA_EXT.test((url || '').toLowerCase())
}

/**
 * 这个内核的原生 HLS 能不能信。
 *
 * <p>★ 只认 Android WebView。Windows / macOS 的 Chromium 对
 * `canPlayType('application/vnd.apple.mpegurl')` 也会回 `"maybe"`，
 * 但实际 `<video src=x.m3u8>` 直接 `MEDIA_ERR_SRC_NOT_SUPPORTED`
 * （2026-11-04 在 Edge 实测：回 "maybe"、播不了）。
 * 用它当判据会让 PC 继续落到原生分支——正是要修的那个 bug。
 */
export function hasNativeHls(v: { canPlayType?: (t: string) => string } | null): boolean {
  if (!v || typeof v.canPlayType !== 'function') return false
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
  if (!/Android/i.test(ua)) return false
  return !!v.canPlayType('application/vnd.apple.mpegurl')
}
