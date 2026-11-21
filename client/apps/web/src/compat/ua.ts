/**
 * 运行环境里的「文本指纹」类判据的唯一出口。
 *
 * ## 为什么集中在这里
 *
 * UA 是**设备级**信息，分不清"触摸屏 PC 上插着鼠标"和"手机"，也分不清
 * "TV 壳"和"浏览器里加 ?tv=1 调试 TV 布局"。业务组件里散读 UA 会让同一
 * 台设备在不同页面得到不同结论（`device-adaptive.md` 的 P0/P1 就是这么来的）。
 *
 * 所以规则是：
 *   · 只有 `compat/` 允许读 `navigator.userAgent`；
 *   · 业务侧只允许调用这里导出的**能力/身份**函数；
 *   · 样式判据仍然走 `html[data-*]`（见 `compat/deviceProfile.ts`）。
 *
 * `tests/device-profile.test.ts` 会扫描 `src/`，除 `compat/` 外出现
 * `navigator.userAgent` 直接红。
 */

function ua(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgent || ''
}

/** 原始 UA 文本（只给日志/诊断用，不要拿它做分支判据） */
export function uaText(): string {
  return ua()
}

/**
 * TV 壳的 UA 标记。
 *
 * TV 壳在 `MainActivity` 里给 UA 追加 `MeowTV`，所以它比 `window.meowTv`
 * 更早可用（首帧内联脚本就能读到）。只允许 `deviceProfile` 的**首屏兜底**
 * 与 `index.html` 首帧脚本使用；业务代码判身份要读 `data-shell`。
 */
export function isMeowTvUa(): boolean {
  return /MeowTV/i.test(ua())
}

/** iOS 手机/掌机（iPad 不算：这个判据只用于「没有系统音量 API」的兜底） */
export function isIosPhone(): boolean {
  return /iP(hone|od)\b/.test(ua())
}

/** Firefox（自带 ffmpeg 后端，能解 mkv） */
export function isFirefox(): boolean {
  return /Firefox|FxiOS/.test(ua())
}

/** Android WebView / Chrome（带 Matroska demuxer） */
export function isAndroid(): boolean {
  return /Android/.test(ua())
}

/** Chrome 主版本号（日志/诊断用；取不到返回空串） */
export function chromeMajor(): string {
  return (ua().match(/Chrome\/([0-9]+)/) || [])[1] || ''
}

/**
 * Apple WebKit 内核（Safari / iOS WebView）：带 Dolby 授权，AC3/E-AC3 可直解。
 * Chromium 全家（Chrome/Edge/WebView2/Android WebView）都没有 —— 播放分配
 * （utils/playRoute）用它决定音频超纲文件的走向（2026-11-21 清单③）。
 * UA 判据按纪律收敛在 compat/，业务层只消费这里的布尔值。
 */
export function isAppleWebkit(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)
}
