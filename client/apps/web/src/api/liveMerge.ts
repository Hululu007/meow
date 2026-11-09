/**
 * 多源直播合并（纯函数，无 Vue / DOM 依赖）。
 *
 * <p>为什么需要单独一层：`LiveView` 已经 2600 行，而"跨源同名台识别"这件事
 * 是**唯一无法靠肉眼验证**的部分 —— 归一化规则写宽了会把不同台并掉
 * （CCTV-5 与 CCTV-5+），写窄了同一个台会并列两行。放在纯函数里可以用
 * 真实 m3u 台名做单测，改规则立刻知道并掉了谁。
 *
 * <p>实测数据（2026-11-06）：
 * <ul>
 *   <li>Guovin/iptv-api：836 条 → 332 个唯一台，中文分类（📺央视频道…）</li>
 *   <li>iptv-org/cn：149 条 → 153 个唯一台，英文分类（News / General…）</li>
 *   <li>归一化后**交集只有 14 个**（CCTV 系列 + CCTV-5+）→ 合并后约 471 个台</li>
 * </ul>
 * 所以"重复台"不是主要矛盾，**分类名中文化**才是（否则列表里会出现
 * 35 个 Undefined、30 个 General，用户不知道那是什么）。
 */

/** 一条源解析后的结果 */
export interface ParsedSource {
  /** 源显示名（用户配置里的 name），会作为线路来源标注 */
  name: string
  /** 源 URL（记住"上次用哪条源"时要用） */
  url: string
  /** 后端 `/api/live/playlist` 解析出的分组 */
  groups: Array<{ group: string; channels: Array<{ name?: string; urls?: string[] }> }>
}

/** 合并后的台（urls 与 srcs 同长度，一一对应） */
export interface MergedChannel {
  name: string
  urls: string[]
  /** 每条 url 来自哪个源（面板/换线路提示用） */
  srcs: string[]
}

/** 合并后的分组 */
export interface MergedGroup {
  group: string
  channels: MergedChannel[]
}

/**
 * 台名归一化：跨源同名识别。
 *
 * <p>规则来自两个源的真实写法对比：
 * <pre>
 *   Guovin     CCTV-1            CCTV-1 HD       CCTV-6
 *   iptv-org   CCTV-1 (720p)     CCTV-1 HD (1080p)   CCTV-6 [Geo-blocked]
 * </pre>
 * 目标：以上全部归到 `cctv1` / `cctv6`。
 *
 * <p><b>刻意不做的两件事</b>：
 * <ul>
 *   <li>不去 `4k` / `8k` —— `CCTV-4K` 是**独立频道**，去掉会并进 `CCTV`；
 *       只去 hd/sd/fhd/uhd 这类"同一台的清晰度版本"标记（合并成多线路是合理的）</li>
 *   <li>不做中英文互译 —— `Anhui TV` 与 `安徽卫视` 无法可靠自动关联
 *       （需要 tvg-id 映射表），宁可并列两行也不要错误合并</li>
 * </ul>
 */
export function normChannelName(raw: string): string {
  let s = String(raw || '').toLowerCase()
  // [Geo-blocked] / [Not 24/7] 这类"能不能播"的标记，不是台名
  s = s.replace(/\[[^\]]*\]/g, '')
  // (720p) / （高清）这类补充说明
  s = s.replace(/[（(][^）)]*[）)]/g, '')
  // 制式：1080p / 720p / 576i / 480p / 600p
  s = s.replace(/\d{3,4}[pi]/g, '')
  // 分隔符全去掉：CCTV-1 / CCTV 1 / cctv_1 是同一个台
  s = s.replace(/[\s\-_·.]/g, '')
  // 中文清晰度词
  s = s.replace(/(高清|超清|标清|蓝光)/g, '')
  // 结尾的英文清晰度（此时分隔符已去掉，CCTV-1 HD → cctv1hd）
  s = s.replace(/(fhd|uhd|hd|sd)$/g, '')
  return s || String(raw || '').trim().toLowerCase()
}

/**
 * 显示名清理：去掉 `[Geo-blocked]` / `[Not 24/7]` 这类**来源标记**。
 *
 * <p>它们是 iptv-org 标注"能不能播"的字段，对观众是纯噪音，而且占宽度 ——
 * 面板右列只有约 216px，`Beijing Satellite TV [Not 24/7]` 会把线路标记
 * 挤出可视区（实测截图）。
 *
 * <p>**保留** `(720p)` / `(1080p)` 这类画质后缀：那是有效信息（用户选台时
 * 可能就想要高清那条）。
 */
export function cleanChannelName(raw: string): string {
  return String(raw || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 英文分组名 → 中文。
 *
 * <p>iptv-org 的分类是英文的（General/News/Undefined…），直接显示会和
 * Guovin 的中文分类混在同一个下拉里，用户看到 35 个 "Undefined" 完全
 * 不知道是什么。未命中的保留原文（宁可显示英文也别塞进"其他"）。
 */
const GROUP_ZH: Record<string, string> = {
  undefined: '未分类',
  general: '综合',
  news: '新闻',
  movies: '电影',
  sports: '体育',
  lifestyle: '生活',
  education: '教育',
  business: '财经',
  music: '音乐',
  kids: '少儿',
  documentary: '纪录',
  entertainment: '娱乐',
  religious: '宗教',
  family: '家庭',
  culture: '文化',
  weather: '气象',
  shopping: '购物',
  travel: '旅游',
  science: '科教',
  auto: '汽车',
  food: '美食',
  outdoor: '户外',
  relax: '休闲',
  comedy: '喜剧',
  series: '剧集',
  animation: '动画',
}

export function zhGroupName(raw: string): string {
  const k = String(raw || '').trim()
  if (!k) return '未分类'
  return GROUP_ZH[k.toLowerCase()] || k
}

/**
 * 把多条源合并成一份台列表。
 *
 * <p>两遍式（方案 3，2026-11-06 用户定调）：
 * <ol>
 *   <li><b>第一遍建分类结构 + 收集全局线路池</b>：每个源的每个分类都保留，
 *       分类内同名台只建一行；同时把每条线路塞进"归一化台名 → 线路集合"的池</li>
 *   <li><b>第二遍回填线路</b>：每个分类里的台从池里取全部线路</li>
 * </ol>
 *
 * <p><b>为什么不是全局去重</b>（最初的实现，用户举反例否掉了）：
 * <pre>
 *   源1: A[CCTV1×2]  B[XXX, XXY]
 *   源2: C[XXX, YIUO, CCTV1]
 * </pre>
 * 全局去重会让 C 从 3 个台缩成 1 个（XXX 和 CCTV1 被搬到 A/B），
 * 用户点 C 找不到自己熟悉的台 —— "分类→台"的预期被破坏。
 *
 * <p><b>为什么线路要放全局池</b>：同一个台在不同源的分类里各出现一次，
 * 但线路应该共享 —— 在 A 点 CCTV1 和在 C 点 CCTV1，都能切全部 6 条线路
 * （跨源提可播率是合并的目的）。只按分类去重（方案 2）会丢掉这个收益。
 *
 * <p>代价（用户已接受）：同一个台可能出现在多个分类里（A 和 C 都有 CCTV1），
 * 但**同一个分类内永远只有一行**。
 *
 * @param preferUrl 上次使用的源 URL。只影响线路顺序（池上重排），
 *                  不影响分类归属和台名。
 */
export function mergeSources(sources: ParsedSource[], preferUrl?: string): MergedGroup[] {
  const byGroup = new Map<string, MergedGroup>()
  const order: string[] = []
  /** 全局线路池：归一化台名 → 线路集合 + 规范名（跨源、跨分类共享） */
  const pool = new Map<
    string,
    { name: string; urls: string[]; srcs: string[]; from: string[] }
  >()
  /** 每个分类内已建过的台（**跨源**：两个源都有"电影"分类时也只建一行） */
  const seenByGroup = new Map<string, Set<string>>()

  for (const src of sources) {
    const srcName = (src.name || '').trim() || '直播源'
    for (const g of src.groups || []) {
      const gname = zhGroupName(g.group)
      let bucket = byGroup.get(gname)
      if (!bucket) {
        bucket = { group: gname, channels: [] }
        byGroup.set(gname, bucket)
        order.push(gname)
      }
      let seen = seenByGroup.get(gname)
      if (!seen) {
        seen = new Set()
        seenByGroup.set(gname, seen)
      }
      for (const ch of g.channels || []) {
        const name = (ch.name || '').trim() || '未命名频道'
        const urls = (ch.urls || []).map((u) => String(u || '').trim()).filter(Boolean)
        if (!urls.length) continue
        const key = normChannelName(name)
        // 1) 全局池：追加线路（跨源合并的落点）
        let p = pool.get(key)
        if (!p) {
          // 规范名 = 首次出现的写法（清掉 [Geo-blocked] 这类噪音）：
          // 同一个台在**所有分类里用同一个名字**，否则 A 里叫 CCTV-1、
          // C 里叫 CCTV-1 (720p)，用户会以为是两个台
          p = { name: cleanChannelName(name) || name, urls: [], srcs: [], from: [] }
          pool.set(key, p)
        }
        for (const u of urls) {
          if (p.urls.includes(u)) continue
          p.urls.push(u)
          p.srcs.push(srcName)
          p.from.push(src.url)
        }
        // 2) 分类结构：同一分类内只建一行（跨分类各建各的，第二遍统一回填线路）
        if (seen.has(key)) continue
        seen.add(key)
        bucket.channels.push({ name, urls: [], srcs: [] })
      }
    }
  }

  // preferUrl：在**池上**重排一次，所有分类共享同一份线路顺序
  if (preferUrl) {
    for (const p of pool.values()) {
      const all = p.urls.map((_, i) => i)
      const mine = all.filter((i) => p.from[i] === preferUrl)
      if (!mine.length || mine[0] === 0) continue
      const pick = [...mine, ...all.filter((i) => p.from[i] !== preferUrl)]
      const urls = p.urls.slice()
      const srcs = p.srcs.slice()
      const from = p.from.slice()
      p.urls = pick.map((i) => urls[i])
      p.srcs = pick.map((i) => srcs[i])
      p.from = pick.map((i) => from[i])
    }
  }

  // 第二遍：回填线路 + 统一台名（每个分类里的台都拿到池里的全部线路）
  const out: MergedGroup[] = []
  for (const k of order) {
    const g = byGroup.get(k)!
    if (!g.channels.length) continue
    for (const ch of g.channels) {
      const p = pool.get(normChannelName(ch.name))
      if (!p) continue
      ch.name = p.name
      ch.urls = p.urls.slice()
      ch.srcs = p.srcs.slice()
    }
    out.push(g)
  }
  return out
}

/** 一组台里出现了几个不同的源（面板提示用） */
export function sourceCountOf(ch: { srcs?: string[] }): number {
  return new Set(ch.srcs || []).size
}

/** 把 `['Guovin','Guovin','iptv-org']` 压成 `Guovin 2 · iptv-org 1` */
export function describeSources(ch: { srcs?: string[] }): string {
  const count = new Map<string, number>()
  for (const s of ch.srcs || []) {
    if (!s) continue
    count.set(s, (count.get(s) || 0) + 1)
  }
  return [...count.entries()].map(([s, n]) => `${s} ${n}`).join(' · ')
}
