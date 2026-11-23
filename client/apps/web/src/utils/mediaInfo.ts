/**
 * 播放编码信息的展示口径（2026-11-23 用户要求）。
 *
 * 三处数据来源不同，**不要混用**：
 *   · 直连：hls.js 清单里的 CODECS（如 avc1.640028 / hvc1.2.4.L153），只有编码，没有位深；
 *   · 转码：后端 probe 的源编码/位深/宽高 + 输出规格（copy 原样 / hw·软编 h264 1080 封顶）；
 *   · 原生：ExoPlayer 选中轨道的 Format（mime/codecs/宽高），退出时回传。
 *
 * 纯函数，面板与提示条共用；单测在 tests/media-info.test.ts。
 */
export interface MediaSourceInfo {
  srcVcodec?: string
  srcAcodec?: string
  srcPixfmt?: string
  srcWidth?: number
  srcHeight?: number
  outVcodec?: string
  outPixfmt?: string
  outHeight?: number
  hw?: boolean
  /** 来源：转码产物 / 原生播放器回传 */
  via?: 'transcode' | 'native'
}

/** 编码名归一：hevc/h265/hvc1 → HEVC；h264/avc1 → H.264；音频同理 */
export function codecName(codec?: string): string {
  const s = (codec || '').toLowerCase()
  if (!s) return ''
  if (/(hevc|h265|hvc1|hev1)/.test(s)) return 'HEVC'
  if (/(h264|avc1|avc3|avc)/.test(s)) return 'H.264'
  if (s.includes('av01') || s.includes('av1')) return 'AV1'
  if (s.includes('vp9') || s.includes('vp09')) return 'VP9'
  if (/(eac3|ec-3)/.test(s)) return 'E-AC3'
  if (/(ac3|ac-3)/.test(s)) return 'AC3'
  if (s.includes('dts')) return 'DTS'
  if (/(aac|mp4a)/.test(s)) return 'AAC'
  if (s.includes('opus')) return 'Opus'
  if (s.includes('flac')) return 'FLAC'
  if (s.includes('mp3')) return 'MP3'
  return codec || ''
}

/** 只有真实 pix_fmt（后端 probe / 原生回传）才能给位深；清单 CODECS 不给 */
export function bitDepth(pixfmt?: string): string {
  const s = (pixfmt || '').toLowerCase()
  if (!s) return ''
  if (/p0?10(?:le|be)?$/.test(s)) return '10-bit'
  if (/p0?12(?:le|be)?$/.test(s)) return '12-bit'
  if (/p0?16(?:le|be)?$/.test(s)) return '16-bit'
  return '8-bit'
}

/** 分辨率短标签：4K / 1080p / 720p；宽高缺一不可 */
export function resLabel(width?: number, height?: number): string {
  if (!width || !height) return ''
  if (width >= 3500 || height >= 2000) return '4K'
  return `${height}p`
}

/** 源标签：`HEVC 10-bit 4K`（音频单独给，避免一行太长） */
export function sourceLabel(i?: MediaSourceInfo | null): string {
  if (!i) return ''
  return [codecName(i.srcVcodec) || i.srcVcodec, bitDepth(i.srcPixfmt), resLabel(i.srcWidth, i.srcHeight)]
    .filter(Boolean)
    .join(' ')
}

/** 输出标签：`H.264 8-bit 1080p`（有 outPixfmt 时带位深，便于和源对比 copy 是否原样） */
export function outputLabel(i?: MediaSourceInfo | null): string {
  if (!i) return ''
  return [codecName(i.outVcodec) || i.outVcodec, bitDepth(i.outPixfmt), resLabel(1920, i.outHeight)]
    .filter(Boolean)
    .join(' ')
}

/**
 * 转码提示条的一行文案（要压在单行里，别超长）：
 *   `HEVC 10-bit 4K → H.264 1080p`
 */
export function transcodeBadge(i?: MediaSourceInfo | null): string {
  if (!i) return ''
  const src = sourceLabel(i)
  const out = outputLabel(i)
  if (!src || !out) return ''
  // copy 视频时源与输出相同，别写「H.264 1080p → H.264 1080p」
  if (src === out) return out
  return `${src} → ${out}`
}

/** 面板完整行：`源 HEVC 10-bit 3840×2160 → 输出 H.264 1920×1080（硬解）` */
export function panelMediaLine(i?: MediaSourceInfo | null): string {
  if (!i) return ''
  const srcCodec = codecName(i.srcVcodec) || i.srcVcodec || ''
  const srcDim = i.srcWidth && i.srcHeight ? `${i.srcWidth}×${i.srcHeight}` : ''
  const src = [srcCodec, bitDepth(i.srcPixfmt), srcDim].filter(Boolean).join(' ')
  // 原生直出：没有"输出"这一跳，别写成 源 X → 输出 X
  if (i.via === 'native') return src ? `原生 ${src}` : ''
  const outCodec = codecName(i.outVcodec) || i.outVcodec || ''
  const outDim = i.outHeight ? `${i.outHeight}p` : ''
  const out = [outCodec, bitDepth(i.outPixfmt), outDim].filter(Boolean).join(' ')
  const via = i.hw ? '硬解' : ''
  if (!src || !out) return src || out
  return `源 ${src} → 输出 ${out}${via ? `（${via}）` : ''}`
}

/** 后端转码结果 → 面板/提示条用的源与输出信息（PlayView 两处转码成功共用） */
export function transcodeMediaInfo(r: {
  srcVcodec?: string
  srcAcodec?: string
  srcPixfmt?: string
  srcWidth?: number
  srcHeight?: number
  outVcodec?: string
  outPixfmt?: string
  outHeight?: number
  hw?: boolean
}): MediaSourceInfo {
  return {
    via: 'transcode',
    srcVcodec: r.srcVcodec,
    srcAcodec: r.srcAcodec,
    srcPixfmt: r.srcPixfmt,
    srcWidth: r.srcWidth,
    srcHeight: r.srcHeight,
    outVcodec: r.outVcodec,
    outPixfmt: r.outPixfmt,
    outHeight: r.outHeight,
    hw: r.hw,
  }
}
