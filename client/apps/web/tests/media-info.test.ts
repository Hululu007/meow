import { describe, it, expect } from 'vitest'
import {
  bitDepth,
  codecName,
  outputLabel,
  panelMediaLine,
  resLabel,
  sourceLabel,
  transcodeBadge,
} from '../src/utils/mediaInfo'

describe('编码信息展示口径', () => {
  it('编码名归一：清单 codecs / ffprobe 名 / ExoPlayer mime 都给同一个人话', () => {
    expect(codecName('hvc1.2.4.L153')).toBe('HEVC')
    expect(codecName('hevc')).toBe('HEVC')
    expect(codecName('video/hevc')).toBe('HEVC')
    expect(codecName('avc1.640028')).toBe('H.264')
    expect(codecName('h264')).toBe('H.264')
    expect(codecName('video/avc')).toBe('H.264')
    expect(codecName('ac-3')).toBe('AC3')
    expect(codecName('ec-3')).toBe('E-AC3')
    expect(codecName('mp4a.40.2')).toBe('AAC')
    expect(codecName('')).toBe('')
  })

  it('位深只认真实 pix_fmt；nv12 不能被当成 12-bit', () => {
    expect(bitDepth('yuv420p10le')).toBe('10-bit')
    expect(bitDepth('p010le')).toBe('10-bit')
    expect(bitDepth('yuv420p')).toBe('8-bit')
    // nv12 是 8-bit 4:2:0，名字里带 12 但不是 12-bit（踩过）
    expect(bitDepth('nv12')).toBe('8-bit')
    expect(bitDepth('')).toBe('')
  })

  it('分辨率标签：4K 认宽高任一超阈值，其余按高度', () => {
    expect(resLabel(3840, 2160)).toBe('4K')
    expect(resLabel(1920, 1080)).toBe('1080p')
    expect(resLabel(1280, 720)).toBe('720p')
    expect(resLabel(0, 1080)).toBe('')
  })

  it('转码提示条：源 → 输出，copy 时只写一次', () => {
    const t = {
      srcVcodec: 'hevc',
      srcPixfmt: 'yuv420p10le',
      srcWidth: 3840,
      srcHeight: 2160,
      outVcodec: 'h264',
      outHeight: 1080,
      hw: true,
    }
    expect(sourceLabel(t)).toBe('HEVC 10-bit 4K')
    expect(outputLabel(t)).toBe('H.264 1080p')
    expect(transcodeBadge(t)).toBe('HEVC 10-bit 4K → H.264 1080p')
    const copy = {
      srcVcodec: 'h264',
      srcPixfmt: 'yuv420p',
      srcWidth: 1920,
      srcHeight: 1080,
      outVcodec: 'h264',
      outPixfmt: 'yuv420p',
      outHeight: 1080,
    }
    expect(transcodeBadge(copy)).toBe('H.264 8-bit 1080p')
  })

  it('面板行：转码给源与输出，原生直出不给“输出”', () => {
    expect(
      panelMediaLine({
        srcVcodec: 'hevc',
        srcPixfmt: 'yuv420p10le',
        srcWidth: 3840,
        srcHeight: 2160,
        outVcodec: 'h264',
        outHeight: 1080,
        hw: true,
      }),
    ).toBe('源 HEVC 10-bit 3840×2160 → 输出 H.264 1080p（硬解）')
    expect(
      panelMediaLine({
        via: 'native',
        srcVcodec: 'video/hevc',
        srcPixfmt: '',
        srcWidth: 3840,
        srcHeight: 2160,
      }),
    ).toBe('原生 HEVC 3840×2160')
    expect(panelMediaLine(null)).toBe('')
  })
})
