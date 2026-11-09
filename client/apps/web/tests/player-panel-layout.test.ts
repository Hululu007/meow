import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 播放器浮层布局契约（2026-11-06 用户实测报障后加的）。
 *
 * 三个真问题，全部有实测数据：
 *  1. 选集列表"被挤扁"：165 集在 2000×1260 下应为 33 行 × 30px = 1182px，
 *     但 grid 行高被压到 27.6px（小视口 12px）——按钮带 `truncate`
 *     （overflow:hidden）让 auto 行的最小高度变 0，flex 受限高度下被无限压缩，
 *     结果既不滚也不正常显示。`auto-rows-min` 后行高 30px、scrollHeight 1182。
 *  2. 投影仪「更多」弹框右侧出界：面板宽度是 rem（w-44 = 11rem），
 *     收边逻辑却用写死的 px（176）。TV 根字号放大到 24px 时实际宽 264px，
 *     按 176 算左边界 → 右侧溢出 88px（实测 2560 宽时 right=2640 > 2560）。
 *  3. TV 聚焦到当前集时列表不滚：`focusInPanel` 拿面板本身当滚动容器，
 *     而真正滚的是里层 overflow-y-auto 的 grid —— 永远判不出需要滚。
 */
const PLAYER = join(__dirname, '..', 'src', 'components', 'player', 'VideoPlayer.vue')
const HOME = join(__dirname, '..', 'src', 'views', 'HomeView.vue')

describe('选集面板：行高不能被压扁', () => {
  const src = readFileSync(PLAYER, 'utf8')

  it('grid 用 auto-rows-min（min-content 兜住行高，压缩改滚动）', () => {
    const gridLine = src
      .split(String.fromCharCode(10))
      .find((l) => l.includes('grid-cols-5') && l.includes('overflow-y-auto')) || ''
    expect(gridLine).toContain('auto-rows-min')
    // min-h-0 + flex-1 必须保留：面板 max-h 生效时把剩余高度给 grid
    expect(gridLine).toContain('min-h-0')
    expect(gridLine).toContain('flex-1')
  })
})

describe('面板收边：宽度必须与模板同单位（rem）', () => {
  const src = readFileSync(PLAYER, 'utf8')

  it('用 PANEL_REM 换算根字号，不再写死 px', () => {
    expect(src).toContain('PANEL_REM')
    expect(src).toContain('rootFontSize()')
    // 旧常量必须消失（写死 px 是投影仪出界的根因）
    expect(src).not.toContain('const PANEL_W')
  })

  it('rem 值与模板宽度类一致（ep 22 / dm 19 / more 11 / help 20）', () => {
    const m = src.match(/PANEL_REM[^=]*=\s*\{([^}]+)\}/)
    expect(m).toBeTruthy()
    const body = m![1]
    expect(body).toMatch(/ep:\s*22/)
    expect(body).toMatch(/line:\s*22/)
    expect(body).toMatch(/dm:\s*19/)
    expect(body).toMatch(/more:\s*11/)
    expect(body).toMatch(/help:\s*20/)
    // 模板里对应的宽度类必须还在（对不上就说明有人改了宽度忘了改常量）
    // ★ 不能写 min()：Chrome 66（投影仪）不支持 CSS min()，整条声明会被丢弃
    //   → 宽度回到 auto、右侧溢出。w + max-w 等价且是老特性。
    expect(src).toContain('w-[22rem] max-w-[calc(100%-1rem)]')
    expect(src).toContain('w-[19rem] max-w-[calc(100%-1rem)]')
    expect(src).toContain('w-44')
    expect(src).toContain('w-[20rem]')
    expect(src).not.toContain('w-[min(')
  })
})

describe('选集定位：打开即定位当前集', () => {
  const src = readFileSync(PLAYER, 'utf8')

  it('打开面板时滚到当前集（PC 与 TV 都生效）', () => {
    expect(src).toContain('centerCurrentEp')
    expect(src).toContain('data-panel="ep"')
    // 当前集要有可定位的锚（aria-current 而不是靠转义类名）
    expect(src).toContain(`:aria-current="i === currentIndex ? 'true' : undefined"`)
  })

  it('滚动容器要往上找真正能滚的那层（面板本身 overflow 可见）', () => {
    expect(src).toContain('scrollIntoViewInScroller')
    expect(src).toContain(`cs.overflowY === 'auto' || cs.overflowY === 'scroll'`)
    // 原来直接拿 closest('[data-tv-scope]') 当滚动容器 —— 已废弃
    expect(src).not.toContain(`const scroller = pick.closest('[data-tv-scope]')`)
  })
})

describe('新集角标：数字不带色、角标走主题色', () => {
  const src = readFileSync(PLAYER, 'utf8')

  it('新集格子不再染红数字，只留角点', () => {
    // epCellClass 里不能出现 text-hot/text-accent 分支
    const fn = src.slice(src.indexOf('function epCellClass'), src.indexOf('function epCellClass') + 400)
    expect(fn).not.toContain('text-hot')
    expect(fn).not.toContain('text-accent')
  })

  it('角点用 bg-accent（换肤跟随），不用写死的 bg-hot', () => {
    const newDot = src
      .split(String.fromCharCode(10))
      .filter((l) => l.includes('rounded-full') && l.includes('h-1.5'))
      .join(' ')
    expect(newDot).toContain('bg-accent')
    expect(newDot).not.toContain('bg-hot')
  })
})

describe('首页分类胶囊：聚焦时跟随居中', () => {
  const src = readFileSync(HOME, 'utf8')

  it('聚焦环保留双环（白内线 + accent）：实心 accent 胶囊上单色环等于没有', () => {
    const tokens = readFileSync(join(__dirname, '..', 'src', 'styles', 'tokens.css'), 'utf8')
    const at = tokens.indexOf('.cat-chips .meow-tv-focus')
    expect(at).toBeGreaterThan(-1)
    const block = tokens.slice(at, at + 700)
    // 2026-11-06 回归过：只留 accent 环 → 选中胶囊（实心同色）上看不见焦点
    expect(block).toMatch(/rgba\(255, 255, 255, 0\.75\)/)
    expect(block).toMatch(/inset 0 0 0 3px var\(--color-accent\)/)
  })

  it('胶囊条监听 focusin，把聚焦项滚到中间', () => {
    expect(src).toContain('ref="chipsEl"')
    expect(src).toContain('@focusin="onChipFocus"')
    expect(src).toContain('box.scrollTo(')
    // 不能用 scrollIntoView（会连带滚竖向容器把页面拽回去）
    expect(src).not.toContain('scrollIntoView(')
  })
})

describe('投影仪（Chrome 66）遗留焦点框：只认 tv-nav 的 class', () => {
  const legacy = readFileSync(join(__dirname, '..', 'src', 'styles', 'legacy-css.css'), 'utf8')

  it('不再给所有 :focus 元素画 outline（会变成"残留的四角方框"）', () => {
    // legacy CSS 里的老写法 `*:focus { outline: 2px solid accent }` 必须消失
    // 注意匹配的是**选择器**而不是注释里那句说明
    expect(legacy).not.toMatch(/\[data-tv='1'\]\s*\*:focus/)
    // 按钮/链接/可聚焦容器的默认轮廓必须清掉（焦点环由 .meow-tv-focus 负责）
    expect(legacy).toMatch(/button:focus[\s\S]{0,400}outline: none !important/)
  })

  it('表单控件仍保留可见轮廓（打字要有反馈）', () => {
    expect(legacy).toMatch(/input:focus[\s\S]{0,200}outline: 2px solid/)
  })

  it('backdrop-filter 兜底覆盖所有用到的档位（-xl 是顶栏）', () => {
    for (const size of ['', '-sm', '-md', '-lg', '-xl', '-2xl']) {
      expect(legacy).toContain(`.backdrop-blur${size}`)
    }
  })
})

describe('焦点遗漏审计（2026-11-06 全页扫描后补的）', () => {
  const tokens = readFileSync(join(__dirname, '..', 'src', 'styles', 'tokens.css'), 'utf8')
  const settings = readFileSync(join(__dirname, '..', 'src', 'views', 'SettingsView.vue'), 'utf8')

  it('分段控件用内嵌环（贴容器边 1px，外扩环会被 overflow-hidden 裁掉）', () => {
    expect(settings).toContain('seg-group')
    const at = tokens.indexOf('.seg-group .meow-tv-focus')
    expect(at).toBeGreaterThan(-1)
    const block = tokens.slice(at, at + 500)
    expect(block).toContain('inset 0 0 0 1px var(--tv-focus-inner')
    expect(block).toContain('inset 0 0 0 2px var(--color-accent)')
    // 不能有外扩（0 0 0 Npx accent / 辉光）——那正是被裁的那层
    expect(block).not.toMatch(/^\s*0 0 0 \d+px var\(--color-accent\)/m)
  })

  it('旧的 tv-nav 副本已删除（docs/49 明确"勿用旧副本"）', () => {
    expect(() => readFileSync(join(__dirname, '..', 'public', 'tv-nav-inject.js'), 'utf8')).toThrow()
  })
})
