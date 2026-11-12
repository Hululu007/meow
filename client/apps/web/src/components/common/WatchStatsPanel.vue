<script setup lang="ts">
/**
 * 观看统计面板（TV 遥控器友好）。
 *
 * <p><b>为什么单独做成弹框而不是继续堆在历史页卡片里</b>：用户原话
 * 「历史页面的，统计卡片样式不太友好（时长保留的情况下，额外单独统计按钮，
 * 打开统计面板）。是否可以参考学习 zcode 的统计图」。
 * 海报墙是主内容，统计是"偶尔看一眼"的次要信息；铺开一屏图表会把
 * 14 条历史挤到需要滚两屏才看得完。
 *
 * <p><b>为什么手写 SVG 不引图表库</b>：
 *   1. 现有历史页的柱状图就是"纯 div，不引图表库"，保持一致；
 *   2. 只用到三种图（热力格子 / 折线 / 环），加起来不到 300 行，
 *      引 echarts（~1MB）不划算，而且 TV 老内核（Chrome 66）上
 *      大库的初始化开销明显；
 *   3. 颜色全部走 CSS 变量（--color-accent 等），换主题自动跟随 ——
 *      图表库通常要手动同步主题色，四套主题下很容易漏。
 *
 * <p><b>为什么不用 <canvas></b>：Chrome 66 上 canvas 的 `ctx.filter`、
 *   部分合成模式缺失；而且 canvas 在高 dpr 电视上要手动乘 dpr 处理模糊，
 *   SVG 天然矢量、还能被 tv-nav 的焦点几何正确测量。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { fmtDuration, type StatsOverview } from '@/stores/watchStats'

const props = defineProps<{
  open: boolean
  overview: StatsOverview
  /** 全年逐日时长（热力图用，53 周 = 371 天） */
  series: Array<{ date: string; seconds: number }>
  /** 近 30 天逐日时长（趋势线用；30 个点以上在 720px 里会糊） */
  trendSeries: Array<{ date: string; seconds: number }>
  /** 按站点聚合的时长（秒），已按降序 */
  bySite: Array<{ name: string; seconds: number }>
  /** 总片数（历史条数） */
  titles: number
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const router = useRouter()

/**
 * 环图配色：主题 accent 打头，其余走 --chart-*。
 *
 * 分类色**不跟主题风格**（否则每换一套主题图例就换一次色，看历史数据时
 * 对不上），但必须跟明暗：浅色底上原来的 #fbbf24/#34d399 太亮，
 * 实测在 #fefbff 上只有 1.8~2.2:1。--chart-* 在 tokens.css 里按
 * data-mode 给了深浅两套。
 */
const RING_COLORS = [
  'var(--color-accent)',
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
]

// ---------------------------------------------------------------- 热力图
//
// ★ 整年格子（参考 zcode 的「Token 活动」那张）。
//
// 用户反馈「这是什么意思啊，看不到这个图」+ 补充「再看一下zcode的效果」。
// 原来是 30 天 5 列 18px 小方块，只占 12% 宽度、右边一大片空白，
// 也没说清"一格是一天"。zcode 那张是整年 53 列铺满，视觉密度完全不同。
//
// 现在：从今天往回铺满 53 周（371 天），一周一列、一列七格，
// 格子宽度用 CSS 均分（`flex-1`），整块占满面板宽度。

/** 53 周 × 7 天 = 371 天，与 zcode 的"一整年"密度一致 */
const HEAT_WEEKS = 53
/** 星期标签：只标一/三/五，七行全标在 TV 上会糊 */
const DAY_LABELS = ['', '一', '', '三', '', '五', '']

interface HeatCell {
  date: string
  seconds: number
  level: number
  col: number
  row: number
  /** 0=周日 … 6=周六，给"最常看的星期"用 */
  weekday: number
}

const heat = computed<HeatCell[]>(() => {
  const series = props.series
  const max = Math.max(1, ...series.map((d) => d.seconds))
  /*
   * 对齐方式：最后一列 = 本周（含今天），往前铺满 53 列。
   *
   * 起始日退到"最后一列的周日"：这样每列恰好是一整周（周一~周日不会
   * 被劈到两列），与 zcode 那排"11月 12月 1月…"的月份刻度才对得上。
   */
  const last = series[series.length - 1]
  if (!last) return []
  const [ly, lm, ld] = last.date.split('-').map(Number)
  const lastDate = new Date(ly, lm - 1, ld)
  // 本周的周日（getDay() 0=周日）
  const thisSunday = new Date(lastDate)
  thisSunday.setDate(thisSunday.getDate() - lastDate.getDay())
  // 第一列的周日
  const start = new Date(thisSunday)
  start.setDate(start.getDate() - (HEAT_WEEKS - 1) * 7)

  const map = new Map(series.map((d) => [d.date, d.seconds]))
  const cells: HeatCell[] = []
  const total = HEAT_WEEKS * 7
  for (let i = 0; i < total; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    const seconds = map.get(k) || 0
    // 4 档：0 / 低 / 中 / 高。不用等比 —— 观看时长长尾明显，
    // 等比会让"看了 10 分钟"和"没看"看着一样淡。
    const level = seconds === 0 ? 0 : Math.min(3, Math.ceil((seconds / max) * 3))
    // 未来日期（本周今天之后）也画出来，颜色置 0 —— 留白让"这一周还没过完"看得出来
    cells.push({ date: k, seconds, level, col: Math.floor(i / 7), row: i % 7, weekday: d.getDay() })
  }
  return cells
})

/**
 * 月份刻度：zcode 那条"11月 12月 1月…"。
 *
 * 只在该月第一次出现的那一列打标 —— 53 列全标会糊成一团。
 * 首列若离月末太近（< 2 列）就不标，避免和下一个月的标签挤在一起。
 */
const monthLabels = computed(() => {
  const out: Array<{ col: number; label: string }> = []
  let prevMonth = -1
  for (let c = 0; c < HEAT_WEEKS; c++) {
    const first = heat.value.find((x) => x.col === c)
    if (!first) continue
    const m = Number(first.date.slice(5, 7))
    if (m !== prevMonth) {
      // 前 2 列不打标：起始那列往往只占该月的尾巴
      if (c >= 2 || prevMonth === -1) out.push({ col: c, label: `${m}月` })
      prevMonth = m
    }
  }
  return out
})

/** 活跃比例的人话说法 */
const avgText = computed(() => {
  const pct = Math.round((props.overview.activeDays / (HEAT_WEEKS * 7)) * 100)
  if (pct >= 70) return '几乎每天都看'
  if (pct >= 40) return `${pct}% 的日子在看`
  if (pct > 0) return '偶尔看看'
  return '还没有记录'
})

/**
 * 最常看的星期几。
 *
 * 与"最久一天"不同：那是单日峰值；这个是"每周哪一天习惯性打开"——
 * 后者更像行为规律，用户看了会有点共鸣。
 */
const bestWeekday = computed(() => {
  const names = ['日', '一', '二', '三', '四', '五', '六']
  const sum = new Array(7).fill(0)
  for (const cell of heat.value) {
    if (cell.seconds > 0) sum[cell.weekday] += cell.seconds
  }
  const max = Math.max(...sum)
  if (max <= 0) return null
  return { name: names[sum.indexOf(max)], totalText: fmtDuration(max) }
})

/**
 * 热力格子的颜色与不透明度。
 *
 * ★ 不要用 `color-mix()`。
 *
 * 踩过（MuMu 实测，2026-10-30）：第一版写的是
 * `color-mix(in srgb, var(--color-accent) 55%, transparent)`，
 * 结果 35 个格子**全部渲染成灰色** —— 深浅完全看不出来。
 * 这台设备的 WebView 是 Chrome 66 内核，`color-mix` 要 Chrome 111+。
 * 项目里虽然有 `gen-legacy-css.mjs` 做构建期降级，但它只处理**样式表里**的
 * 规则；这里是 JS 算出来的行内 style，降级层覆盖不到（弹幕容器 `inset:0`
 * 踩过同一个坑，见 docs/49）。
 *
 * 改成"固定底色 + 元素自身 opacity"：opacity 从 Chrome 1 就有，
 * 而且对背景色同样生效，效果与 alpha 混合基本一致。
 */
function heatFill(level: number): string {
  return level === 0 ? 'var(--color-line)' : 'var(--color-accent)'
}

/** 热力格子的不透明度（0 级是底纹，1~3 递增） */
function heatOpacity(level: number): number {
  return [1, 0.28, 0.6, 1][level]
}

// ---------------------------------------------------------------- 趋势线
//
// 近 30 天观看时长。用 7 天为单位的折线 + 面积填充（zcode 的每日趋势图
// 同一个思路：折线主看形状，面积帮眼睛找到"高的那段"）。

const TREND_W = 720
const TREND_H = 160
const PAD = { l: 8, r: 8, t: 12, b: 20 }

const trend = computed(() => {
  const series = props.trendSeries
  if (series.length < 2) return null
  /*
   * ★ Y 轴缩放：峰值太小时抬高视觉下限。
   *
   * 实测（MuMu，只有 1 天有记录、24 秒）：按真实 max 线性映射时，
   * 30 天里有 29 天是 0，曲线整条贴在底线上、只有最右端一个小尖，
   * 看不出任何"形状"。这不是画错了，是数据本身长尾 —— 但用户要的是
   * "看趋势"，贴底的线等于没画。
   *
   * 处理：把 max 抬到至少 5 分钟。低于这个量级时曲线会被"放大"，
   * 高得多的日子仍按真实比例（会顶到上沿，这是对的）。
   * 硬性抬到 300 秒不会歪曲相对关系（同一天比另一天高多少仍然成立），
   * 只是改纵轴刻度 —— 折线图本来就不标 Y 轴数值，所以没有"读错刻度"的风险。
   */
  const peak = Math.max(...series.map((d) => d.seconds))
  const max = Math.max(300, peak)
  const innerW = TREND_W - PAD.l - PAD.r
  const innerH = TREND_H - PAD.t - PAD.b
  const step = innerW / (series.length - 1)
  const pts = series.map((d, i) => ({
    x: PAD.l + i * step,
    y: PAD.t + innerH - (d.seconds / max) * innerH,
    ...d,
  }))
  /*
   * 平滑曲线：用 Catmull-Rom → 三次贝塞尔。
   * 直线段在 30 个点上会显得很"锯齿"，而 zcode 那条曲线是平滑的，
   * 视觉上更接近"趋势"而不是"逐日读数"。
   */
  let path = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  const area = `${path} L ${pts[pts.length - 1].x} ${TREND_H - PAD.b} L ${pts[0].x} ${
    TREND_H - PAD.b
  } Z`
  // 只标首/中/尾三个日期，30 个全标会糊成一团（TV 480p 上尤其）
  const marks = [0, Math.floor(series.length / 2), series.length - 1].map((i) => ({
    x: pts[i].x,
    label: series[i].date.slice(5),
  }))
  return { path, area, marks, max, peak: pts.reduce((a, b) => (b.seconds > a.seconds ? b : a)) }
})

// ---------------------------------------------------------------- 环图
//
// 按站点占比（zcode 的"模型用量"同一个表达：环形 + 右侧明细列表）。

const RING_R = 62
const RING_STROKE = 26
const RING_C = 2 * Math.PI * RING_R

const ring = computed(() => {
  const total = props.bySite.reduce((a, b) => a + b.seconds, 0)
  if (!total) return null
  let acc = 0
  const arcs = props.bySite.slice(0, RING_COLORS.length).map((s, i) => {
    const frac = s.seconds / total
    const seg = {
      name: s.name,
      seconds: s.seconds,
      pct: frac * 100,
      color: RING_COLORS[i % RING_COLORS.length],
      // SVG 圆环：dasharray 画一段，dashoffset 把它转到正确起点
      dash: `${frac * RING_C} ${RING_C}`,
      offset: -acc * RING_C,
    }
    acc += frac
    return seg
  })
  // 超出配色数量的站点合并成「其他」
  const shown = props.bySite.slice(0, RING_COLORS.length)
  const rest = props.bySite.slice(RING_COLORS.length)
  const merged = rest.length
    ? [{ name: '其他', seconds: rest.reduce((a, b) => a + b.seconds, 0), color: 'var(--chart-7)' }]
    : []
  const legend = [
    ...shown.map((s, i) => ({
      name: s.name,
      seconds: s.seconds,
      pct: (s.seconds / total) * 100,
      color: RING_COLORS[i % RING_COLORS.length],
    })),
    ...merged.map((m) => ({ ...m, pct: (m.seconds / total) * 100 })),
  ]
  return { total, arcs, legend }
})

function close() {
  emit('close')
}

/** 跳到片库/首页找片（统计里看到某个站点占比高，下一步通常是想去那儿） */
function goHome() {
  close()
  router.push({ name: 'home' })
}
</script>

<template>
  <Teleport to="body">
    <!--
      data-tv-scope：把方向键收窄到面板内。
      Teleport to body：站内 <main> 有 `relative z-10`（层叠上下文），
      不跳出去的话本面板的 z 只在 main 内比较，会被顶栏（sticky z-30）盖住
      —— 站点明细弹框踩过这个坑，详见 SettingsView 的注释。
    -->
    <div
      v-if="open"
      data-tv-scope
      class="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-5"
      @click.self="close()"
    >
      <div
        class="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-line bg-base"
        style="box-shadow: 0 24px 60px -12px rgba(0, 0, 0, 0.75)"
      >
        <!-- 标题栏 -->
        <div class="set-head shrink-0 px-4 pt-3">
          <h2 class="set-title">观看统计</h2>
          <span class="set-hint">按实际播放秒数累计</span>
          <span class="flex-1" />
          <button
            class="rounded-md bg-card px-2.5 py-1 text-[11px] hover:bg-card-hover"
            @click="close()"
          >
            返回
          </button>
        </div>

        <!--
          data-tv-scroll + tabindex：面板内容超一屏时，遥控器要能滚它。
          这是 tv-nav 约定的滚动停靠点（容器自己进候选集，上下键先滚动）。
        -->
        <!--
          ★ data-tv-first 必加。

          踩过（MuMu 实测，2026-10-30）：面板打开时焦点落在标题栏的「返回」上，
          按一次下键直接跳到固定底栏的「关闭」，中间 791px 的图表区
          一次都进不去（实测连按 8 次下键，scrollTop 恒 0）。
          原因是 `focusIntoScope` 的默认落点是"scope 内第一个可聚焦元素"，
          而 DOM 顺序上标题栏在内容区之前。

          `data-tv-first` 是 tv-nav 约定的显式首选落点（优先级高于位置）。
          焦点落到这个容器后，上下键会走 `data-tv-scroll` 的滚动分支
          （见 `move()`），用户才能翻看下面的热力图/趋势图/环图。
        -->
        <div
          data-tv-first
          data-tv-scroll
          tabindex="0"
          class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2 outline-none"
        >
          <!-- ── 指标卡：5 项，参考 zcode 的"应用用量"那一排 ── -->
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div
              v-for="m in [
                { k: '今日', v: fmtDuration(overview.today), s: '' },
                { k: '近 7 天', v: fmtDuration(overview.week), s: '' },
                { k: '近 30 天', v: fmtDuration(overview.month), s: '' },
                {
                  k: '当前连续',
                  v: `${overview.streak} 天`,
                  s: overview.longestStreak ? `最长 ${overview.longestStreak} 天` : '',
                },
                { k: '有记录', v: `${overview.activeDays} 天`, s: `共 ${titles} 部` },
              ]"
              :key="m.k"
              class="rounded-lg border border-line bg-card px-3 py-2.5"
            >
              <div class="text-[11px] text-ink-3">{{ m.k }}</div>
              <div class="mt-0.5 text-[15px] font-semibold text-ink">{{ m.v }}</div>
              <div v-if="m.s" class="text-[10px] text-ink-3">{{ m.s }}</div>
            </div>
          </div>

          <!--
            零数据提示：统计为 0 时图表全是空的，不说明的话像功能坏了。
            （卡片在"有历史但没时长"时也会显示，所以这条路径真实存在。）
          -->
          <div
            v-if="overview.total === 0"
            class="mt-3 rounded-lg border border-dashed border-line bg-card px-4 py-6 text-center"
          >
            <p class="text-[12px] text-ink-2">还没有累计观看时长</p>
            <p class="mt-1.5 text-[10px] leading-relaxed text-ink-3">
              时长按播放器实际推进的秒数累加，播过一次就会开始记录。<br />
              只点封面没播放、或拖进度条都不会计入。
            </p>
          </div>

          <!-- ── 热力图：整年 ── -->
          <section v-if="overview.total > 0" class="mt-3 rounded-lg border border-line bg-card px-3 py-3">
            <div class="mb-2 flex items-baseline gap-2">
              <h3 class="text-[12px] font-medium text-ink">观看活跃度</h3>
              <span class="text-[10px] text-ink-3">近一年</span>
              <!-- 色阶图例：紧跟在标题后，读者一眼能对上"深浅=多少" -->
              <span class="flex items-center gap-1 text-[9px] text-ink-3">
                <span>少</span>
                <span
                  v-for="lv in [0, 1, 2, 3]"
                  :key="'lg' + lv"
                  class="h-[9px] w-[9px] rounded-[2px]"
                  :style="{ background: heatFill(lv), opacity: heatOpacity(lv) }"
                />
                <span>多</span>
              </span>
              <span class="flex-1" />
              <span v-if="overview.peak.seconds > 0" class="text-[10px] text-ink-3">
                峰值 {{ overview.peak.date.slice(5) }} · {{ fmtDuration(overview.peak.seconds) }}
              </span>
            </div>
            <!--
              ★ 整年格子铺满宽度（对齐 zcode 的「Token 活动」那张）。

              用户反馈「这是什么意思啊，看不到这个图」后参照 zcode 的效果重做：
                1. 从 5 列扩到 53 列（一整年），格子用 `flex-1` 均分铺满，
                   不再留 88% 的空白；
                2. 底部补月份刻度（11月 12月 1月…），说明"每列是一周"；
                3. 右侧补一组结论文字（活跃比例 / 最常看的星期 / 最久一天），
                   把图表"读成人话"—— 用户问"这是什么意思"，根子就在这里。
            -->
            <div class="flex gap-3">
              <!-- 星期标签 -->
              <div class="flex shrink-0 flex-col gap-[3px] pr-0.5 text-[9px] leading-none text-ink-3">
                <span
                  v-for="(w, i) in DAY_LABELS"
                  :key="'d' + i"
                  class="flex flex-1 items-center justify-end"
                >
                  {{ w }}
                </span>
              </div>
              <!-- 格子矩阵：53 列均分 -->
              <div class="min-w-0 flex-1">
                <div class="flex gap-[3px]">
                  <div
                    v-for="c in HEAT_WEEKS"
                    :key="c"
                    class="flex min-w-0 flex-1 flex-col gap-[3px]"
                  >
                    <div
                      v-for="cell in heat.filter((x) => x.col === c - 1)"
                      :key="cell.date"
                      class="aspect-square w-full min-w-0 rounded-[2px]"
                      :style="{
                        background: heatFill(cell.level),
                        opacity: heatOpacity(cell.level),
                      }"
                      :title="`${cell.date} · ${cell.seconds ? fmtDuration(cell.seconds) : '没看'}`"
                    />
                  </div>
                </div>
                <!-- 月份刻度：绝对定位到对应列，避免 53 个等宽格子里塞文字 -->
                <div class="relative mt-1 h-3 text-[9px] text-ink-3">
                  <span
                    v-for="m in monthLabels"
                    :key="'m' + m.col"
                    class="absolute top-0 whitespace-nowrap"
                    :style="{
                      left: `calc(${(m.col / HEAT_WEEKS) * 100}% + ${m.col * 0.6}px)`,
                    }"
                  >
                    {{ m.label }}
                  </span>
                </div>
              </div>
            </div>

            <!-- 把图表读成人话：用户问"这是什么意思"，靠这一行回答 -->
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-3">
              <span>每格 = 一天，颜色越浓看的时间越长</span>
              <span class="text-ink-2">{{ avgText }}</span>
              <span v-if="bestWeekday">最常看：周{{ bestWeekday.name }}（{{ bestWeekday.totalText }}）</span>
              <span v-if="overview.peak.seconds > 0">
                最久一天：{{ overview.peak.date.slice(5) }} · {{ fmtDuration(overview.peak.seconds) }}
              </span>
            </div>
          </section>

          <!-- ── 趋势折线：近 30 天 ── -->
          <section v-if="trend && overview.total > 0" class="mt-3 rounded-lg border border-line bg-card px-3 py-3">
            <div class="mb-1 flex items-baseline gap-2">
              <h3 class="text-[12px] font-medium text-ink">每日观看时长</h3>
              <span class="text-[10px] text-ink-3">近 30 天</span>
              <span class="flex-1" />
              <span class="text-[10px] text-ink-3">日均 {{ fmtDuration(overview.avgPerActiveDay) }}</span>
            </div>
            <svg
              :viewBox="`0 0 ${TREND_W} ${TREND_H}`"
              class="h-[130px] w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label="近 30 天每日观看时长折线图"
            >
              <!-- 水平网格线：3 条就够，多了在电视上像噪点 -->
              <line
                v-for="i in 3"
                :key="i"
                :x1="PAD.l"
                :x2="TREND_W - PAD.r"
                :y1="PAD.t + ((TREND_H - PAD.t - PAD.b) / 3) * (i - 1)"
                :y2="PAD.t + ((TREND_H - PAD.t - PAD.b) / 3) * (i - 1)"
                stroke="var(--color-line)"
                stroke-width="1"
              />
              <!-- 面积：fill 用 accent 的低透明度，替眼睛圈出"高的那段" -->
              <path :d="trend.area" fill="var(--color-accent)" opacity="0.12" />
              <path
                :d="trend.path"
                fill="none"
                stroke="var(--color-accent)"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                vector-effect="non-scaling-stroke"
              />
              <!-- 日期标签 -->
              <text
                v-for="m in trend.marks"
                :key="m.label"
                :x="m.x"
                :y="TREND_H - 5"
                fill="var(--color-ink-3)"
                font-size="10"
                :text-anchor="m.x < 20 ? 'start' : m.x > TREND_W - 20 ? 'end' : 'middle'"
              >
                {{ m.label }}
              </text>
            </svg>
          </section>

          <!-- ── 环形占比：按站点 ── -->
          <section
            v-if="ring"
            class="mt-3 rounded-lg border border-line bg-card px-3 py-3"
          >
            <div class="mb-2 flex items-baseline gap-2">
              <h3 class="text-[12px] font-medium text-ink">按来源分布</h3>
              <span class="text-[10px] text-ink-3">哪个站点看得最多</span>
            </div>
            <div class="flex flex-col items-center gap-4 sm:flex-row">
              <svg
                :viewBox="`0 0 ${(RING_R + RING_STROKE / 2) * 2} ${(RING_R + RING_STROKE / 2) * 2}`"
                class="h-[150px] w-[150px] shrink-0 -rotate-90"
                role="img"
                aria-label="按来源的观看时长占比环图"
              >
                <!-- 底环：画一圈淡色，缺口看起来才像"环"而不是"弧" -->
                <circle
                  :cx="RING_R + RING_STROKE / 2"
                  :cy="RING_R + RING_STROKE / 2"
                  :r="RING_R"
                  fill="none"
                  stroke="var(--color-line)"
                  :stroke-width="RING_STROKE"
                />
                <circle
                  v-for="a in ring.arcs"
                  :key="a.name"
                  :cx="RING_R + RING_STROKE / 2"
                  :cy="RING_R + RING_STROKE / 2"
                  :r="RING_R"
                  fill="none"
                  :stroke="a.color"
                  :stroke-width="RING_STROKE"
                  :stroke-dasharray="a.dash"
                  :stroke-dashoffset="a.offset"
                />
              </svg>
              <!-- 明细列表：zcode 那套的右侧图例（名称 + 百分比 + 绝对值） -->
              <div class="min-w-0 flex-1 self-stretch">
                <ul class="flex flex-col gap-1.5">
                  <li
                    v-for="l in ring.legend"
                    :key="l.name"
                    class="flex items-center gap-2 text-[11px]"
                  >
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      :style="{ background: l.color }"
                    />
                    <span class="min-w-0 flex-1 truncate text-ink-2">{{ l.name }}</span>
                    <span class="shrink-0 tabular-nums text-ink-3">
                      {{ fmtDuration(l.seconds) }}
                    </span>
                    <span class="w-10 shrink-0 text-right tabular-nums text-ink">
                      {{ l.pct < 0.1 && l.pct > 0 ? '<0.1' : l.pct.toFixed(0) }}%
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </section>

          <p class="mt-3 text-[10px] leading-relaxed text-ink-3">
            统计按播放器实际推进的秒数累加（拖进度条不算），保留最近 30 天。
            数据只存在本机，不上传。
          </p>
        </div>

        <!-- 底部只留一个动作：统计看完通常想回去接着看 -->
        <div class="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          <button
            class="rounded-md bg-card px-3 py-1.5 text-[12px] hover:bg-card-hover"
            @click="goHome()"
          >
            去找片
          </button>
          <button
            class="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-dim"
            @click="close()"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
