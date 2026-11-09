/**
 * play 结果的"附加字段"解析：片头片尾、字幕、起播点。
 *
 * ## 为什么单独一层纯函数
 *
 * 这些字段的单位和合法性规则都由 CatVod 侧定义（毫秒、type 枚举、
 * ending 的 end 可缺省），换算成本地口径（秒、绝对时刻）如果散在
 * 组件里，测试就得挂 DOM。集中在这里之后，规则能被单测直接钉住。
 *
 * ## 单位
 *
 * 源站一律给**毫秒**（CatVodSpider 的 `Demo.skips()` 与 `Response.position()`
 * 都按毫秒校验），本文件对外一律给**秒**。转换只在这里做一次。
 */

/** CatVod `skips` 的一项。`end` 只在 ending 时可缺省（表示"直到结尾"）。 */
export interface SkipSegment {
  type?: string
  start?: number | string | null
  end?: number | string | null
}

export interface SubTrack {
  url?: string
  name?: string
  lang?: string
  format?: string
}

export interface Quality {
  name?: string
  url?: string
}

export interface SkipWindow {
  /** 片头结束的绝对秒数；0 表示没有可用片头段 */
  openingEnd: number
  /** 片尾开始的绝对秒数；0 表示没有可用片尾段 */
  endingStart: number
  /** 中插广告区间（绝对秒）。默认不跳，要用户显式开「跳过中插」 */
  middles: MiddleSegment[]
}

/** 中插广告段。越界/倒置的段在解析时就被丢掉，到这里的都是合法区间。 */
export interface MiddleSegment {
  start: number
  end: number
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : NaN
}

/**
 * 把 `skips` 折成两个绝对秒数。
 *
 * 合法性照抄 Fongmi 的 `SkipSegment.isValid()`：
 * - opening 必须 start>=0 且有 end>start（`start===0` 才是"片头"，
 *   否则那段其实是从中间开始的，跳过它会丢正片内容）；
 * - ending 允许只给 start（表示直到结尾），start 必须 >0。
 * - middle 是插播广告，默认不跳（跳过中段会打断剧情），
 *   要用户显式打开「跳过中插」才用；这里照样解析出来，开关在播放器侧。
 *
 * 同类型出现多段时取"最保守"的边界：片头取最晚结束，片尾取最早开始。
 */
export function skipWindowFrom(skips: SkipSegment[] | undefined | null): SkipWindow {
  const out: SkipWindow = { openingEnd: 0, endingStart: 0, middles: [] }
  if (!Array.isArray(skips)) return out
  for (const s of skips) {
    if (!s || typeof s !== 'object') continue
    const type = typeof s.type === 'string' ? s.type : ''
    const start = num(s.start)
    const end = s.end === null || s.end === undefined ? NaN : num(s.end)
    if (type === 'opening') {
      if (!Number.isFinite(start) || start !== 0) continue
      if (!Number.isFinite(end) || end <= start) continue
      out.openingEnd = Math.max(out.openingEnd, end / 1000)
    } else if (type === 'ending') {
      if (!Number.isFinite(start) || start <= 0) continue
      // end 缺省 = 到结尾，合法；给了就必须晚于 start
      if (Number.isFinite(end) && end <= start) continue
      const at = start / 1000
      out.endingStart = out.endingStart > 0 ? Math.min(out.endingStart, at) : at
    } else if (type === 'middle') {
      // 中插必须有明确起止；只有 start 的中插无法判断该跳多久，宁可不动
      if (!Number.isFinite(start) || start <= 0) continue
      if (!Number.isFinite(end) || end <= start) continue
      out.middles.push({ start: start / 1000, end: end / 1000 })
    }
  }
  // 按开始时间排序：播放器是"顺路遇到才跳"，乱序会让判断漏段
  out.middles.sort((a, b) => a.start - b.start)
  return out
}

/** 起播点（毫秒）→ 秒；非法返回 0 */
export function startAtFrom(position: unknown): number {
  const n = num(position)
  return Number.isFinite(n) && n > 0 ? n / 1000 : 0
}

/** 只保留能真正渲染的字幕（有 url）。浏览器 `<track>` 只吃 WebVTT，其余靠 srtToVtt 转换。 */
export function subTracksFrom(subs: SubTrack[] | undefined | null): SubTrack[] {
  if (!Array.isArray(subs)) return []
  return subs.filter((s) => !!s && typeof s === 'object' && typeof s.url === 'string' && /^https?:/i.test(s.url))
}

/** 按扩展名/format 猜字幕格式，用于决定要不要转换 */
export function subtitleFormat(sub: SubTrack): 'vtt' | 'srt' | 'ass' | 'other' {
  const raw = `${sub.format || ''} ${sub.url || ''}`.toLowerCase()
  if (raw.includes('vtt')) return 'vtt'
  if (raw.includes('srt')) return 'srt'
  // ass/ssa 是同一族（SSA 是 ASS 的前身，格式兼容）。
  // 不能写 \bass\b：URL 里的 `a.ass` 前面是点，`\b` 成立；但 `a.sub` 里
  // "s" 后面接 "ub" 不成立——真正会误伤的是把 format 写成一串时
  // 子串命中（如 "assrt"）。所以要求前面是文件分隔符或空白。
  if (/(?:^|[\s./_-])(?:ass|ssa)(?:$|[\s?&#.])/.test(raw)) return 'ass'
  return 'other'
}

/**
 * SRT → WebVTT。
 *
 * 浏览器原生 `<track>` 只支持 WebVTT，而国内源绝大多数是 SRT——不转就等于
 * "字幕字段拿到了却永远显示不出来"。
 *
 * 两处必须改的地方：
 * 1. 加 `WEBVTT` 头（缺了整份文件被浏览器判定无效）；
 * 2. 时间轴的分秒分隔符 `,` 换成 `.`。
 * 顺带去掉 SRT 的序号行——VTT 不要求，留着也能用，但留着容易和 cue id 混淆。
 *
 * 已经是 VTT 的原文直接放行（有些源把 vtt 命名成 .srt）。
 */
export function srtToVtt(text: string): string {
  if (!text) return ''
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (/^\s*WEBVTT/.test(normalized)) return normalized
  const body = normalized
    .split('\n')
    // 纯数字行是 SRT 的 cue 序号
    .filter((line) => !/^\s*\d+\s*$/.test(line))
    .map((line) =>
      line.includes('-->')
        ? line.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
        : line,
    )
    .join('\n')
  return `WEBVTT\n\n${body.trim()}\n`
}

/**
 * ASS / SSA → WebVTT。
 *
 * ## 为什么只做"文字 + 时间"，不做完整排版
 *
 * ASS 的排版靠 `[V4+ Styles]` 里的字体/描边/定位，加上每句里的 `{\pos(...)}`
 * 覆盖标签。浏览器 `<track>` 不支持这些，硬要模拟就得自己写渲染层
 * （等于重做一个字幕库）。这里只保留「什么时间显示什么文字」，
 * 丢样式但保证**字幕能看**——这比"检测到 ass 就不显示"好得多。
 *
 * ## 必须处理的四件事
 *
 * 1. 时间格式是 `H:MM:SS.cc`（**两位百分秒**，不是三位毫秒），
 *    直接当毫秒用会慢 10 倍；
 * 2. 每句以 `Dialogue:` 开头，字段用逗号分隔，但**文字本身可以含逗号**，
 *    所以只能按固定前 9 个逗号切分，剩下的整段是文字；
 * 3. `{\...}` 是覆盖标签，`\N` `\n` 是换行，都要清掉/换掉；
 * 4. `[Events]` 之外的段落全部忽略（样式、脚本信息）。
 *
 * 已经是 VTT 的原文直接放行。
 */
export function assToVtt(text: string): string {
  if (!text) return ''
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (/^\s*WEBVTT/.test(normalized)) return normalized

  // 只看 [Events] 段；ASS 里 Dialogue 也可能写成 Comment（要跳过）
  const lines = normalized.split('\n')
  let inEvents = false
  const cues: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line)
      continue
    }
    if (!inEvents) continue
    if (!/^Dialogue\s*:/i.test(line)) continue

    // Format 行声明字段顺序，但现实中几乎都是固定 10 段；
    // 按"前 9 个逗号"切，保证文字里的逗号不被切碎
    const body = line.replace(/^Dialogue\s*:\s*/i, '')
    const parts = splitN(body, 9)
    if (parts.length < 10) continue
    // 字段顺序：Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    const start = assTimeToVtt(parts[1])
    const end = assTimeToVtt(parts[2])
    if (!start || !end) continue
    const content = parts[9]
      .replace(/\{[^}]*\}/g, '')      // 覆盖标签
      .replace(/\\[Nn]/g, '\n')       // 硬换行
      .replace(/\\h/g, ' ')           // 硬空格
      .trim()
    if (!content) continue
    cues.push(`${start} --> ${end}\n${content}`)
  }
  if (!cues.length) return ''
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/** 按前 n 个分隔符切分，第 n+1 段保留剩余内容（含分隔符） */
function splitN(s: string, n: number): string[] {
  const out: string[] = []
  let rest = s
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf(',')
    if (idx < 0) return out
    out.push(rest.slice(0, idx))
    rest = rest.slice(idx + 1)
  }
  out.push(rest)
  return out
}

/**
 * ASS 时间 `H:MM:SS.cc` → VTT `HH:MM:SS.mmm`。
 *
 * 两位是**百分秒**：`0:00:01.50` 是 1.5 秒，不是 1.05 秒。
 * 按毫秒直接拼会得到 1.05 秒——这是把 ASS 当 SRT 转最容易踩的坑。
 */
function assTimeToVtt(t: string): string {
  const m = t.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,2})$/)
  if (!m) return ''
  const h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3])
  // 两位补成毫秒：50 → 500ms
  const cs = Number(m[4].padEnd(2, '0'))
  const ms = cs * 10
  return `${pad2(h)}:${pad2(mi)}:${pad2(s)}.${String(ms).padStart(3, '0')}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

