/**
 * CatVod 数据模型（与 spider 的 JSON 输出对应）
 */

export interface Site {
  key: string
  name: string
  api: string
  ext?: string
  type?: number
  /**
   * 源健康（后端 `recordHealth` 累计）。只在"调过至少一次"或"被手动停用"时才有。
   * `degraded` = 连续失败 ≥3 次；任意一次成功会立刻清掉。
   * `disabled` = 用户在设置页手动停用（没有时间窗，只有手动恢复才解除）。
   */
  health?: {
    ok: number
    fail: number
    /** 源站反复失败（连续 ≥3 次）。只用于展示与排序，不触发跳过 */
    degraded: boolean
    disabled?: boolean
    /**
     * 环境不支持（配置缺失 / JS 运行时没接）。会被聚合跳过，但不算故障——
     * 实测 270 站里 229 个是 drpy 源，需要 Node 运行时才有意义。
     */
    unsupported?: boolean
    unsupportedReason?: string
    /** 最近一次搜索返回的条目数（健康分用它奖励能出结果的源） */
    lastCount?: number
    lastCostMs?: number
    lastError?: string
    /**
     * 本轮搜索是否会被跳过 —— **由后端直接下发**，前端不要自己按 fail 次数算。
     *
     * 两个判据（见后端 HealthRoutes）：
     *   - `skippedTimeout` = 连续 2 次超时
     *   - `skippedFailed` = 累计失败 ≥5 次且 30 分钟内没成功过
     *
     * 都是"临时跳过"：10 分钟后自动重试，与 `disabled` 的永不过期不同。
     * 前端自己重算一定会和后端漂移，表现是"界面说没跳过、实际没搜索"。
     */
    skippedTimeout?: boolean
    skippedFailed?: boolean
    /** 连续超时次数（诊断用） */
    timeoutStreak?: number
    lastTimeoutAt?: number
    lastOkAt?: number
    lastFailAt?: number
  }
}

export interface HomeClass {
  type_id: string
  type_name: string
}

export interface VodItem {
  vod_id: string
  vod_name: string
  vod_pic?: string
  vod_remarks?: string
  vod_year?: string
  vod_area?: string
  vod_actor?: string
  vod_director?: string
  vod_content?: string
  vod_play_from?: string
  vod_play_url?: string
  vod_tag?: string
}

export interface HomeResult {
  class?: HomeClass[]
  list?: VodItem[]
  filters?: Record<string, FilterGroup[]>
}

export interface FilterGroup {
  key: string
  name: string
  value: Array<{ n: string; v: string }>
}

export interface CategoryResult {
  list?: VodItem[]
  page?: number | string
  pagecount?: number
  limit?: number
  total?: number
}

export interface DetailResult {
  list?: VodItem[]
}

export interface SearchResult {
  list?: VodItem[]
  page?: number | string
  pagecount?: number
}

export interface PlayResult {
  parse?: number
  url?: string | string[]
  header?: string | Record<string, string>
  format?: string
  danmaku?: string
  msg?: string
  jx?: number
  /**
   * 以下字段由后端 `normalizePlay` 原样透传，**单位是毫秒**（CatVod 契约）。
   * 换算成秒统一由 `api/playExtras.ts` 做，组件里不要再各算一遍。
   */
  skips?: Array<{ type?: string; start?: number; end?: number | null }>
  subs?: Array<{ url?: string; name?: string; lang?: string; format?: string }>
  /** 起播点（毫秒） */
  position?: number
  /** 多画质清单：后端把三种 url 形状都折成这个，画质标签不再丢 */
  qualities?: Array<{ name?: string; url?: string }>
}

/** 解析后的播放线路 */
export interface PlayLine {
  name: string
  episodes: Episode[]
}

export interface Episode {
  name: string
  url: string
}

/** 聚合搜索里的一个来源 */
export interface Candidate {
  site: string
  site_name: string
  vod_id: string
  remarks?: string
}

/** 聚合搜索结果（同名影片合并后的分组） */
export interface SearchGroup {
  vod_name: string
  vod_pic: string
  vod_remarks?: string
  /**
   * 命中用户的噪音词表（设置 → 搜索与源 → 噪音过滤）。
   *
   * <p>只有「仅排序降级」模式下后端才会带这个标记（过滤模式下这些条目
   * 已经被剔除，不会出现在结果里）。前端据此把它们压到最后。
   */
  noise?: boolean
  sources: Candidate[]
}
