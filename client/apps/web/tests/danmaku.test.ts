import { describe, expect, it, beforeEach } from 'vitest'
import { DanmakuRenderer, parseDanmakuXml, type Danmu } from '../src/components/player/danmaku'

const SAMPLE = `<?xml version="1.0" ?>
<i>
  <d p="0.0,2,25,14463824,1751533608,0,0,1">顶部弹幕</d>
  <d p="1.0,1,25,16777215,1751533608,0,0,2">滚动弹幕</d>
  <d p="2.0,3,25,16711680,1751533608,0,0,3">底部弹幕</d>
</i>`

describe('parseDanmakuXml', () => {
  it('解析 B 站式 XML', () => {
    const list = parseDanmakuXml(SAMPLE)
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ time: 0, mode: 2, text: '顶部弹幕' })
    expect(list[1]).toMatchObject({ time: 1, mode: 1, text: '滚动弹幕' })
    expect(list[2].color).toBe('#ff0000')
  })

  it('按时间排序', () => {
    const list = parseDanmakuXml(SAMPLE)
    expect(list.map((d) => d.time)).toEqual([0, 1, 2])
  })

  it('空输入返回空数组', () => {
    expect(parseDanmakuXml('')).toEqual([])
    expect(parseDanmakuXml('<?xml version="1.0"?><i></i>')).toEqual([])
  })

  it('忽略缺少 p 属性的节点', () => {
    const xml = '<i><d>无属性</d><d p="1,1,25,16777215">正常</d></i>'
    expect(parseDanmakuXml(xml)).toHaveLength(1)
  })

  it('旧缓存里的字面实体（&amp;#128077;）解成真表情', () => {
    const xml = '<i><d p="1,1,25,16777215">晚上婚礼&amp;#128146;</d></i>'
    expect(parseDanmakuXml(xml)[0].text).toBe('晚上婚礼💒')
  })

  it('十六进制实体也能解，非法引用原样保留', () => {
    const xml =
      '<i><d p="1,1,25,16777215">赞&#x1F44D;不明&amp;nbsp;越界&#1114112;</d></i>'
    expect(parseDanmakuXml(xml)[0].text).toBe('赞👍不明&nbsp;越界&#1114112;')
  })
})

const mk = (time: number, text: string): Danmu => ({
  time,
  mode: 1,
  size: 25,
  color: '#ffffff',
  text,
})

describe('DanmakuRenderer', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 450, configurable: true })
    document.body.appendChild(host)
  })

  it('sync 到时间点会把弹幕放进渲染队列', () => {
    const r = new DanmakuRenderer(host)
    r.load([mk(0, 'A'), mk(0.5, 'B')])
    r.sync(1)
    expect(r.debugActive()).toHaveLength(2)
    r.destroy()
  })

  it('关闭后不再渲染', () => {
    const r = new DanmakuRenderer(host)
    r.setEnabled(false)
    r.load([mk(0, 'X')])
    r.sync(1)
    expect(r.debugActive()).toHaveLength(0)
    r.destroy()
  })

  it('回退播放位置会重建游标并重新渲染', () => {
    const r = new DanmakuRenderer(host)
    r.load([mk(0, 'A'), mk(5, 'B')])
    r.sync(6)
    r.sync(0.1)
    r.sync(0.2)
    expect(r.debugActive().length).toBeGreaterThan(0)
    r.destroy()
  })

  it('横向位置由视频时间决定（暂停即静止，倍速即同步）', () => {
    const r = new DanmakuRenderer(host, { duration: 10 })
    r.load([mk(0, 'X')])
    r.sync(0.1)

    for (let t = 0.25; t <= 2; t += 0.25) r.sync(t)
    const xEarly = r.debugActive()[0].x

    for (let t = 2.25; t <= 5; t += 0.25) r.sync(t)
    const xLate = r.debugActive()[0].x

    expect(xLate).toBeLessThan(xEarly)

    // 同一时间点重复 sync（模拟暂停），位置不再变化
    r.sync(5)
    expect(r.debugActive()[0].x).toBe(xLate)

    r.destroy()
  })

  it('跳转后只补最近几秒，不把整段历史倒出来', () => {
    const r = new DanmakuRenderer(host)
    r.load(Array.from({ length: 50 }, (_, i) => mk(i, `D${i}`)))
    r.sync(40)
    // 跳转窗口 3 秒，最多补 4 条
    expect(r.debugActive().length).toBeLessThanOrEqual(4)
    r.destroy()
  })

  it('在场数量有上限，极端弹幕不会无限堆积', () => {
    const r = new DanmakuRenderer(host)
    r.load(Array.from({ length: 500 }, () => mk(0, 'SAME')))
    r.sync(1)
    expect(r.debugActive().length).toBeLessThanOrEqual(120)
    r.destroy()
  })

  it('关闭时清空，重新开启后可继续渲染', () => {
    const r = new DanmakuRenderer(host)
    r.load([mk(0, 'X')])
    r.sync(1)
    expect(r.debugActive()).toHaveLength(1)

    r.setEnabled(false)
    expect(r.debugActive()).toHaveLength(0)

    r.setEnabled(true)
    r.load([mk(0, 'X')])
    r.sync(1)
    expect(r.debugActive()).toHaveLength(1)
    r.destroy()
  })

  it('容器尺寸变了，即使没人调 resize 也会在绘制时跟上（转屏/全屏）', () => {
    const r = new DanmakuRenderer(host)
    // 渲染器读的是自己创建的填满父级的容器，不是 host 本身
    const box = host.firstElementChild as HTMLElement
    const setBox = (w: number, h: number) => {
      Object.defineProperty(box, 'clientWidth', { value: w, configurable: true })
      Object.defineProperty(box, 'clientHeight', { value: h, configurable: true })
    }

    setBox(800, 450)
    r.resize()
    const before = r.debugCanvasSize()
    expect(before.width / before.height).toBeCloseTo(800 / 450, 1)

    // 模拟进横屏全屏：盒子变了，但 resize/fullscreenchange 事件都没来
    setBox(1600, 900)
    r.load([mk(0, 'X')])
    r.sync(1)
    r.paintNow()

    const after = r.debugCanvasSize()
    // 位图必须跟上新盒子，否则 CSS 拉满时整层被横向拉伸
    expect(after.width).toBeGreaterThan(before.width)
    expect(after.width / after.height).toBeCloseTo(1600 / 900, 1)
    r.destroy()
  })

  it('暂停状态下尺寸变化，位图也要跟上（不依赖 rAF 循环）', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    const setBox = (w: number, h: number) => {
      Object.defineProperty(box, 'clientWidth', { value: w, configurable: true })
      Object.defineProperty(box, 'clientHeight', { value: h, configurable: true })
    }

    setBox(390, 834)
    r.resize()
    const portrait = r.debugCanvasSize()
    expect(portrait.height).toBeGreaterThan(portrait.width)

    // 暂停状态（没有 start，rAF 不跑），直接转横屏
    setBox(844, 380)
    r.resize()

    const landscape = r.debugCanvasSize()
    expect(landscape.width).toBeGreaterThan(landscape.height)
    expect(landscape.width / landscape.height).toBeCloseTo(844 / 380, 1)
    r.destroy()
  })

  it('容器尺寸为 0 时不按兜底值改写位图（避免比例算错）', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()
    const before = r.debugCanvasSize()
    expect(before.width).toBeGreaterThan(0)

    Object.defineProperty(box, 'clientWidth', { value: 0, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 0, configurable: true })
    r.resize()

    expect(r.debugCanvasSize()).toEqual(before)
    r.destroy()
  })

  it('改「显示区域」要真的改变轨道数（容器尺寸没变时也不能被短路）', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()

    // 轨道数 = max(3, floor(高度 × area / 轨道高度))，按实际值算避免写死数字
    const expectLanes = (area: number) => {
      const st = r.debugState()
      return Math.max(3, Math.floor((450 * area) / st.laneHeight))
    }

    r.setOptions({ area: 0.7 })
    expect(r.debugState().laneCount).toBe(expectLanes(0.7))
    const wide = r.debugState().laneCount

    r.setOptions({ area: 0.3 })
    const narrow = r.debugState().laneCount
    expect(narrow).toBe(expectLanes(0.3))

    // 关键：区域缩小，轨道一定变少
    expect(narrow).toBeLessThan(wide)
    r.destroy()
  })

  it('四项显示设置各自都能立刻生效', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()

    // 透明度
    r.setOptions({ opacity: 0.5 })
    expect(r.debugState().opacity).toBe('0.5')

    // 字号（22 是基准）
    r.setOptions({ scale: 1.5 })
    expect(r.debugState().fontSize).toBeCloseTo(33, 0)

    // 显示区域（轨道高度随字号变，期望值按实际公式算）
    r.setOptions({ area: 1 })
    const st = r.debugState()
    expect(st.laneCount).toBe(Math.max(3, Math.floor(450 / st.laneHeight)))

    // 滚动时长：影响位置推进速度。
    //
    // 注意 born 现在取「实际上屏时间」（见 emit 注释），所以要
    // 先让弹幕上屏、再往后播一段，才能比较推进速度。
    const measure = (duration: number) => {
      const rr = new DanmakuRenderer(host)
      const box = host.firstElementChild as HTMLElement
      Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
      Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
      rr.resize()
      rr.setOptions({ duration })
      rr.load([mk(10, 'X')])
      rr.sync(10) // 上屏（born = 10）
      // 小步推进 2 秒，避免 sync 的 jumped 判定（>1.5s 视作跳转）
      for (let k = 1; k <= 20; k++) rr.sync(10 + k * 0.1)
      const active = rr.debugActive()
      const x = active.length ? active[0].x : Number.NaN
      rr.destroy()
      return x
    }
    const slowX = measure(20)
    const fastX = measure(6)
    // 时长越短，同样播 2 秒飞得越远（x 越小）
    expect(Number.isFinite(slowX) && Number.isFinite(fastX)).toBe(true)
    expect(fastX).toBeLessThan(slowX)
    r.destroy()
  })

  /** 在场弹幕里相邻轨道的 top 差；小于位图高度就会视觉重叠 */
  function minTopGap(r: DanmakuRenderer): number {
    const tops = [...new Set(((r as any).active as Array<{ top: number }>).map((a) => a.top))]
    tops.sort((a, b) => a - b)
    let gap = Infinity
    for (let i = 1; i < tops.length; i++) gap = Math.min(gap, tops[i] - tops[i - 1])
    return gap
  }

  it('字号调大后轨道高度要跟着涨，否则相邻弹幕会叠住', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()

    r.setOptions({ scale: 1.6 })
    const st = r.debugState()
    // 位图高度不能超过轨道高度，否则上下两条必然压在一起
    expect(st.spriteHeight).toBeLessThanOrEqual(st.laneHeight)
    r.destroy()
  })

  it('只改字号（laneCount 恰好不变）也要重排，避免新旧两套网格交错', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()

    r.setOptions({ scale: 1 })
    r.load(Array.from({ length: 80 }, (_, i) => mk(i * 0.08, `D${i}`)))
    r.sync(2)
    const gridA = [...new Set(((r as any).active as Array<{ top: number }>).map((a) => a.top))].sort(
      (a, b) => a - b,
    )

    // 100% → 105%：laneHeight 变了，但 laneCount 可能恰好不变
    r.setOptions({ scale: 1.05 })
    r.sync(3)
    const gridB = [...new Set(((r as any).active as Array<{ top: number }>).map((a) => a.top))].sort(
      (a, b) => a - b,
    )

    expect(gridB).not.toEqual(gridA)
    expect(minTopGap(r)).toBeGreaterThanOrEqual(r.debugState().spriteHeight)
    r.destroy()
  })

  it('缩小显示区域后不把弹幕硬塞进同一轨道', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()

    r.setOptions({ area: 1 })
    r.load(Array.from({ length: 60 }, () => mk(0, 'SAME')))
    r.sync(0.5)
    const wide = r.debugActive().length

    r.setOptions({ area: 0.3 })
    const narrow = r.debugActive().length

    // 区域变小、轨道变少，能显示的自然变少（放不下的丢弃而不是重叠）
    expect(narrow).toBeLessThan(wide)
    expect(minTopGap(r)).toBeGreaterThanOrEqual(r.debugState().spriteHeight)
    r.destroy()
  })

  it('连续拖动字号滑块不会让弹幕越积越多', () => {
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 450, configurable: true })
    r.resize()

    r.load(Array.from({ length: 80 }, (_, i) => mk(i * 0.08, `D${i}`)))
    r.sync(2)
    const base = r.debugActive().length

    for (const s of [1.05, 1.1, 1.15, 1.2, 1.15, 1.1]) r.setOptions({ scale: s })

    // 重排只会丢弃或挪动，不会凭空增加
    expect(r.debugActive().length).toBeLessThanOrEqual(base)
    expect(minTopGap(r)).toBeGreaterThanOrEqual(r.debugState().spriteHeight)
    r.destroy()
  })
})

/**
 * 重叠扫描。
 *
 * 上面那些用例只盯单一维度；真实弹幕是"滚动 + 顶部 + 底部"混排，
 * 再叠加字号/区域设置，组合爆炸。这个扫描按 paint 的算法还原每条弹幕的
 * 实际矩形，任意两条纵向重叠且横向也有交叠就判失败。
 *
 * 它抓到过三个真问题：顶部与底部各自占轨互不相让、静态弹幕重排时
 * 互相看不见、滚动弹幕压到底部弹幕上。
 */
describe('弹幕重叠扫描', () => {
  type Rect = { x: number; y: number; w: number; h: number; text: string; mode: number }

  /** 按 paint 的算法还原可见矩形，返回所有真重叠的组合 */
  function findOverlaps(r: DanmakuRenderer): string[] {
    const anyR = r as any
    const W = anyR.W as number
    const t = anyR.now as number
    const dur = anyR.scrollSeconds as number
    const spriteH = r.debugState().spriteHeight

    const rects: Rect[] = (anyR.active as any[])
      .map((a) => {
        const isStatic = a.danmu.mode === 2 || a.danmu.mode === 3
        const x = isStatic
          ? (W - a.width) / 2
          : W - Math.min(1.6, Math.max(0, (t - a.born) / dur)) * (W + a.width)
        return { x, y: a.top, w: a.width, h: spriteH, text: a.danmu.text, mode: a.danmu.mode }
      })
      // 已经飞出画面的不参与
      .filter((b) => b.x + b.w > 0 && b.x < W)

    const bad: string[] = []
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const A = rects[i]
        const B = rects[j]
        const dy = Math.abs(A.y - B.y)
        const dx = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)
        // 纵向压住 70% 以上、横向又有实质交叠 => 肉眼就是叠在一起
        if (dy < A.h * 0.7 && dx > 8) {
          bad.push(`${A.text}[m${A.mode}] × ${B.text}[m${B.mode}] dx=${Math.round(dx)} dy=${dy}`)
        }
      }
    }
    return bad
  }

  function setup(w: number, h: number) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const r = new DanmakuRenderer(host)
    const box = host.firstElementChild as HTMLElement
    Object.defineProperty(box, 'clientWidth', { value: w, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: h, configurable: true })
    r.resize()
    return r
  }

  /** 三种模式混排 + 高密度 */
  function mixedList(): Danmu[] {
    const list: Danmu[] = []
    for (let i = 0; i < 60; i++) {
      list.push({ time: i * 0.03, mode: 1, size: 25, color: '#fff', text: `滚动弹幕比较长的内容${i}` })
    }
    for (let i = 0; i < 8; i++) {
      list.push({ time: 0.5 + i * 0.1, mode: 2, size: 25, color: '#fff', text: `顶部${i}` })
      list.push({ time: 0.6 + i * 0.1, mode: 3, size: 25, color: '#fff', text: `底部${i}` })
    }
    return list.sort((a, b) => a.time - b.time)
  }

  for (const [w, h] of [
    [800, 450],
    [1400, 600],
    [640, 360],
  ]) {
    for (const scale of [0.7, 1.0, 1.3, 1.6]) {
      for (const area of [0.3, 0.7, 1.0]) {
        it(`${w}×${h} 字号${scale} 区域${area} 无重叠`, () => {
          const r = setup(w, h)
          r.setOptions({ scale, area })
          r.load(mixedList())
          for (const t of [0.5, 1.0, 1.5, 2.0]) {
            r.sync(t)
            expect(findOverlaps(r), `t=${t}`).toHaveLength(0)
          }
          r.destroy()
        })
      }
    }
  }

  it('顶部/底部各自多条时不互相重合', () => {
    const r = setup(900, 500)
    const list: Danmu[] = []
    for (let i = 0; i < 4; i++) {
      list.push({ time: 0, mode: 2, size: 25, color: '#fff', text: `顶${i}` })
      list.push({ time: 0, mode: 3, size: 25, color: '#fff', text: `底${i}` })
    }
    r.load(list)
    r.sync(0.5)
    expect(findOverlaps(r)).toHaveLength(0)
    r.destroy()
  })

  it('长弹幕会加速滚动（更快腾出轨道）', () => {
    const r = setup(1280, 720)
    r.setOptions({ duration: 12 })
    r.load([
      { time: 0, mode: 1, size: 25, color: '#fff', text: '短' },
      {
        time: 0,
        mode: 1,
        size: 25,
        color: '#fff',
        text: '这是一条非常非常长的弹幕内容用来测试加速逻辑是不是真的生效了',
      },
    ])
    r.sync(0.1)
    const act = (r as any).active as Array<{ dur: number; width: number; danmu: Danmu }>
    const short = act.find((a) => a.danmu.text === '短')!
    const long = act.find((a) => a.danmu.text !== '短')!
    expect(short.dur).toBeCloseTo(12, 1)
    expect(long.dur).toBeLessThan(short.dur)
    r.destroy()
  })

  it('窄弹幕不加速（避免满天乱飞的短词）', () => {
    const r = setup(1280, 720)
    r.setOptions({ duration: 12 })
    r.load([mk(0, '正常长度的一句话')])
    r.sync(0.1)
    const a = ((r as any).active as Array<{ dur: number }>)[0]
    expect(a.dur).toBeCloseTo(12, 1)
    r.destroy()
  })

  it('长弹幕加速后仍不与同轨前后弹幕重叠', () => {
    const r = setup(1280, 720)
    const long = '长'.repeat(60)
    const list: Danmu[] = []
    for (let i = 0; i < 30; i++) list.push(mk(i * 0.2, i % 3 === 0 ? long : `短${i}`))
    r.load(list)
    for (const t of [1, 3, 5, 8]) {
      r.sync(t)
      expect(findOverlaps(r), `t=${t}`).toHaveLength(0)
    }
    r.destroy()
  })

  it('★ 快的长弹幕不会追尾前面的慢弹幕', () => {
    // 复现真实数据里的追尾：一条 514px 的长弹幕（被加速到 9s）
    // 追上了前面 162px 的 12s 弹幕，实测重叠 dx=17。
    const r = setup(1920, 700)
    r.setOptions({ duration: 12 })
    // 先放一条窄的（12s，慢），再紧跟着放一条长的（加速后更快）
    const list: Danmu[] = [
      { time: 0, mode: 1, size: 25, color: '#fff', text: '王瑞雪看到了吗' },
      { time: 4, mode: 1, size: 25, color: '#fff', text: '我'.repeat(30) },
      { time: 8, mode: 1, size: 25, color: '#fff', text: '已'.repeat(30) },
    ]
    r.load(list)
    // 逐帧推进较长时间，任何时刻都不能重叠
    for (let t = 0.1; t <= 24; t += 0.1) {
      r.sync(t)
      expect(findOverlaps(r), `t=${t.toFixed(1)}`).toHaveLength(0)
    }
    r.destroy()
  })

  it('过载时权重高的弹幕能挤掉权重低的（而不是先到先得）', () => {
    const r = setup(900, 500)
    // 先灌一堆超长弹幕把轨道占满（长文本权重低）
    const filler: Danmu[] = []
    for (let i = 0; i < 60; i++) {
      filler.push({ time: 0, mode: 1, size: 25, color: '#fff', text: `很长很长的低价值弹幕内容啊${i}` })
    }
    r.load(filler)
    r.sync(0.1)
    const before = r.debugActive().length
    expect(before).toBeGreaterThan(0)

    // 再进来一条高权重弹幕（短 + 带表情 + 点赞数高）：
    // 直接调 private 的 pickLane 验证它不会返回 -1
    const r0 = r as any
    const weightLow = r0.weightOf({ time: 0, mode: 1, size: 25, color: '#fff', text: '很长很长的低价值弹幕内容啊0' })
    const weightHigh = r0.weightOf({ time: 0, mode: 1, size: 25, color: '#fff', text: '哈哈[狗头]♡1.2w' })
    expect(weightHigh).toBeGreaterThan(weightLow)
    r.destroy()
  })

  it('权重计算：短文本、表情、点赞都能加分', () => {
    const r = setup(900, 500)
    const w = (text: string) =>
      (r as any).weightOf({ time: 0, mode: 1, size: 25, color: '#fff', text })

    // 短 > 长
    expect(w('哈哈')).toBeGreaterThan(w('这是一段很长的弹幕内容需要占满一整行'))
    // 带表情 > 不带
    expect(w('太强了[狗头]')).toBeGreaterThan(w('太强了'))
    // 高赞 > 低赞
    expect(w('来了♡1.2w')).toBeGreaterThan(w('来了♡3'))
    // 空文本不炸
    expect(Number.isFinite(w(''))).toBe(true)
    r.destroy()
  })

  /** 真实剧集数据（庆余年第二季 ep1，42295 条）里的典型长弹幕 */
  const LONG_REAL = '这个样子不是徐凤年吗[666啊][666啊][666啊][666啊][666啊]'

  it('竖屏窄容器自动缩字号，长弹幕不再是满屏溢出', () => {
    // PC：宽度够，字号维持 22
    const pc = setup(1280, 720)
    const pcFont = pc.debugState().fontSize
    pc.destroy()

    // 手机竖屏：按比例缩小
    const phone = setup(390, 844)
    const phoneFont = phone.debugState().fontSize
    phone.destroy()

    expect(pcFont).toBeCloseTo(22, 0)
    expect(phoneFont).toBeLessThan(pcFont)
    // 不能缩到看不清
    expect(phoneFont).toBeGreaterThanOrEqual(12)
  })

  it('窄屏补偿后，真实长弹幕的宽度明显收窄', () => {
    const wide = setup(1280, 720)
    wide.load([{ time: 0, mode: 1, size: 25, color: '#fff', text: LONG_REAL }])
    wide.sync(0.1)
    const wideW = (wide as any).active[0].width
    wide.destroy()

    const narrow = setup(390, 844)
    narrow.load([{ time: 0, mode: 1, size: 25, color: '#fff', text: LONG_REAL }])
    narrow.sync(0.1)
    const narrowW = (narrow as any).active[0].width
    narrow.destroy()

    // 竖屏字号更小 → 同一条文本量出来更窄
    expect(narrowW).toBeLessThan(wideW)
  })

  it('横屏和 PC 的字号完全不受窄屏补偿影响', () => {
    for (const [w, h] of [
      [640, 360],
      [844, 390],
      [1280, 720],
      [1920, 1080],
    ]) {
      const r = setup(w, h)
      expect(r.debugState().fontSize, `${w}x${h}`).toBeCloseTo(22, 0)
      r.destroy()
    }
  })

  it('顶部弹幕贴顶、底部弹幕贴底（位置语义不能反）', () => {
    const H = 500
    const r = setup(900, H)
    const list: Danmu[] = []
    for (let i = 0; i < 3; i++) {
      list.push({ time: 0, mode: 2, size: 25, color: '#fff', text: `顶${i}` })
      list.push({ time: 0, mode: 3, size: 25, color: '#fff', text: `底${i}` })
    }
    r.load(list)
    r.sync(0.5)

    const act = (r as any).active as Array<{ top: number; danmu: Danmu }>
    const tops = act.filter((a) => a.danmu.mode === 2).map((a) => a.top)
    const bots = act.filter((a) => a.danmu.mode === 3).map((a) => a.top)

    // 第一条顶部弹幕必须靠近顶边
    expect(Math.min(...tops)).toBeLessThan(H * 0.15)
    // 第一条底部弹幕必须靠近底边（lane 0 = 贴底）
    expect(Math.max(...bots)).toBeGreaterThan(H * 0.85)
    r.destroy()
  })

  it('顶部弹幕不会被滚动弹幕挤到画面中间', () => {
    const H = 500
    const r = setup(900, H)
    // 先把每条轨道用滚动弹幕填满
    const list: Danmu[] = []
    for (let i = 0; i < 120; i++) {
      list.push({ time: i * 0.01, mode: 1, size: 25, color: '#fff', text: `滚动${i}` })
    }
    // 再插几条顶部弹幕
    for (let i = 0; i < 3; i++) {
      list.push({ time: 0.5 + i * 0.05, mode: 2, size: 25, color: '#ff0', text: `顶${i}` })
    }
    r.load(list.sort((a, b) => a.time - b.time))
    r.sync(1.0)

    const tops = ((r as any).active as Array<{ top: number; danmu: Danmu }>)
      .filter((a) => a.danmu.mode === 2)
      .map((a) => a.top)
    // 静态弹幕优先级更高：哪怕轨道全满，顶部弹幕也要待在顶部
    expect(Math.min(...tops)).toBeLessThan(H * 0.15)
    r.destroy()
  })

  it('狂拖设置 + 反复 seek 后仍无重叠', () => {
    const r = setup(900, 500)
    const list: Danmu[] = []
    for (let i = 0; i < 300; i++) {
      list.push({ time: i * 0.1, mode: 1, size: 25, color: '#fff', text: `R${i}` })
    }
    for (let i = 0; i < 30; i++) {
      list.push({ time: i * 0.5, mode: 2, size: 25, color: '#fff', text: `T${i}` })
      list.push({ time: i * 0.5 + 0.2, mode: 3, size: 25, color: '#fff', text: `B${i}` })
    }
    r.load(list.sort((a, b) => a.time - b.time))

    const steps: Array<[string, () => void]> = [
      ['seek 5', () => r.sync(5)],
      ['字号1.5', () => r.setOptions({ scale: 1.5 })],
      ['区域0.3', () => r.setOptions({ area: 0.3 })],
      ['字号1.0', () => r.setOptions({ scale: 1.0 })],
      ['区域1.0', () => r.setOptions({ area: 1.0 })],
      ['seek 1', () => r.sync(1)],
      ['seek 20', () => r.sync(20)],
      ['字号0.7', () => r.setOptions({ scale: 0.7 })],
      ['seek 10', () => r.sync(10)],
      ['区域0.5', () => r.setOptions({ area: 0.5 })],
      ['连播3s', () => { for (let k = 1; k <= 30; k++) r.sync(10 + k * 0.1) }],
    ]
    for (const [name, run] of steps) {
      run()
      expect(findOverlaps(r), name).toHaveLength(0)
    }
    r.destroy()
  })
})

describe('长弹幕速度上限', () => {
  /**
   * 用户反馈："长弹幕目前滚动速度太快看不清，做个最快上限"。
   *
   * 原实现 durFor 里 factor 的下限是 0.3（宽度越宽时长越短），
   * 于是 5 倍宽的弹幕只跑 0.3x 基准时长就横穿整屏，完全看不清。
   *
   * 判据：任意宽度下，速度（像素/秒）不超过基准弹幕速度的 1.6 倍。
   */
  function make(W: number, duration: number) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const r = new DanmakuRenderer(host, { duration }) as any
    // ★ W 是 getter（读 this.container.clientWidth），而 container 是 host 的
    //   子元素 —— 给 host 设 clientWidth 没用（实测 durFor(100) 得 8.25 而非 12）。
    //   直接钉在容器上。
    Object.defineProperty(r.container, 'clientWidth', { value: W, configurable: true })
    return { r, W }
  }

  it('弹幕越宽也不能快过基准速度的 1.6 倍', () => {
    const { r, W } = make(1280, 12)
    const refW = W * 0.2
    const baseSpeed = (W + refW) / 12
    const limit = baseSpeed * 1.6

    for (const w of [refW, 300, 600, 1000, 1600, 2560]) {
      const dur = r.durFor(w)
      const speed = (W + w) / dur
      expect(speed, `宽度 ${w} 的弹幕速度 ${speed.toFixed(0)}px/s 超过上限 ${limit.toFixed(0)}`)
        .toBeLessThanOrEqual(limit + 1)
    }
    r.destroy()
  })

  it('短弹幕仍用基准时长（上限不影响它们）', () => {
    const { r, W } = make(1280, 12)
    expect(r.durFor(100)).toBe(12)
    expect(r.durFor(W * 0.2)).toBe(12)
    r.destroy()
  })
})
