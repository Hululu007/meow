/**
 * 播放策略里的纯判断。
 *
 * <p>抽出来的原因：这三条都是"数值判据"，放在组件里只能靠真机 + 慢源才能验证；
 * 抽成纯函数后可以用单测把边界钉死（1.25x、带宽刚好卡线、缓冲刚好 1.5s）。
 */

export interface LevelInfo {
  bitrate?: number
}

/** 允许的余量：码率 × 倍速 超过带宽的 80% 就降档（给抖动和代理一跳留空间） */
export const ABR_HEADROOM = 0.8

/** 缓冲垫低于这个秒数算"见底" */
export const UNDERRUN_BUFFER_SEC = 1.5

/** 降速后至少观察这么久才恢复 */
export const RATE_RESTORE_OBSERVE_MS = 8_000

/** 缓冲垫达到这个深度才恢复倍速 */
export const RATE_RESTORE_BUFFER_SEC = 20

/**
 * 按当前倍速算"最高可用档"。
 *
 * @returns 档位下标；`-1` 表示不限制（1x 或没有可用数据）
 */
export function capLevelForRate(levels: LevelInfo[], bandwidth: number, rate: number): number {
  if (!levels.length || !(bandwidth > 0)) return -1
  if (!(rate > 1.01)) return -1
  let cap = -1
  for (let i = 0; i < levels.length; i++) {
    const bitrate = levels[i]?.bitrate || 0
    if (bitrate > 0 && bitrate * rate <= bandwidth * ABR_HEADROOM) cap = i
  }
  // 一档都不满足时落到最低档：维持 -1 会一直在高码率档上反复欠载
  return cap >= 0 ? cap : 0
}

export interface UnderrunState {
  /** 用户选的倍速 */
  wantedRate: number
  /** 是否已经因为欠载降过速 */
  dropped: boolean
  /** 窗口内连续缓冲次数 */
  hits: number
  /** 当前缓冲垫（秒） */
  bufferedAhead: number
}

/** 连续两次缓冲且垫子见底 → 值得临时降到 1x */
export function shouldDropRate(s: UnderrunState): boolean {
  if (!(s.wantedRate > 1.01) || s.dropped) return false
  if (s.hits < 2) return false
  return s.bufferedAhead <= UNDERRUN_BUFFER_SEC
}

export interface HlsBufferProfile {
  /** hls.js 目标前向缓冲（秒） */
  maxBufferLength: number
  /** 前向缓冲上限（秒） */
  maxMaxBufferLength: number
  /** hls.js 用来推算目标缓冲的码率参考（字节） */
  maxBufferSize: number
  /** 回拖保留的后向缓冲（秒） */
  backBufferLength: number
}

/**
 * 按设备内存/端类型选 hls.js 缓冲档。
 *
 * <p>原来写死 180/300 秒 / 120MB / 60 秒回看。4K 实测播放 110 秒时
 * renderer 469MB、GPU 私 590MB；退出后 30 秒仍留 244MB/176MB。
 * 缓冲秒数是内存的第一驱动（4K 40Mbps × 180s ≈ 900MB 的编码数据，
 * 还没算 MSE/解码表面），所以按设备收：
 *
 *   · TV / 低内存（≤2GB）：60 / 120 / 48MB / 30s
 *   · 中内存（≤4GB）：90 / 150 / 64MB / 30s
 *   · 桌面高内存：120 / 180 / 80MB / 30s
 *
 * <p>`maxBufferSize` 不是硬字节上限（hls.js 用它反推目标缓冲长度），
 * 真正压内存的是 maxBufferLength/maxMaxBufferLength。保留 30 秒回看
 * 是为了回拖不重新拉分片，又不把已看过的整段留在内存里。
 */
export function hlsBufferProfile(
  deviceMemoryGB?: number,
  tvShell = false,
): HlsBufferProfile {
  const mem = Number(deviceMemoryGB)
  if (tvShell || (Number.isFinite(mem) && mem > 0 && mem <= 2)) {
    return { maxBufferLength: 60, maxMaxBufferLength: 120, maxBufferSize: 48 * 1024 * 1024, backBufferLength: 30 }
  }
  if (Number.isFinite(mem) && mem > 0 && mem <= 4) {
    return { maxBufferLength: 90, maxMaxBufferLength: 150, maxBufferSize: 64 * 1024 * 1024, backBufferLength: 30 }
  }
  return { maxBufferLength: 120, maxMaxBufferLength: 180, maxBufferSize: 80 * 1024 * 1024, backBufferLength: 30 }
}

/** 降速后：观察够久 + 缓冲够深 → 回到用户倍速 */
export function shouldRestoreRate(s: {
  dropped: boolean
  sinceMs: number
  bufferedAhead: number
}): boolean {
  if (!s.dropped) return false
  if (s.sinceMs < RATE_RESTORE_OBSERVE_MS) return false
  return s.bufferedAhead >= RATE_RESTORE_BUFFER_SEC
}
