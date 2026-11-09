import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 简介默认折叠 4 行，超出时给「展开简介」。
 *
 * 两个容易写错的地方：
 *  ① 短简介不该出现按钮（否则每部片下面都挂一个点了没反应的链接）
 *  ② 展开/收起必须真的解除 `line-clamp`，不是只换文案
 */
const DETAIL = readFileSync(
  join(__dirname, '..', 'src', 'views', 'DetailView.vue'),
  'utf8',
)

describe('简介展开', () => {
  it('默认折叠 4 行，展开后解除', () => {
    expect(DETAIL).toMatch(/:class="descExpanded \? '' : 'line-clamp-4'"/)
  })

  it('只有被截断才出现按钮', () => {
    expect(DETAIL).toMatch(/v-if="descClamped \|\| descExpanded"/)
    // 判据：量出来的高度 + 字数兜底（老内核对 line-clamp 的 scrollHeight 不一定准）
    expect(DETAIL).toContain('scrollHeight > el.clientHeight + 2')
    expect(DETAIL).toContain('descText.value.length > 150')
  })

  it('换片时重置为折叠', () => {
    const i = DETAIL.indexOf('watch(descText')
    expect(i).toBeGreaterThan(-1)
    const body = DETAIL.slice(i, i + 160)
    expect(body).toContain('descExpanded.value = false')
  })

  it('窗口变化要重新测量（TV 根字号随视口变）', () => {
    expect(DETAIL).toContain("window.addEventListener('resize', onDescResize)")
    expect(DETAIL).toContain("window.removeEventListener('resize', onDescResize)")
  })
})
