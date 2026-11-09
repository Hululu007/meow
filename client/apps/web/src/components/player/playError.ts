/**
 * 播放失败的类型。
 *
 * <p>为什么不能只传一句话：父组件的兜底顺序依赖"失败属于哪一类"。
 * 只有**解码/容器**类失败值得转码（同一集在不同源上编码基本一样，换线没用）；
 * 网络、超时、403 换线才有意义——原来一律先转码，PC 上白等 90 秒、
 * TV 上直接弹"找不到 ffmpeg"，而真实原因只是一次网络抖动。
 */
export type PlayErrorKind =
  /** 解码/容器不支持（MEDIA_ERROR、video.error 3/4） */
  | 'media'
  /** 清单/分片网络错误（重试耗尽、连接断开） */
  | 'network'
  /** 起播看门狗超时（连清单/首帧都没拿到） */
  | 'timeout'
  /** 清单能开、分片全部失败（假死） */
  | 'stall'
  /** 源站返回 4xx（404/410/403 等） */
  | 'http'
  /** 源站把分片换成了图片（伪流） */
  | 'fake'
  /** 地址本身不是媒体（解析器给错） */
  | 'src'
  | 'unknown'

export interface PlayErrorPayload {
  kind: PlayErrorKind
  msg: string
}

export function isPlayErrorPayload(v: unknown): v is PlayErrorPayload {
  return !!v && typeof v === 'object'
    && typeof (v as PlayErrorPayload).kind === 'string'
    && typeof (v as PlayErrorPayload).msg === 'string'
}

/** 这一类失败换线有用，转码没用 */
export function shouldTranscode(kind: PlayErrorKind): boolean {
  return kind === 'media' || kind === 'src' || kind === 'fake'
}
