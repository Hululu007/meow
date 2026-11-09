/**
 * 聚合搜索结果的排序（2026-11-02）。
 *
 * <p><b>为什么需要</b>：后端的 `merged` 是 `LinkedHashMap`，key 是
 * `源 + 片名 + vod_id`（`ApiServer.mergeOne`），**顺序就是"谁先返回谁在前"**，
 * 既没有排序也没有跨源归并。实测《我不是大师》一轮 53 条：
 *
 * ```
 * 0      我不是大师（荐片）              ← 正剧，靠运气排第一
 * 1-17   大师 / 我不是女巫 / 我不是龙套 … ← 同前缀的另一批剧（荐片一次吐 18 条）
 * 18-24  我不是大师（金牌 / 干饭）        ← 正剧被挤到第 25 位
 * 25-41  哔哩 17 条解说 / 预告 / 合集     ← 用户看到的"B站评析"
 * 42-52  我不是大师（优奇客 / 瓜子 / 潮流 …）← 正剧全在后面
 * ```
 *
 * AI 面板只取前 6 条、搜索页也是按这个顺序平铺，于是"搜正剧出来一堆解说"。
 *
 * <p><b>为什么排序放在前端而不是后端</b>：
 *   · 后端每收一个源就发一次快照，边收边排序会让卡片在用户眼前反复跳动；
 *     前端只在 `done` 的最终快照上排一次，渐进过程保持"新条目追加在末尾"。
 *   · 四端共用同一份 bundle，一处改完 Web / PC / TV 行为一致；判断逻辑可单测
 *     （后端 Java 在这个仓库里没有测试承载）。
 *
 * <p>排序**不删任何结果**——解说和花絮仍能翻到，只是不再占头部。
 */

import type { SearchGroup } from './types'

/** 归一化：只留字母数字与中文，去掉书名号/空格/标点后比较 */
export function normTitle(s: string): string {
  const raw = String(s || '').toLowerCase()
  const out = raw.replace(/[^0-9a-z\u4e00-\u9fff]/g, '')
  // 纯韩文/日文/符号标题会被清空，退回原文（否则空串会让 includes 恒真）
  return out || raw.replace(/\s+/g, '')
}

/**
 * 解说 / 花絮 / 预告类标题。
 *
 * 这些词只出现在 UGC 搬运标题里，正剧片名不会带（"解说"两字除外，但那种
 * 标题本身也不是用户要找的正片）。
 */
const UGC_RE =
  /(解说|讲解|解读|合集|预告|花絮|影评|片段|混剪|剪辑|一口气|万字|细嗦|拆解|reaction|直播|回放|录播|主题曲|片尾曲|插曲|第\s*\d+\s*期|\d+\s*期全)/i

/** 时长型备注（"391分鐘" / "78分钟"）—— 短视频/长视频搬运的典型特征 */
const DURATION_RE = /\d+\s*(分鐘|分钟|minutes?|mins?)/i

/** 剧集型备注（"24集全" / "更新至第24集" / "已完结"） */
const EPISODE_RE = /(全\s*\d+\s*集|\d+\s*集全|更新至|已完结|完结|第\s*\d+\s*集|电视剧|电影|综艺|动漫|纪录片)/

/**
 * 单条结果的得分。分数只用于排序，没有绝对含义。
 *
 * 权重依据实测那一轮的 53 条：正剧条目与解说条目的分差要大到
 * "11 个正剧源全部排在任何一条解说之前"，同时同类条目之间保持原顺序。
 */
export function scoreGroup(
  g: SearchGroup,
  wd: string,
  affinity?: Map<string, number>,
): number {
  const name = String(g.vod_name || '')
  const remarks = String(g.vod_remarks || '')
  const t = normTitle(name)
  const k = normTitle(wd)
  let s = 0

  // ① 片名与关键词的贴合度（决定性权重）
  if (k && t === k) s += 1000
  else if (k && t.startsWith(k)) s += 420
  else if (k && t.includes(k)) s += 220
  else if (k && k.includes(t)) s += 120

  // ② 解说/花絮/预告：压到正剧之后（-420 足以抵掉"包含关键词 + 集数备注"）。
  //    完全同名的条目不罚——真有部片就叫《直播》《解说》时它仍然排第一。
  if (UGC_RE.test(name) && !(k && t === k)) s -= 420

  /*
   * ②b 命中**用户自己的**噪音词表（后端在「仅排序降级」模式下打的标记）。
   *
   * 为什么比 UGC_RE 的 -420 更狠（-1200）：UGC_RE 是通用猜测，可能误判；
   * 而这条是用户明确填进词表的，意图确定 —— 应该沉到所有非噪音之后，
   * 包括"完全同名 +1000"那条（1000 - 1200 < 0）。填了词表又让完全同名的
   * 漏上来，等于开关没生效。
   */
  if (g.noise) s -= 1200

  // ③ 时长型备注也是 UGC 信号（正剧备注是集数，不是分钟数）
  if (DURATION_RE.test(remarks)) s -= 160

  // ④ 片名越长越可疑：正片名通常就是关键词本身或加个年份/季数
  if (k && t.length > k.length) s -= (t.length - k.length) * 10

  // ⑤ 有集数/已完结信息 → 更像正片
  if (EPISODE_RE.test(remarks)) s += 90

  // ⑥ 同一条目被多个源收录 → 更像正片（后端目前按源分组，恒为 1，留作扩展）
  s += Math.min(g.sources?.length || 0, 6) * 40

  // ⑦ 源偏好：这个用户平时在这家看得多 / 这家健康度好，同分时排前面
  if (affinity && g.sources?.length) {
    let best = 0
    for (const c of g.sources) best = Math.max(best, affinity.get(c.site) || 0)
    s += Math.max(-80, Math.min(80, best))
  }

  return s
}

/**
 * 源偏好权重（2026-11-03）。
 *
 * <p><b>回答用户的问题</b>：「AI 面板的聚合搜索排序，是否需要借助平时所播放
 * 观看统计的源，作为优先级参考？（或者用现有健康分？）」——**两个都要，
 * 但只作为同分次序，不参与"是不是正片"的判断**。
 *
 * <p>权重范围刻意压在 ±80：
 * <ul>
 *   <li>完全同名 +1000、UGC 惩罚 -420 —— 源偏好再高也翻不过这两条，
 *       否则"我爱看的源"会把它搬运的解说顶到正剧前面。</li>
 *   <li>但同一部正剧在 10 个源都有时（实测《我不是大师》1130 分并列 9 条），
 *       这 80 分足以把"你昨晚刚在这家看完一集"的源排到最前。</li>
 * </ul>
 *
 * <p>两个信号的含义不同，所以分开计：
 *   · **观看统计**（history）：真实行为，权重最高，但只算"真的播过"的
 *     （`pos > 0`）——只点开过详情不算，否则会奖励一堆死链的源。
 *   · **健康分**：源站现在是否可用。与后端 `HealthRoutes.score()` 同向
 *     （成功率/结果数/耗时），但这里不重算成功率（前端没有滑动窗口），
 *     只用 `lastCount` / `lastCostMs` / `degraded` 三个可见字段。
 */
export interface AffinityHistoryItem {
  site: string
  pos?: number
  dur?: number
  at?: number
}

export interface AffinityHealth {
  degraded?: boolean
  disabled?: boolean
  unsupported?: boolean
  lastCount?: number
  lastCostMs?: number
}

export function buildSiteAffinity(input: {
  history: AffinityHistoryItem[]
  health?: Record<string, AffinityHealth> | null
  now?: number
}): Map<string, number> {
  const now = input.now ?? Date.now()
  const map = new Map<string, number>()
  const add = (site: string, v: number) => {
    if (!site) return
    map.set(site, (map.get(site) || 0) + v)
  }

  // 观看统计：真播过 +14，只打开过 +3；一周内再看过的额外 +6（近期偏好更强）
  for (const h of input.history || []) {
    const played = (h.pos || 0) > 0 || (h.dur || 0) > 0
    add(h.site, played ? 14 : 3)
    if (played && h.at && now - h.at < 7 * 24 * 3600_000) add(h.site, 6)
  }

  // 健康分：结果多加分、慢扣分、降级/停用/不支持重罚
  for (const [site, d] of Object.entries(input.health || {})) {
    let s = 0
    s += Math.min(Math.max(Number(d.lastCount) || 0, 0), 20) * 1.5
    s -= Math.min(Math.max(Number(d.lastCostMs) || 0, 0) / 1000, 20)
    if (d.degraded) s -= 25
    if (d.disabled || d.unsupported) s -= 60
    add(site, s)
  }

  return map
}

/**
 * 排序并保持稳定性：同分按原顺序（源返回顺序）。
 *
 * 稳定很重要——同分时乱序会让同一部片在不同轮次里位置漂移。
 */
export function rankGroups(
  groups: SearchGroup[],
  wd: string,
  affinity?: Map<string, number>,
): SearchGroup[] {
  return groups
    .map((g, i) => ({ g, i, score: scoreGroup(g, wd, affinity) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.g)
}
