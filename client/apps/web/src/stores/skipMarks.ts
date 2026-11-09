/**
 * 自定义片头 / 片尾（按「剧集」而不是按「集」记）。
 *
 * ## 为什么单独一个文件、而不是塞进 prefs 或 history
 *
 * - `prefs` 是"设置"，片头片尾是"某部片的元数据"，混进去会让设置备份带上
 *   几百部片的秒数，且清空设置不该丢这些标记。
 * - `history` 会被 `historyLimit` 裁剪（默认 30 条），标记跟着被删不合理；
 *   而且历史是"最近看过"的流水，标记是用户手动维护的长期数据。
 *
 * ## 为什么挂在 site + vod_id 上
 *
 * 同一部剧的每一集片头长度基本一致，用户不该每集都点一次。
 * 换集时视频地址变、集名变，但 `site` / `vod_id` 不变，所以能跨集保留。
 *
 * ## 为什么分 intro / outro 两个数
 *
 * - intro = 「片头在正片开始处结束」的绝对秒数。播放位置 < intro 时提示"跳过片头"。
 * - outro = 「片尾开始处距结尾的秒数」。位置 >= duration - outro 时提示"跳过片尾"。
 *
 * 两种语义都是「点一下，以当前时间为准」：
 *   在片头结束处点「设片头」→ 记下当前时间
 *   在片尾开始处点「设片尾」→ 记下 duration - 当前时间
 */

export interface SkipMarks {
  /** 片头结束于第几秒；0 = 未设置 */
  intro: number
  /** 片尾开始于「距结尾多少秒」；0 = 未设置 */
  outro: number
  /** 最后修改时间，用于未来跨端合并时取较新的一条 */
  at: number
}

type MarkMap = Record<string, SkipMarks>

const KEY = 'meow.skipmarks'

/** 存储键：同一部片的各集共用一套标记 */
function keyOf(site: string, vodId: string): string {
  return `${site}|${vodId}`
}

function readAll(): MarkMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? (o as MarkMap) : {}
  } catch {
    return {}
  }
}

function writeAll(m: MarkMap) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* 配额满时忽略——标记不是关键数据 */
  }
}

export function getSkipMarks(site: string, vodId: string): SkipMarks {
  const all = readAll()
  const v = all[keyOf(site, vodId)]
  if (!v) return { intro: 0, outro: 0, at: 0 }
  return {
    intro: Number.isFinite(v.intro) && v.intro > 0 ? v.intro : 0,
    outro: Number.isFinite(v.outro) && v.outro > 0 ? v.outro : 0,
    at: Number.isFinite(v.at) ? v.at : 0,
  }
}

/** 写其中一项，另一项保持不变。传 0 表示清除该项。 */
export function setSkipMark(
  site: string,
  vodId: string,
  patch: { intro?: number; outro?: number },
): SkipMarks {
  const all = readAll()
  const k = keyOf(site, vodId)
  const prev = all[k] || { intro: 0, outro: 0, at: 0 }
  const next: SkipMarks = {
    intro: Math.max(0, Math.round(patch.intro ?? prev.intro)),
    outro: Math.max(0, Math.round(patch.outro ?? prev.outro)),
    at: Date.now(),
  }
  all[k] = next
  writeAll(all)
  return next
}

export function clearSkipMarks(site: string, vodId: string) {
  const all = readAll()
  delete all[keyOf(site, vodId)]
  writeAll(all)
}

/** 全部条目（设置页「清空所有标记」用） */
export function listSkipMarks(): Array<{ key: string; marks: SkipMarks }> {
  return Object.entries(readAll()).map(([key, marks]) => ({ key, marks }))
}
