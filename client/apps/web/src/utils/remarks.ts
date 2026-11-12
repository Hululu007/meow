/**
 * 海报角标文案：评分 → 右上，集数/其他备注 → 左下。
 *
 * <p>背景：源的 `vod_remarks` 是**一个字段承载两种语义**——
 * 豆瓣原生源（server/host 的 `DoubanSource`）在剧集上填 `episodes_info`
 * （"30集全" / "更新至15集"），电影没有集数时就退到评分（"8.8"）。
 * 只有这一路数据时，"既有评分又有集数"的剧集永远看不到评分。
 *
 * <p>现在后端会额外下发 `vod_score`；这里两个字段各归各位：
 *   · score  → 右上（优先 `vod_score`；老后端只有 remarks 时仍能识别纯评分）
 *   · remark → 左下（`vod_remarks`，但如果它本身就是评分就不再重复显示）
 *
 * <p>判据只认**一位小数的纯数字**：整数不动 —— CMS 源里 "12"（第 12 集）
 * 不能被当成 12 分挪到右上角。
 */
const SCORE = /^\d{1,2}\.\d$/

export function isScoreRemarks(raw?: string | null): boolean {
  return SCORE.test(String(raw ?? '').trim())
}

export interface PosterBadges {
  /** 右上角评分；空串表示不显示 */
  score: string
  /** 左下角集数/备注；空串表示不显示 */
  remark: string
}

export function posterBadges(item: { vod_remarks?: string; vod_score?: string }): PosterBadges {
  const remark = String(item.vod_remarks ?? '').trim()
  const explicit = String(item.vod_score ?? '').trim()

  // 显式 vod_score 优先；非一位小数也归一成一位小数。
  // ★ 用 `Math.round((n + EPSILON) * 10) / 10` 而不是 toFixed(1)：
  //   8.85 在二进制里是 8.84999…，直接 toFixed 会得到 8.8（看着像截断）。
  let score = ''
  if (explicit) {
    const n = Number(explicit)
    if (Number.isFinite(n) && n > 0) {
      score = (Math.round((n + Number.EPSILON) * 10) / 10).toFixed(1)
    }
  }
  if (!score && isScoreRemarks(remark)) score = remark

  // remarks 本身是评分时不再当集数显示，避免同一个数字出现两次
  return { score, remark: isScoreRemarks(remark) ? '' : remark }
}
