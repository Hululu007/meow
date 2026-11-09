/**
 * 弹幕解析与渲染。
 *
 * 后端 `/api/proxy/danmaku` 返回 B 站式 XML：
 *   <i><d p="时间,模式,字号,颜色,时间戳,池,用户ID,弹幕ID">内容</d></i>
 *
 * 模式：1=滚动 2=顶部 3=底部
 * 颜色：十进制 RGB（如 16777215 = #FFFFFF）
 *
 * ## 为什么用 Canvas
 *
 * 早期版本每条弹幕是一个 DOM 节点 + CSS transform。实测同时在场 180~200 条时
 * 每帧要写 200 次 style，配合 text-shadow 合成，直接卡成幻灯片。
 * Canvas 每帧只重绘一次位图，200 条文字的全量重绘在 60fps 预算内，
 * 而且没有 DOM 布局、没有合成层爆炸。
 *
 * ## 为什么完全由视频时间驱动
 *
 * 每条弹幕的横向位置按 `(now - danmu.time) / duration` 现算，不用 CSS 动画。
 * 这样暂停、倍速、拖动都会自动同步，不会出现"弹幕先飞一段"的错位。
 */

export interface Danmu {
  time: number
  mode: number
  size: number
  color: string
  text: string
}

export function parseDanmakuXml(xml: string): Danmu[] {
  if (!xml) return []
  const out: Danmu[] = []
  // 用 DOMParser 而不是正则，避免弹幕文本里含 < > 等字符
  let doc = new DOMParser().parseFromString(xml, 'text/xml')
  // 非法字符引用（越界/代理区）会让整份文档解析失败，一条弹幕都拿不到。
  // 这种引用在弹幕里没有意义，转义成普通文本后重解析一次。
  if (doc.getElementsByTagName('parsererror').length) {
    doc = new DOMParser().parseFromString(escapeInvalidCharRefs(xml), 'text/xml')
  }
  const nodes = doc.getElementsByTagName('d')
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]
    const p = el.getAttribute('p')
    const raw = (el.textContent || '').trim()
    if (!p || !raw) continue
    const parts = p.split(',')
    if (parts.length < 4) continue
    const time = parseFloat(parts[0])
    const mode = parseInt(parts[1], 10) || 1
    const size = parseInt(parts[2], 10) || 25
    const rgb = parseInt(parts[3], 10) || 0xffffff
    if (!isFinite(time)) continue
    out.push({
      time,
      mode,
      size,
      color: '#' + rgb.toString(16).padStart(6, '0'),
      // 后端的转义修好之前抓的缓存里还是 &amp;#128077;，解析出来是字面量，
      // 这里再兜一层，避免旧缓存把 &#128077; 直接画到屏幕上。
      text: decodeEntities(raw),
    })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** 把越界/代理区的字符引用转成纯文本，避免整份文档解析失败 */
function escapeInvalidCharRefs(xml: string): string {
  return xml.replace(/&#(x?[0-9a-fA-F]+);/g, (whole, body: string) => {
    const hex = body[0] === 'x' || body[0] === 'X'
    const cp = parseInt(hex ? body.slice(1) : body, hex ? 16 : 10)
    const valid =
      isFinite(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
    return valid ? whole : '&amp;#' + body + ';'
  })
}

/** 解 HTML 实体（只处理 XML 预定义与数字实体），供旧缓存兜底 */
function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return whole
      }
      try {
        return String.fromCodePoint(cp)
      } catch {
        return whole
      }
    }
    switch (body) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'amp':
        return '&'
      default:
        return whole
    }
  })
}

/** 一条正在显示的弹幕（只存在于内存，不占 DOM） */
interface Active {
  danmu: Danmu
  /** 出现时的视频时间 */
  born: number
  top: number
  width: number
  /**
   * 这条弹幕实际滚动多久（秒）。静态弹幕不用。
   *
   * 长弹幕会占用更长的轨道时间（同样 12 秒，899px 的弹幕要横扫
   * 2819px 的行程），把同轨的下一条堵得更久。所以宽弹幕按比例加速。
   * 存在每条上而不是用全局值，是因为它取决于各自的宽度。
   */
  dur: number
  /** 静止弹幕的消失时间 */
  staticUntil?: number
  /** 预渲染的文字位图（懒创建） */
  sprite?: HTMLCanvasElement | null
}

export interface DanmakuOptions {
  /** 透明度 0.2 ~ 1 */
  opacity: number
  /** 字号缩放，1 = 原始 */
  scale: number
  /** 滚动全程秒数（视频时间），越大越慢 */
  duration: number
  /** 弹幕占视频高度的比例，0.3 ~ 1 */
  area: number
}

export const DEFAULT_DANMAKU_OPTIONS: DanmakuOptions = {
  opacity: 0.9,
  scale: 1,
  duration: 12,
  area: 0.7,
}

/** 同时在场上限：超过就丢弃新弹幕，防止极端场景拖垮渲染 */
const MAX_ACTIVE = 120

/** 文字位图缓存上限（条）。硬保险，真正的约束是下面的像素预算 */
const SPRITE_CACHE_MAX = 600

/**
 * 文字位图缓存上限（像素总量）。
 *
 * <p><b>为什么不能只按条数</b>（2026-11-02 实测）：一条 435px 的长弹幕
 * 占 19,575 px 位图，中位数只有 12,510 px —— 长句是短句的 3 倍。
 * 600 条上限在最坏情况下能吃到 **44.8 MB** canvas 后备存储，
 * 而这部分**不记在 JS 堆里**（实测 JS 堆 20.7 MB、位图 20.9 MB，两笔账），
 * TV 盒子最容易在这里翻车。
 *
 * <p>6 M px ≈ 24 MB，约合 500 条中等长度弹幕。依据：
 * 实测 1.5 万条弹幕播放到第 16 分钟时缓存 457 条 / 5.49 M px，
 * 给约 10% 余量；而 {@link MAX_ACTIVE} 只有 120，
 * 缓存的实际职责是"避免同屏那 120 条每帧重画"，500 条绰绰有余。
 */
const SPRITE_PIXEL_BUDGET = 6 * 1024 * 1024

/**
 * 一个最小的 2D 上下文接口。
 *
 * jsdom 没有 canvas 实现，测试环境里会退化成空实现；
 * 生产环境永远是真实的 CanvasRenderingContext2D。
 */
interface Ctx2D {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  measureText(text: string): { width: number }
  strokeText(text: string, x: number, y: number): void
  fillText(text: string, x: number, y: number): void
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void
  font: string
  lineWidth: number
  strokeStyle: string
  fillStyle: string
  textBaseline: CanvasTextBaseline
  shadowColor: string
  shadowBlur: number
  shadowOffsetY: number
}

/** 没有 canvas 时的兜底，保证逻辑仍可测（不画东西） */
function nullCtx(): Ctx2D {
  return {
    setTransform() {},
    clearRect() {},
    measureText: (t: string) => ({ width: t.length * 14 }),
    strokeText() {},
    fillText() {},
    drawImage() {},
    font: '',
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    textBaseline: 'top',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
  }
}

export class DanmakuRenderer {
  private canvas: HTMLCanvasElement
  private ctx: Ctx2D
  private container: HTMLDivElement
  private active: Active[] = []
  private queue: Danmu[] = []
  private cursor = 0
  private raf = 0
  private enabled = true
  private laneCount = 8
  /** 上一次重排时用的轨道高度；与 laneHeight 不一致说明网格换了 */
  private lastLaneHeight = 0
  /** 上一次重排时用的字号；字号随容器宽度变化，变了要重量宽度 */
  private lastFontSize = 0
  /** 上一次重排时的容器宽度；变了要重算每条弹幕的滚动时长 */
  private lastW = 0
  private opts: DanmakuOptions = { ...DEFAULT_DANMAKU_OPTIONS }

  /** 当前视频时间，-1 表示还没同步过 */
  private now = -1
  /** 是否处于播放状态；暂停时不推进但保留画面 */
  private running = false
  private dpr = 1
  private dirty = true
  /** 上次设置过的 font，避免每帧重复赋值 */
  private lastFont = ''
  /** 文字位图缓存：同一句话+颜色只渲染一次 */
  private spriteCache = new Map<string, HTMLCanvasElement>()
  /**
   * 缓存里所有位图的像素总量（增量维护）。
   *
   * 每次都要遍历算一遍的话，代价随缓存条数线性增长；
   * 而这里只在写入/淘汰/清空三个点变动，增量维护是 O(1)。
   */
  private spritePx = 0
  /** 专门用于 measureText 的离屏上下文 */
  private offCtx: CanvasRenderingContext2D | null = null
  /** 盯容器尺寸变化；暂停时也能跟上（不依赖 rAF） */
  private ro: ResizeObserver | null = null
  /** window 级兜底监听句柄，卸载时要摘掉 */
  private onWinResize: (() => void) | null = null
  /** 最后一次权威视频时间（来自 timeupdate），rAF 据此插值 */
  private anchorTime = -1
  /**
   * 上一次 sync 收到的**视频真实时间**（不受 rAF 插值影响）。
   *
   * <p>跳转判据只能跟它比：`now` 会被插值推到画面之前最多 0.4s，
   * 拿它当基准会把"缓冲恢复"误判成"用户拖回去了"（详见 sync 的注释）。
   */
  private lastSync = -1
  /** 记录 anchorTime 时的 performance.now() */
  private anchorClock = 0
  /** 当前播放倍速，插值要用 */
  private rate = 1

  constructor(parent: HTMLElement, opts?: Partial<DanmakuOptions>) {
    this.container = document.createElement('div')
    // ★ 必须写 top/right/bottom/left 四条长属性，不能写 `inset:0`。
    //   这是 JS 内联样式，CSS 降级层（legacy-css.css）覆盖不到它。
    //   实测投影仪 Chrome 66 用 `inset:0` 时：该 div 完全没有定位偏移，
    //   被排到 video 下方的静态流里（y=720，视口高只有 720）→ 弹幕照常
    //   绘制（canvas 内 1% 像素非空、引擎队列 2433 条）但**整层在屏幕外**，
    //   用户看到的就是"弹幕开关开着却一条都没有"。
    this.container.style.cssText = [
      'position:absolute',
      'top:0',
      'right:0',
      'bottom:0',
      'left:0',
      'overflow:hidden',
      'pointer-events:none',
      'z-index:20',
    ].join(';')

    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'display:block;width:100%;height:100%'
    this.container.appendChild(this.canvas)
    parent.appendChild(this.container)

    // jsdom（单元测试）没有 canvas 实现，退化成空渲染，逻辑仍可验证
    const real = this.canvas.getContext('2d') as CanvasRenderingContext2D | null
    this.ctx = (real as unknown as Ctx2D) || nullCtx()

    // 自己盯尺寸，三层兜底（任一可用就够）：
    //  1. ResizeObserver 盯容器（最准，不依赖 window）
    //  2. window resize（老浏览器/某些 WebView 只有这个）
    //  3. paint() 里的 syncSize() 每帧自检（播放中总能自愈）
    //
    // 为什么必须做：paint() 只在 rAF 循环跑起来时执行，而 rAF 只在 playing
    // 时启动 —— **暂停状态下转屏/进全屏，位图会一直保持旧尺寸，被 CSS 拉满
    // 后整层横向拉伸**。这正是"全屏后弹幕变扁、切一下进度条又好了"的真因：
    // seek 让渲染器补画了一帧。
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize())
      this.ro.observe(this.container)
    }
    if (typeof window !== 'undefined') {
      this.onWinResize = () => this.resize()
      window.addEventListener('resize', this.onWinResize)
      window.addEventListener('orientationchange', this.onWinResize)
    }

    if (opts) this.setOptions(opts)
    this.resize()
  }

  // ------------------------------------------------------------ 配置

  setOptions(opts: Partial<DanmakuOptions>) {
    this.opts = { ...this.opts, ...opts }
    this.container.style.opacity = String(Math.min(1, Math.max(0.2, this.opts.opacity)))
    // 字号变化导致的宽度重量统一由 syncSize() 处理（它同时覆盖
    // 「改字号」和「容器变宽导致字号变」两种情况，避免两处逻辑不一致）
    this.resize()
    this.dirty = true
    this.paint()
  }

  /**
   * 实际字号 = 用户设置 × 窄屏补偿。
   *
   * 竖屏（或很窄的窗口）下，一条弹幕的宽度很容易超过屏幕：
   * 实测《庆余年第二季》第一集 42295 条真实弹幕，
   * 在 390px 宽的手机竖屏里有 **22.6% 会溢出**（最长的一条要 545px，
   * 屏幕放不下，两端被裁掉只剩中间几个字）。
   * 而同样数据在 844px 横屏只有 0.3%，PC 上一条都没有。
   *
   * 所以只在容器较窄时按比例缩小，横屏/PC 完全不受影响
   * （那里的宽度本来就够，缩了反而显得字小）。
   *
   * 下限 12px 是为了保住可读性；宁可仍有个别超长弹幕溢出，
   * 也不要把字缩成看不清。
   */
  private get fontSize(): number {
    const base = 22 * this.opts.scale
    const W = this.W
    // 窄屏补偿：以 640px 为界（约等于 Tailwind 的 sm 断点），
    // 越窄缩得越多，但不低于 0.62 倍，避免手机上字太小
    const narrow = W >= 640 ? 1 : Math.max(0.62, W / 640)
    return Math.max(12, Math.min(40, base * narrow))
  }

  /**
   * 轨道高度：必须跟着字号走。
   *
   * 早先固定 30px，字号调到 160% 时字号 35.2px、位图高 44px，
   * 比轨道高出一截 —— 相邻两条弹幕就叠上了（实测重叠 14px）。
   * 这里按「字号 + 上下 padding + 一点呼吸空间」算，字号 100% 时
   * 仍是 36px 左右（约等于原来的观感），小字号也不会挤在一起。
   */
  private get laneHeight(): number {
    return Math.ceil(this.fontSize) + this.spritePadY * 2 + 2
  }

  /** 文字位图上下各留多少边距（给阴影和描边） */
  private readonly spritePadY = 4
  /** 文字位图左右各留多少边距 */
  private readonly spritePadX = 4

  /** 轨道顶部的固定偏移，给阴影留出空间 */
  private get laneTopOffset(): number {
    return this.spritePadY
  }

  private get scrollSeconds(): number {
    return Math.max(4, this.opts.duration)
  }

  /**
   * 一条宽度为 width 的弹幕应该滚多久。
   *
   * ### 问题
   * 轨道被占用的时长 ≈ (上一条宽度 + 新弹幕宽度 + 间隙) / 速度，
   * 而速度 = (W + 宽度) / 时长。宽度越大，堵住同轨的时间越长。
   *
   * ### 做法
   * 超过参考宽度（屏幕宽的 20%）的弹幕按 `参考/实际` 比例缩短时长，
   * 让它滑得更快、更快腾出轨道。下限 30%，再快眼睛跟不上。
   *
   * 注意**不能**做成"线速度一致"：那样长弹幕要横跨更远距离
   * （W + 宽度），反而需要更长时间，问题更严重。这里要的是
   * "长弹幕更快、更快走完"。
   *
   * ### 实测收益（《庆余年》第二季 ep1，PC 1920，密集 30 秒）
   *   不加速 9.0 条/秒 → 加速后 9.2 条/秒（+2%）
   * 提升有限，因为真实数据里长弹幕只占少数：宽度中位 162px、
   * p90 459px，而屏幕 1920px —— 绝大多数弹幕本来就远窄于参考宽度。
   * 真正决定吞吐的是「每轨多久能放下一条」，这是对所有弹幕一致的
   * 约束，不是长弹幕专属的。所以这个优化**保留但不夸大**：
   * 它主要让长弹幕不至于霸屏太久，吞吐提升是次要收益。
   *
   * 想要真正的吞吐提升，唯一有效的杠杆是缩短滚动时长
   * （实测 12s→9s 提升 17%，→5s 提升 57%），那应该做成用户可选项。
   */
  private durFor(width: number): number {
    const base = this.scrollSeconds
    const W = this.W
    const refW = W * 0.2
    // 短弹幕（不超过基准宽度）一律用基准时长，不做任何加速。
    if (width <= refW) return base
    const factor = Math.max(0.3, refW / width)
    const byFactor = Math.max(2, base * factor)
    // ★ 速度上限：长弹幕不能被"加速"到看不清。
    //
    //   上面的 factor 是"宽度越长、时长越短"，本意是别让长弹幕霸屏太久；
    //   但 0.3 的下限意味着一条 5 倍宽的弹幕只用 0.3×时长跑完全程——
    //   12s 基准下就是 3.6s 横穿整屏，实测完全看不清（用户反馈）。
    //
    //   换算成"每秒最多移动多少像素"来封顶：以基准时长跑一条 refW 宽的
    //   弹幕，速度 = (W + refW) / base，乘 1.6 作为宽容上限。
    //   ★ 只对"被 factor 压缩过的"（byFactor < base）生效：
    //     否则 width 略大于 refW 时算出的 minDur 会小于 base，
    //     Math.max 取 minDur 反而把短弹幕也加速了（实测 100px 得到 8.25s）。
    if (byFactor >= base) return byFactor
    const vBase = (W + refW) / base
    const maxSpeed = vBase * 1.6
    const minDur = (W + width) / maxSpeed
    return Math.max(2, byFactor, minDur)
  }

  /** 容器尺寸变化时重设画布像素尺寸（含 DPR 适配，保证文字清晰） */
  resize() {
    if (this.syncSize()) this.paint()
  }
  /**
   * 让位图尺寸跟上容器，返回是否真的变了。
   *
   * 只靠 `resize` 事件是不够的：手机上转横屏、进全屏、地址栏收起时，
   * 事件派发和布局回流谁先谁后并不确定。实测进全屏后位图还是竖屏尺寸、
   * CSS 盒子已经是横屏，整层被横向拉伸（字变扁宽），直到某次迟到的
   * resize 才恢复。这里比较像素尺寸本身，事件漏了下一帧也能自愈。
   */
  private syncSize(): boolean {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    // 尺寸为 0 说明还在布局过渡中（或容器被隐藏），按兜底值分配会得到错误比例
    if (w <= 0 || h <= 0) return false

    // 轨道数只跟「高度 + area」有关，跟画布像素尺寸无关。
    // 必须放在下面的提前返回之前：改「显示区域」时容器尺寸没变，
    // 若跟着一起被 return 掉，滑块就完全失效了（实测踩过）。
    let changed = false
    const area = Math.min(1, Math.max(0.3, this.opts.area))
    const lanes = Math.max(3, Math.floor((h * area) / this.laneHeight))
    // 轨道"高度"变了也必须重排：每条的 top 是按 laneHeight 算出来的，
    // 只改字号（比如 100%→105%）时 laneCount 可能恰好不变，
    // 老弹幕留在旧网格、新弹幕按新网格进场，两套网格交错重叠
    // （实测最小间距只剩 2px，正好糊在一起）。—— 用户反馈的就是这个现象。
    const gridChanged = this.laneHeight !== this.lastLaneHeight
    // 字号会随容器宽度变化（窄屏补偿），所以宽度一变也要重算在场弹幕的
    // 宽度和位图，否则会按旧字号量出的宽度去缩放新位图 —— 文字被拉扁。
    const fontChanged = this.fontSize !== this.lastFontSize
    // 容器宽度变了，滚动时长基准也跟着变（durFor 依赖 W）。
    // 不更新已在场弹幕的 dur，它们会继续按旧速度跑，和重新计算的位置对不上。
    const widthChanged = this.lastW !== w
    if (fontChanged) {
      this.lastFontSize = this.fontSize
      for (const a of this.active) {
        a.width = this.textWidth(a.danmu.text)
        a.sprite = null
      }
    }
    if (widthChanged) {
      this.lastW = w
      for (const a of this.active) {
        if (a.danmu.mode === 2 || a.danmu.mode === 3) continue
        a.dur = this.durFor(a.width)
      }
    }
    if (lanes !== this.laneCount || gridChanged || fontChanged || widthChanged) {
      this.laneCount = lanes
      this.lastLaneHeight = this.laneHeight
      this.reassignLanes()
      changed = true
    }

    // DPR 上限 1.5：这块画布每帧要全量重绘文字，
    // DPR=2 时像素量是 1 倍屏的 4 倍，实测会掉到 45fps 以下。
    const dpr = Math.min(1.5, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
    const bw = Math.round(w * dpr)
    const bh = Math.round(h * dpr)
    if (this.canvas.width !== bw || this.canvas.height !== bh || this.dpr !== dpr) {
      // 位图是按旧 dpr 渲染的，绘制时按 sprite.height / dpr 还原逻辑高度，
      // dpr 一变就会算错高度（字被压扁或拉长），必须整体失效。
      if (this.dpr !== dpr) {
        this.spriteCache.clear()
        this.spritePx = 0
        for (const a of this.active) a.sprite = null
      }
      this.dpr = dpr
      this.canvas.width = bw
      this.canvas.height = bh
      changed = true
    }

    if (changed) this.dirty = true
    return changed
  }

  /**
   * 轨道数变化后重排在场的滚动弹幕。
   *
   * 早先只是把旧的 top 夹进 [0, maxLane]。缩小显示区域时，被裁掉那些轨道
   * 上的弹幕会全部压到最后一条轨道上（实测 36 条叠在同一点，糊成一片）。
   *
   * 改成按占用情况真正重新分配：从原轨道开始向两侧找最近的空轨道，
   * 都放不下就丢弃 —— 与 B 站行为一致（显示区域变小，超出的弹幕不上屏），
   * 而不是硬塞到一起。
   */
  private reassignLanes() {
    const t = this.now
    const W = this.W
    // 每条轨道上已经摆好的滚动弹幕
    const lanes: Active[][] = Array.from({ length: this.laneCount }, () => [])
    const kept: Active[] = []
    const statics: Active[] = []

    /** 弹幕当前左边缘（与 paint 里的算法保持一致，用各自的滚动时长） */
    const leftOf = (a: Active) => {
      const p = Math.min(1.6, Math.max(0, (t - a.born) / a.dur))
      return W - p * (W + a.width)
    }

    // 静态弹幕先占位：它们居中显示，纵向撞上就一定压字。
    // 静态弹幕逐条重新占位。findStaticLane 内部查 this.active，
    // 所以每处理完一条就要放回去——否则同类之间互相看不见，
    // 每条都以为第 0 行是空的（实测顶部×顶部、底部×底部全部重叠）。
    const pending = this.active
    this.active = pending.filter((a) => a.danmu.mode !== 2 && a.danmu.mode !== 3)
    for (const a of pending) {
      if (a.danmu.mode !== 2 && a.danmu.mode !== 3) continue
      const isTop = a.danmu.mode === 2
      const lane = this.findStaticLane(isTop)
      if (lane < 0) continue // 放不下就丢弃，绝不叠在别人身上
      a.top = this.staticTopOf(isTop, lane)
      statics.push(a)
      this.active.push(a) // 立刻可见，给下一条让位
    }

    for (const a of this.active) {
      if (a.danmu.mode === 2 || a.danmu.mode === 3) continue

      const want = Math.round((a.top - this.laneTopOffset) / this.laneHeight)
      const x = leftOf(a)

      // 从原轨道开始向两侧扩散，找最近的不冲突轨道
      let placed = -1
      for (let d = 0; d < this.laneCount && placed < 0; d++) {
        const candidates = d === 0 ? [want] : [want - d, want + d]
        for (const lane of candidates) {
          if (lane < 0 || lane >= this.laneCount) continue
          // 这一行纵向已被占（静态弹幕，或别的滚动弹幕）就跳过
          const top = lane * this.laneHeight + this.laneTopOffset
          if (this.staticOccupies(top, a)) continue
          const hit = lanes[lane].some((b) => {
            const bx = leftOf(b)
            // 留 8px 间隙，避免文字贴在一起
            return x < bx + b.width + 8 && bx < x + a.width + 8
          })
          if (!hit) {
            placed = lane
            break
          }
        }
      }
      // 实在放不下：这条弹幕不上屏（等它自然飞出即可，不再塞进别人的轨道）
      if (placed < 0) continue

      a.top = placed * this.laneHeight + this.laneTopOffset
      lanes[placed].push(a)
      kept.push(a)
    }

    this.active = [...kept, ...statics]
  }

  /**
   * 给一条静态弹幕找一条空闲轨道。
   *
   * ### 优先级：静态弹幕 > 滚动弹幕
   * 顶部弹幕就该在顶部、底部就该在底部，这是它的语义。所以这里
   * **只避让别的静态弹幕**，不躲滚动弹幕——否则密集时顶部弹幕会被
   * 挤到画面中间（实测截图里"顶部定0"出现在 y=220 的位置，完全不对）。
   *
   * 静态弹幕占位后，同行的滚动弹幕由 evictScrollingAt 清掉，
   * 保证两者不会真的叠在一起。
   *
   * 顶部从上往下找、底部从下往上找，但共用同一份占用判断——
   * 顶和底都是居中显示，纵向撞上就必然压字。
   *
   * 返回 -1 表示排不下了（调用方丢弃这条，不叠上去）。
   */
  private findStaticLane(isTop: boolean): number {
    for (let lane = 0; lane < this.laneCount; lane++) {
      const top = this.staticTopOf(isTop, lane)
      if (!this.staticOccupies(top, undefined, true)) return lane
    }
    return -1
  }

  /**
   * 静态弹幕的 top。
   *
   * lane 从 0 开始，**0 永远是最靠近自己那一侧的行**：
   * 顶部的 lane 0 贴着画面顶边，底部的 lane 0 贴着画面底边。
   *
   * 早先底部写成 `bottom - lane * laneHeight` 又让 findStaticLane 从
   * `laneCount-1` 开始找，两个方向叠加后底部弹幕跑到了画面中间
   * （实测 H=550 时底部弹幕出现在 y=186，应该接近 506）。
   */
  private staticTopOf(isTop: boolean, lane: number): number {
    if (isTop) return lane * this.laneHeight + this.laneTopOffset
    const bottom = this.H - 14 - Math.ceil(this.fontSize)
    return bottom - lane * this.laneHeight
  }

  /**
   * 给定一个 top，是否已有弹幕占据了这个纵向区间。
   *
   * 按纵向区间比，不按轨道号：底部弹幕是从下往上排的，
   * 轨道号方向和顶部/滚动相反，按号比会漏判导致压字。
   *
   * @param staticOnly 只算静态弹幕（给静态弹幕自己找位置时用）
   */
  private staticOccupies(top: number, ignore?: Active, staticOnly = false): boolean {
    const h = Math.ceil(this.fontSize) + this.spritePadY * 2
    return this.active.some((a) => {
      if (a === ignore) return false
      if (staticOnly && a.danmu.mode !== 2 && a.danmu.mode !== 3) return false
      return top < a.top + h && a.top < top + h
    })
  }

  /**
   * 清掉某一行上的滚动弹幕。
   *
   * 静态弹幕（顶/底）优先级更高：它们位置固定、只停 4 秒，
   * 而滚动弹幕数量多、等下一批就有。腾位置比让静态弹幕满屏乱跑合理。
   */
  private evictScrollingAt(top: number) {
    const h = Math.ceil(this.fontSize) + this.spritePadY * 2
    this.active = this.active.filter((a) => {
      if (a.danmu.mode === 2 || a.danmu.mode === 3) return true
      return !(top < a.top + h && a.top < top + h)
    })
  }

  setEnabled(v: boolean) {
    this.enabled = v
    this.container.style.display = v ? 'block' : 'none'
    if (!v) {
      this.active = []
      this.dirty = true
      this.clearCanvas()
    }
  }

  // ------------------------------------------------------------ 数据

  load(list: Danmu[]) {
    this.active = []
    this.queue = list
    this.cursor = 0
    this.now = -1
    this.lastSync = -1
    this.anchorTime = -1
    this.anchorClock = performance.now()
    this.lastFont = ''
    this.dirty = true
    this.clearCanvas()
  }

  clear() {
    this.active = []
    this.queue = []
    this.cursor = 0
    this.lastSync = -1
    this.anchorTime = -1
    this.clearCanvas()
  }

  /** 测试与排障用：位图实际像素尺寸 */
  debugCanvasSize(): { width: number; height: number; dpr: number } {
    return { width: this.canvas.width, height: this.canvas.height, dpr: this.dpr }
  }

  /** 测试与排障用：当前生效的选项与派生状态 */
  debugState(): {
    laneCount: number
    laneHeight: number
    fontSize: number
    spriteHeight: number
    opacity: string
    area: number
    /** 文字位图缓存条数 / 像素总量 —— 排查 TV 内存占用时看这两个数 */
    spriteCacheSize: number
    spriteCachePx: number
    spriteCacheBudgetPx: number
  } {
    return {
      laneCount: this.laneCount,
      laneHeight: this.laneHeight,
      fontSize: this.fontSize,
      spriteHeight: Math.ceil(this.fontSize) + this.spritePadY * 2,
      opacity: this.container.style.opacity,
      area: this.opts.area,
      spriteCacheSize: this.spriteCache.size,
      spriteCachePx: this.spritePx,
      spriteCacheBudgetPx: SPRITE_PIXEL_BUDGET,
    }
  }

  /** 测试与排障用：立刻画一帧（生产走 rAF） */
  paintNow() {
    this.paint()
  }

  /** 测试与排障用：当前在场弹幕 */
  debugActive(): Array<{ text: string; x: number; top: number }> {
    const W = this.W
    const t = this.now
    return this.active.map((a) => ({
      text: a.danmu.text,
      x:
        a.danmu.mode === 2 || a.danmu.mode === 3
          ? (W - a.width) / 2
          : W - Math.min(1.6, Math.max(0, (t - a.born) / a.dur)) * (W + a.width),
      top: a.top,
    }))
  }

  /** 测试与排障用：队列里还没上屏的弹幕（含时间点） */
  debugQueue(): Array<{ text: string; time: number }> {
    return this.queue.slice(this.cursor, this.cursor + 50).map((d) => ({
      text: d.text,
      time: d.time,
    }))
  }

  // ------------------------------------------------------------ 播放控制

  start() {
    this.running = true
    this.anchorClock = performance.now()
    if (!this.raf) this.raf = requestAnimationFrame(this.tick)
  }

  pause() {
    this.running = false
  }

  /**
   * 由播放器在 timeupdate / seeked / ratechange 时调用。
   *
   * 位置全部按 time 现算，所以暂停、倍速、拖动天然同步。
   *
   * @param opts.seek 播放器**明确知道**这是一次 seek（seeking/seeked 事件）。
   *                  传 true 会强制清屏重建；不传则只按时间差猜。
   */
  sync(time: number, opts?: { seek?: boolean }) {
    if (!Number.isFinite(time)) return
    /*
     * ★ 判据跟「上一次视频真实时间」比，不能跟插值后的 now 比。
     *
     * tick() 会用墙钟把 now 往前推最多 0.4s。缓冲时画面时间冻结、插值继续走，
     * 恢复后第一个 sync 的 time 比 now 小最多 0.4 —— 旧阈值是 -0.3，于是
     * **每次缓冲停顿都被判成"用户拖回去了"**：清空在屏弹幕，再把最近 3 秒
     * 一次性从右边缘补发。用户看到的就是"满屏弹幕消失，然后从右边重打"。
     *
     * 阈值 0.75 > 插值上限 0.4：缓冲恢复（最多 -0.4）永远不会误判；
     * 真实的拖动通常都是秒级，仍会走清屏分支。
     */
    const prev = this.lastSync
    const jumped = opts?.seek === true || prev < 0 || time < prev - 0.75 || time > prev + 1.5
    this.lastSync = time
    this.now = time
    // 记下这次权威时间，rAF 在两次 timeupdate 之间做插值
    this.anchorTime = time
    this.anchorClock = performance.now()

    if (jumped) {
      this.active = []
      // 只补「跳转前 3 秒内」的弹幕，避免整屏空白或把历史全倒出来
      this.cursor = lowerBound(this.queue, time - 3)
    }
    while (this.cursor < this.queue.length && this.queue[this.cursor].time <= time) {
      this.emit(this.queue[this.cursor])
      this.cursor++
    }
    this.prune()
    this.paint()
  }

  // ------------------------------------------------------------ 渲染循环

  /**
   * 每帧推进。
   *
   * video 的 timeupdate 只有 4Hz，直接按它绘制会让弹幕一顿一顿地跳。
   * 这里用「最后一次权威时间 + 真实流逝时间 × 倍速」插值，
   * 每收到一次 timeupdate 就重新锚定，既有 60fps 的顺滑又不会累积漂移。
   */
  private tick = () => {
    this.raf = requestAnimationFrame(this.tick)
    if (!this.running) return

    if (this.anchorTime >= 0) {
      const elapsed = ((performance.now() - this.anchorClock) / 1000) * this.rate
      // 插值最多超前 0.4s，超过就等下一次 timeupdate，避免和画面脱节
      const guess = this.anchorTime + Math.min(elapsed, 0.4)
      if (guess > this.now) this.now = guess
    }
    this.prune()
    this.paint()
  }

  /** 播放器把当前倍速告诉渲染器，插值才能和画面同速 */
  setRate(r: number) {
    this.rate = Number.isFinite(r) && r > 0 ? r : 1
    // 倍速切换时重新锚定，避免用旧倍速算出的时间继续外推
    this.anchorClock = performance.now()
    this.anchorTime = this.now
  }

  private get W(): number {
    return this.container.clientWidth || 800
  }

  private get H(): number {
    return this.container.clientHeight || 450
  }

  private clearCanvas() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  /** 全量重绘一帧 */
  private paint() {
    if (!this.enabled) return
    // 尺寸自检放在绘制前：手机上转屏/进全屏靠事件不可靠，
    // 这里每帧比一次像素尺寸，位图永远跟得上 CSS 盒子。
    this.syncSize()
    const ctx = this.ctx
    const W = this.W
    const H = this.H
    const dpr = this.dpr

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const t = this.now
    for (let i = 0; i < this.active.length; i++) {
      const a = this.active[i]
      const isStatic = a.danmu.mode === 2 || a.danmu.mode === 3
      let x: number
      if (isStatic) {
        x = (W - a.width) / 2
      } else {
        const p = Math.min(1.6, Math.max(0, (t - a.born) / a.dur))
        x = W - p * (W + a.width)
      }
      if (x > W || x + a.width < 0) continue

      // 位图缓存：每条文字只渲染一次，之后每帧只做 drawImage。
      // fillText + shadowBlur 是 Canvas 2D 里最贵的操作之一，
      // 在场 100+ 条时开销是 drawImage 的数倍。
      const sprite = a.sprite || this.makeSprite(a.danmu.text, a.danmu.color)
      a.sprite = sprite
      if (sprite) {
        ctx.drawImage(sprite, x, a.top, a.width, sprite.height / dpr)
      }
    }
  }

  /** 离屏测量上下文（只用于 measureText，不参与显示） */
  private measureCtx(): CanvasRenderingContext2D | null {
    if (this.offCtx) return this.offCtx
    if (typeof document === 'undefined') return null
    const cv = document.createElement('canvas')
    cv.width = 1
    cv.height = 1
    this.offCtx = cv.getContext('2d')
    return this.offCtx
  }

  /**
   * 把一条弹幕渲染成位图。
   *
   * 结果是按 dpr 放大的（因为主画布也是 dpr 缩放），
   * 绘制时再按逻辑尺寸缩放回去，所以文字仍然清晰。
   */
  private makeSprite(text: string, color: string): HTMLCanvasElement | null {
    const cacheKey = `${this.fontSize}|${color}|${text}`
    const hit = this.spriteCache.get(cacheKey)
    if (hit) {
      // LRU：命中后移到队尾
      this.spriteCache.delete(cacheKey)
      this.spriteCache.set(cacheKey, hit)
      return hit
    }

    const c = this.measureCtx()
    if (!c) return null
    const font = `600 ${this.fontSize}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`
    c.font = font
    const textW = Math.ceil(c.measureText(text).width)
    // 边距与 laneHeight 共用同一组常量：位图高度必须 ≤ 轨道高度，
    // 否则相邻轨道的弹幕会互相压住（字号调大时尤其明显）
    const padX = this.spritePadX
    const padY = this.spritePadY
    const w = textW + padX * 2
    const h = Math.ceil(this.fontSize) + padY * 2

    const cv = document.createElement('canvas')
    cv.width = Math.ceil(w * this.dpr)
    cv.height = Math.ceil(h * this.dpr)
    const g = cv.getContext('2d')
    if (!g) return null

    g.scale(this.dpr, this.dpr)
    g.font = font
    g.textBaseline = 'top'
    // 阴影只在离屏渲染时付一次代价
    g.shadowColor = 'rgba(0,0,0,0.9)'
    g.shadowBlur = 3
    g.shadowOffsetY = 1
    g.fillStyle = color
    g.fillText(text, padX, padY)

    /*
     * 淘汰：条数 + 像素双预算，**丢到刚好回到预算内**。
     *
     * 旧实现是"超过 600 条就丢一半"，两个问题：
     *   1. 只管条数，一条 435px 长弹幕的位图是短弹幕的 3 倍，最坏 45MB；
     *   2. 一次丢 300 条会在达标后制造一批集中重建（长句多的集数表现为
     *      周期性掉帧），而按需丢几十条几乎无感。
     *
     * 循环边界：Map 迭代顺序就是插入顺序（命中会移到队尾），
     * 所以 keys() 的第一个就是最久没用的那条，天然 LRU。
     * `size > 0` 是防御——单条超预算时不能把缓存清空再无限循环。
     */
    let guard = 0
    while (
      this.spriteCache.size > 0 &&
      (this.spriteCache.size >= SPRITE_CACHE_MAX ||
        this.spritePx + cv.width * cv.height > SPRITE_PIXEL_BUDGET) &&
      guard++ < SPRITE_CACHE_MAX
    ) {
      const oldest = this.spriteCache.keys().next()
      if (oldest.done) break
      const victim = this.spriteCache.get(oldest.value)
      this.spriteCache.delete(oldest.value)
      if (victim) this.spritePx -= victim.width * victim.height
    }
    this.spriteCache.set(cacheKey, cv)
    this.spritePx += cv.width * cv.height
    return cv
  }

  /** 移除已经飞出去的 */
  private prune() {
    const W = this.W
    const t = this.now
    const keep: Active[] = []
    for (const a of this.active) {
      if (a.danmu.mode === 2 || a.danmu.mode === 3) {
        if (a.staticUntil !== undefined && t > a.staticUntil) continue
        keep.push(a)
        continue
      }
      const p = (t - a.born) / a.dur
      // 完全飞出左侧（多留 40px 余量）后丢弃
      if (p > 1 + (a.width + 40) / (W + a.width)) continue
      keep.push(a)
    }
    this.active = keep
  }

  private emit(d: Danmu) {
    if (!this.enabled) return
    if (this.active.length >= MAX_ACTIVE) return

    const width = this.textWidth(d.text)
    const now = this.now

    if (d.mode === 2 || d.mode === 3) {
      // 顶部/底部弹幕横向居中，只要纵向区间重叠就一定压字。
      // **两者必须共享同一套轨道占用**：早先各自维护一份 used，
      // 顶部占第 0 行、底部也占第 0 行，直接叠在一起（实测全量扫描
      // 24 组配置里 24 组都撞）。
      const lane = this.findStaticLane(d.mode === 2)
      if (lane < 0) return // 排满了，这条不上屏
      const top = this.staticTopOf(d.mode === 2, lane)
      // 静态弹幕优先：这一行上的滚动弹幕让位（它们等下一批就有，
      // 而静态弹幕只停 4 秒，位置固定才有意义）
      this.evictScrollingAt(top)
      this.active.push({
        danmu: d,
        born: now,
        top,
        width,
        dur: this.scrollSeconds,
        staticUntil: now + 4,
      })
      return
    }

    const lane = this.pickLane(width, d)
    // -1 = 所有轨道都占着，这条直接丢弃，不叠到别人身上
    if (lane < 0) return
    const top = lane * this.laneHeight + this.laneTopOffset
    // ★ born 用「此刻」而不是 d.time。
    //
    // d.time 是弹幕在视频里的原始时间。正常播放时两者几乎相等，
    // 所以以前看不出问题。但 seek 会一口气补发好几秒的弹幕：
    // 那些 born 都在过去、且只差 0.1 秒，算出来的横坐标也就只差
    // 几个像素 —— 它们会被画在同一位置叠成一坨
    // （实测 seek 20 秒后同一轨道堆了 17 条，出生时间 17.0~18.6）。
    //
    // 用 now 之后，补发的弹幕统一从右边缘排进来，pickLane 的区间判定
    // 才有意义（新弹幕的起始位置恒为 x=W）。
    this.active.push({ danmu: d, born: now, top, width, dur: this.durFor(width) })
  }

  /**
   * 弹幕的逻辑宽度。
   *
   * 必须把 sprite 的左右 padding 算进去：paint 里是按 `a.width` 缩放绘制的，
   * 宽度和位图实际宽度不一致时文字会被横向拉伸。
   */
  private textWidth(text: string): number {
    const c = this.measureCtx()
    if (!c) return Math.max(24, text.length * this.fontSize * 0.6)
    c.font = `600 ${this.fontSize}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`
    return Math.max(24, Math.ceil(c.measureText(text).width) + 8)
  }

  /**
   * 弹幕权重：过载时决定留谁。
   *
   * 参考 B 站/腾讯的做法——不是先到先得，而是保住"更值得看"的那条。
   * 这里用几个便宜且稳定的信号：
   *   · 长度：越短越优先（一句"哈哈"比 50 字长评更符合弹幕的爽感），
   *     但**用渐变而不是硬分档**——硬分档会让"3 字"和"6 字+表情"
   *     拉不开差距（实测 6 字带表情反而输给 3 字纯文本）
   *   · 带 [表情] 的优先（用户主动挑的表情，信息密度高）
   *   · 带点赞数（♡N / N.Nw / 🔥N）的按热度加权
   * 数字越大越优先，只需相对可比。
   */
  private weightOf(d: Danmu): number {
    let w = 100
    // 长度：0~40 字的区间线性衰减，超出 40 字不再额外惩罚
    const len = d.text.length
    w += Math.max(0, 40 - Math.min(40, len)) * 0.9
    // 带表情（[xxx]）加分，最多 24（比长度差更重要）
    const emoji = (d.text.match(/\[[^\]]{1,8}\]/g) || []).length
    w += Math.min(24, emoji * 12)
    // 点赞数：♡123 / ♡1.2w / 🔥1.6w
    const like = d.text.match(/[♡❤🔥]\s*([\d.]+)\s*([wW万])?/)
    if (like) {
      const n = parseFloat(like[1]) * (like[2] ? 10000 : 1)
      if (isFinite(n)) w += Math.min(30, Math.log10(Math.max(1, n)) * 10)
    }
    return w
  }

  /**
   * 找一条可以放的轨道。
   *
   * 全部占满时不直接丢弃，而是找**权重最低**的那条，若新弹幕权重明显
   * 更高就把它挤掉（返回它的轨道号）。阈值 1.25 倍，避免两条差不多的
   * 弹幕互相踢。
   *
   * ⚠️ 实测收益很小（真实数据密集段只多上屏 0-1 条）：因为丢弃绝大多数
   * 发生在"所有轨道入场窗口都被人压着"的时刻，而不是"没得选只能丢"。
   * 挤占能改变的只是"选谁"，改变不了"总量"。保留它是为了在真正该取舍
   * 时保住更值得看的弹幕，而不是为了提升吞吐。
   */
  private pickLane(width: number, danmu?: Danmu): number {
    const W = this.W
    const t = this.now

    /**
     * 这一行的纵向区间是否被**静态弹幕**（顶/底）占住。
     *
     * ★ 必须只算静态弹幕，不能算滚动弹幕：
     * 同轨的滚动弹幕本来就占着这个纵向区间，把它算进来会让
     * "所有有滚动弹幕的轨道"永远被判为占用 —— pickLane 恒返回 -1，
     * 密集片段里九成弹幕被静默丢弃（实测每秒到 25.9 条只上屏 2.3 条）。
     *
     * 滚动弹幕之间的冲突由下面的横向区间判定负责。
     */
    const spriteH = Math.ceil(this.fontSize) + this.spritePadY * 2
    const staticBlocks = (top: number) =>
      this.active.some((a) => {
        if (a.danmu.mode !== 2 && a.danmu.mode !== 3) return false
        return top < a.top + spriteH && a.top < top + spriteH
      })

    /**
     * 某条弹幕此刻的左侧坐标，与 paint 完全一致（用各自的滚动时长）。
     *
     * 因为 emit 里 born 用的是「此刻」，新弹幕的起始位置恒为 x=W，
     * 所以判定只需看「已有弹幕有没有压到入场窗口 [W-width-GAP, W]」。
     */
    const GAP = 12
    const newLeft = W - width - GAP
    const free = new Array(this.laneCount).fill(true)
    /** 每条轨道上「压在入场窗口」的所有弹幕 */
    const blockers: Active[][] = Array.from({ length: this.laneCount }, () => [])

    // 新弹幕的时长（emit 里会用同一个值），用于追尾判定
    const newDur = this.durFor(width)

    for (const a of this.active) {
      if (a.danmu.mode === 2 || a.danmu.mode === 3) continue
      const lane = Math.round((a.top - this.laneTopOffset) / this.laneHeight)
      if (lane < 0 || lane >= this.laneCount) continue
      const p = Math.min(1.6, Math.max(0, (t - a.born) / a.dur))
      const left = W - p * (W + a.width)
      const right = left + a.width
      // ★ 用 <= 而不是 <：刚出生时 left 正好等于 W，严格小于会把
      // "同批刚上屏的那条"判成不相交，同一轨道会无限塞入
      // （实测 seek 后一格挤了 31 条）。
      let blocked = left <= W && right > newLeft

      // ★ 追尾判定：长弹幕被加速后速度不一样，快的会追上前面的慢的。
      //
      // 长弹幕加速让 dur 变小 → 速度 (W+width)/dur 变大。如果新弹幕
      // 比同轨已有那条更快，入场时虽然不重叠，但会在中途追上。
      // 实测漏掉这条时出现 55 帧重叠（162px 的 12s 弹幕被 514px 的
      // 9s 弹幕追上，dx=17）。
      //
      // 判定：算追上所需时间，若在此之前前面那条还没飞出左边界，就冲突。
      if (!blocked && newDur < a.dur) {
        const vNew = (W + width) / newDur
        const vOld = (W + a.width) / a.dur
        const gapNow = right - newLeft // 新弹幕入场时与它的间距（负值表示已重叠）
        if (vNew > vOld) {
          // 追上需要的时间（秒）
          const catchUp = gapNow > 0 ? gapNow / (vNew - vOld) : 0
          // 前面那条还剩多久飞出左边界
          const oldRemain = (1 - p) * a.dur
          if (catchUp < oldRemain) blocked = true
        }
      }

      if (blocked) {
        free[lane] = false
        blockers[lane].push(a)
      }
    }

    for (let i = 0; i < this.laneCount; i++) {
      if (!free[i]) continue
      const top = i * this.laneHeight + this.laneTopOffset
      if (staticBlocks(top)) continue
      return i
    }

    // 满轨：尝试挤掉一条。
    //
    // 关键约束：必须把该轨道上**所有**压着窗口的弹幕都挤掉，这条才放得下。
    // 早先只挤"权重最低的那一条"，于是挤完还剩别的弹幕挡着，
    // 新弹幕直接叠上去（实测 74 帧重叠）。
    if (danmu) {
      const wNew = this.weightOf(danmu)
      let bestLane = -1
      let bestW = Infinity
      for (let i = 0; i < this.laneCount; i++) {
        const list = blockers[i]
        if (!list.length) continue
        // 这一轨要挤掉的代价 = 所有阻挡者的最低权重
        let minW = Infinity
        for (const b of list) minW = Math.min(minW, this.weightOf(b.danmu))
        if (minW < bestW) {
          bestW = minW
          bestLane = i
        }
      }
      // 只在新弹幕明显更值得看时才挤（1.25 倍），否则宁可丢弃
      if (bestLane >= 0 && wNew > bestW * 1.25) {
        for (const b of blockers[bestLane]) {
          const idx = this.active.indexOf(b)
          if (idx >= 0) this.active.splice(idx, 1)
        }
        return bestLane
      }
    }

    // 权重也不占优：丢弃。绝不随机挑一条硬塞，那样密集片段会糊成一团。
    return -1
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.ro?.disconnect()
    this.ro = null
    if (this.onWinResize && typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWinResize)
      window.removeEventListener('orientationchange', this.onWinResize)
      this.onWinResize = null
    }
    this.active = []
    this.queue = []
    this.container.remove()
  }
}

/** 找到第一个 time >= t 的下标 */
function lowerBound(list: Danmu[], t: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}
