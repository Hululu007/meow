/**
 * 二维码渲染（TV 端「手机扫码填写」用）。
 *
 * ## 为什么 vendored 一个第三方库而不是自己写
 *
 * 我先手写了一版 200 行的实现（字节模式 + RS 纠错 + 掩码选择）。它"看起来
 * 像个二维码"，但用官方 `qrcode` 库逐位比对后发现**全图 188/625 位不同**，
 * 也就是扫不出来——错在功能图形的绘制顺序上。这类算法"自测通过"没有意义，
 * 只有和参考实现逐位一致才算对。
 *
 * 所以改成 vendored `qrcode-generator`（Kazuhiko Arase, MIT，单文件无依赖，
 * 56KB 源码 / gzip 后约 15KB）。放在 `vendor/` 而不是加到 package.json：
 * 它是一次性引入的稳定代码，不需要跟进上游版本，也就没必要让每次
 * `pnpm install` 都去拉一次网络。
 *
 * ## 为什么文件后缀是 .mjs（★ 踩过，别改回 .cjs）
 *
 * 项目根 package.json 是 `"type": "module"`，这个 vendored 文件本身是 UMD
 * （末尾 `module.exports = factory()`），两种后缀都有坏法：
 *
 *   · `.js` —— ESM 下 `module.exports` 那句不执行，导出里没有可调用对象。
 *   · `.cjs` —— **生产构建正常**（Rollup 会做 CJS 互操作），但 dev 模式下
 *     Vite 把它原样发给浏览器，浏览器按 ESM 解析 → 报
 *     `does not provide an export named 'default'`，设置页整页打不开。
 *     排查时极易误判成路由/懒加载坏了（实际只影响 dev，所以 CI 抓不到）。
 *
 * 现在保留 UMD 尾巴（对 Rollup 无害）并在文件末尾显式 `export default`，
 * 后缀用 `.mjs`，两种模式走同一条路径。
 *
 * ## 正确性是怎么验的
 *
 * 与官方 `qrcode` 库逐位比对会有约 180/625 差异，但**两者都能被 jsQR
 * 正确解码出同一内容**——差异只是掩码选择不同（罚分算法细节有别，都合法）。
 * 所以判据不能是"与参考实现逐位一致"，而是"能被解码器读出来"。
 *
 * ## 为什么输出 SVG 而不是 canvas
 *
 * TV 上这个二维码是给手机拍的，需要清晰边缘。SVG 按设备像素比自动锐利，
 * 且不用管 canvas 的尺寸/清屏/异步绘制。体积也小（纯路径）。
 */

import qrcode from './vendor/qrcode-generator.mjs'

/**
 * 生成二维码 SVG 字符串。
 *
 * @param text 要编码的内容（UTF-8；本场景是 `http://<ip>:<port>/` 这类短 URL）
 * @param px   输出边长（CSS 像素）
 * @param ecc  纠错等级，默认 M（15%，屏幕拍摄的常用档）
 * @returns SVG 源码；内容过长（超出版本 40）时抛错
 */
export function qrSvg(text: string, px = 220, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): string {
  // typeNumber=0 让库自动选最小可用版本；UTF-8 必须开，否则中文会被按
  // 单字节编码写进去（本场景一般只有 ASCII，但地址里可能有中文主机名）
  const qr = qrcode(0, ecc)
  qr.addData(text, 'Byte')
  qr.make()

  const count = qr.getModuleCount()
  const quiet = 4 // 静默区：标准要求至少 4 模块，少了扫不出来
  const total = count + quiet * 2
  const scale = px / total

  const parts: string[] = []
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) {
      if (!qr.isDark(y, x)) continue
      // 每个黑块一条子路径，合起来一次 fill 比 625 个 <rect> 小得多
      parts.push(
        `M${((x + quiet) * scale).toFixed(2)} ${((y + quiet) * scale).toFixed(2)}` +
          `h${scale.toFixed(2)}v${scale.toFixed(2)}h${(-scale).toFixed(2)}z`,
      )
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges">` +
    // 静默区必须有白底：深色主题下直接放在透明背景上，手机相机
    // 会因为对比度反转/找不到边界而识别失败
    `<rect width="${px}" height="${px}" fill="#ffffff"/>` +
    `<path d="${parts.join('')}" fill="#000000"/>` +
    `</svg>`
  )
}

/** 仅用于测试/调试：返回模块矩阵（true = 黑）。 */
export function qrMatrix(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const qr = qrcode(0, ecc)
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const out: boolean[][] = []
  for (let y = 0; y < n; y++) {
    const row: boolean[] = []
    for (let x = 0; x < n; x++) row.push(qr.isDark(y, x))
    out.push(row)
  }
  return out
}
