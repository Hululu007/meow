import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 「我的缓存」海报墙 / 详情层的结构门禁。
 *
 * 这几条锁的是 2026-10-30 用户两次明确提出的交互约定，
 * 不是实现细节 —— 改版时最容易顺手退回去的就是它们：
 *
 *   1. 卡片上不要「播放 / 删除」按钮，点海报进详情页做管理；
 *   2. 不要套深层面板（TV 上要在两层弹框之间挪焦点、退层还得先关弹框）；
 *   3. 详情层是页面内换层（不改路由），所以必须自己接管 TV 返回键。
 */
// jsdom 环境下 import.meta.url 不是 file:// 协议，路径用 __dirname 拼
const SRC = readFileSync(join(__dirname, '..', 'src', 'components', 'library', 'CachePanel.vue'), 'utf8')

/** 去掉注释，避免注释里写的「不要播放按钮」把断言骗过去。 */
function codeOnly(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('我的缓存：海报墙卡片', () => {
  const code = codeOnly(SRC)

  it('卡片上不再有「播放」「删除」两个按钮', () => {
    // 卡片区：从海报墙网格到该模板分支收尾
    const start = code.indexOf('class="poster-grid"')
    expect(start).toBeGreaterThan(-1)
    const card = code.slice(start, code.indexOf('</template>', start))
    expect(card).not.toContain('播放')
    expect(card).not.toContain('删除')
  })

  it('整张卡可点，且点击走 openDetail 而不是直接播放', () => {
    const start = code.indexOf('class="poster-grid"')
    const card = code.slice(start, code.indexOf('</template>', start))
    expect(card).toContain('@click="openDetail(v)"')
    expect(card).not.toContain('playFirst(v)')
  })

  it('列数与本地片库同一套（useCardCols + poster-grid），不写死断点', () => {
    expect(code).toContain('useCardCols({ maxWidth: 1400 })')
    expect(code).toContain(':style="colsStyle(cols)"')
    expect(code).not.toContain('sm:grid-cols-3')
  })
})

describe('我的缓存：详情层', () => {
  const code = codeOnly(SRC)

  it('不再用 Teleport 弹框（深层面板在 TV 上不好操作）', () => {
    expect(code).not.toContain('<Teleport')
  })

  it('详情层是页面内换层：openedVod 非空时渲染海报 + 选集', () => {
    expect(code).toContain('<template v-if="openedVod">')
    expect(code).toContain('选集')
    expect(code).toContain('@click="onEpClick(openedVod, e)"')
  })

  it('详情层打开时接管 TV 返回键，关闭后只还原自己挂的那个', () => {
    expect(code).toContain('__meowTvConsumeBack')
    expect(code).toContain('w.__meowTvConsumeBack === detailBack')
  })

  it('单集操作条按「当前选中集」出按钮，不再每格塞一排按钮', () => {
    expect(code).toContain('selEpObj')
    expect(code).toContain("selEpObj.state === 'failed'")
  })
})
