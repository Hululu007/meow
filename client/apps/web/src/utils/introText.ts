/**
 * 源站详情文本的净化。
 *
 * <p><b>为什么需要</b>：`vod_content` / `vod_actor` 是各源站自己拼的字符串，
 * 质量参差。实测（2026-11-12，B 站源）详情页第一行就是
 * `{"id":"440933925/(pg)","name":"bili_75394567453"}]/bili_75394567453[/a]` ——
 * HTML 标签、BBcode 和源站的结构化字段全被当正文渲染出来了。
 * 逐个源修不现实（站点表有 40+ 个），统一在渲染前剥一层。
 *
 * <p><b>为什么不做成 v-html 白名单</b>：简介里本来就没有值得保留的富文本
 * （没有图文排版需求），而 v-html 会引入注入面。直接转纯文本最省事也最安全。
 */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
}

/**
 * 剥掉标签 / BBcode / 元数据 JSON，并收口空白。
 *
 * 保留单个换行（有些源用 `<br>` 分段），连续空行压成一行。
 */
export function cleanIntro(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = String(raw)

  // 1) HTML：注释、换行标签换成真正换行，块级标签断行；
  //    行内标签直接删掉（换成空格会把「好看的<span>剧</span>」切成「好看的 剧」）
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<\s*br\s*\/?>/gi, '\n')
  s = s.replace(/<\/?\s*(p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')

  // 2) BBcode：[a=cr:…]…[/a]、[img]…[/img]、[color=…] 之类（同理直接删）
  s = s.replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/gi, '')

  // 3) 源站塞进简介的结构化字段：{"id":"…","name":"…"}
  s = s.replace(/\{[^{}]*"[^{}]*:[^{}]*\}/g, ' ')

  // 4) 常见实体（先于空白收口：&nbsp; 要变成普通空格）
  s = s.replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? ' ')

  // 5) 首尾残留的 ASCII 括号/斜杠（JSON 被拿走后会剩 `]`、`}/bili_xxx`）
  s = s.replace(/^[\s\])}{\[]+/, '')
  s = s.replace(/[\s\])}{\[]+$/, '')

  // 6) 空白收口
  const text = s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

  /*
   * 6) 净化完只剩一个 ASCII 单词 = 源站塞的标识符（实测 `bili_75394567453`），
   *    当正文显示毫无意义。中文/正常英文句子都带空格或汉字，不会被误杀。
   */
  if (/^[A-Za-z0-9_.\-/]{1,40}$/.test(text)) return ''
  return text
}

/** 单行字段（导演 / 主演）：同上，但把换行压成空格 */
export function cleanLine(raw: string | null | undefined): string {
  return cleanIntro(raw).replace(/\s*\n\s*/g, ' ').trim()
}
