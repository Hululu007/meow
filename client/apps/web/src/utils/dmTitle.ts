/**
 * 弹幕候选标题的清洗与集数提取。
 *
 * <p><b>为什么单独成文件</b>：这段逻辑有多条正则、容易被后续改动悄悄弄坏，
 * 而它直接决定用户在「搜索弹幕」列表里能不能看出"这是第几集"。
 * 放在组件里只能靠静态断言（"代码里有没有这行"），抽出来才能用真实样本测。
 *
 * <p>背景（2026-10-31 用户报）：danmu_api 返回的候选 `name` 形如
 * `我不是大师(2026)【国产剧】第1集 from iqiyi`，原来整条 truncate 后
 * 完全看不出集数，列表里 94 条长得一模一样。
 */

/**
 * 从候选里抽集数徽标（「第3集」→ `EP03`）。
 *
 * @returns 形如 `EP03`；抽不到返回空串（模板据此不渲染徽标）
 */
export function epBadgeOf(item: { name?: string; episode?: number }): string {
  const explicit = typeof item.episode === 'number' ? item.episode : 0
  if (explicit > 0) return 'EP' + String(explicit).padStart(2, '0')
  const s = item.name || ''
  // 「第3集」「第 3 话」「第12期」
  let m = /第\s*(\d{1,4})\s*[集话話期]/.exec(s)
  // 「EP05」「E5」「S01E05」
  if (!m) m = /(?:^|[\s._\-([])(?:S\d{1,2})?E(?:P)?\s*(\d{1,4})\b/i.exec(s)
  if (!m) return ''
  return 'EP' + String(parseInt(m[1], 10)).padStart(2, '0')
}

/**
 * 候选标题的可读部分：去掉年份、季数、类型标签、`from xxx` 后缀。
 *
 * <p>只做减法、不重排：正则不匹配时原样返回，绝不会变成空串。
 * 列表里已有独立的来源列，正文再带一遍 `from iqiyi` 只会把剧名挤掉。
 */
export function cleanDmTitle(name?: string): string {
  let s = (name || '').trim()
  if (!s) return '(无标题)'
  s = s.replace(/\s+from\s+\S+\s*$/i, '')          // from iqiyi / from tencent
  s = s.replace(/[\s·]*【[^】]*】/g, '')             // 【国产剧】【动画】
  s = s.replace(/[\s·]*[（(]\s*\d{4}\s*[)）]/g, '') // (2026)
  // 季数：中文数字与阿拉伯数字都要去掉。
  // ★ 只写 `\d+` 时「庆余年 第二季」会被原样留下（实测踩过）。
  s = s.replace(/[\s·]*第\s*[0-9一二三四五六七八九十]+\s*季/g, '')
  s = s.replace(/[\s·]+/g, ' ').trim()
  // 删完常留下「 - 」这类残渣，清掉首尾分隔符
  s = s.replace(/^[\s\-·|:：]+|[\s\-·|:：]+$/g, '')
  return s || (name || '').trim()
}
