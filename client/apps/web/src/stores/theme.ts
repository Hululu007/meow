/**
 * 主题：风格（8 套）× 明暗（浅/深）× 偏好（浅/深/跟随系统）。
 *
 * ## 三层结构（与参考项目一致）
 *
 * ```
 * themeMode   'light' | 'dark' | 'system'   ← 用户的选择
 *      ↓ resolve()
 * resolved    'light' | 'dark'              ← 实际生效的明暗
 * themeStyle  'meow' | 'claude' | 'material' | 'nord' | 'tokyo' | 'catppuccin' | 'oled' | 'everforest'
 *      ↓
 * THEMES[style][resolved]  → base / accent 两个运行时需要的值
 * ```
 *
 * ## ★ 为什么用 data 属性而不是 setProperty
 *
 * 最初确实是走 `setProperty` 写行内变量。变量本身切得动
 * （getPropertyValue 立刻是新值），但**已经渲染过的元素背景色不重算** ——
 * 实测：同一父节点下新建的克隆元素拿到新色，原有元素仍是旧色；
 * 把原元素 remove 再 insert 回来立刻变对。这是 Chromium 增量样式失效的缺陷：
 * 改根元素上的自定义属性时，没有把「该变量被 background-color 引用」
 * 的依赖传播到已有 computed style。border-radius 这类普通属性不受影响，
 * 所以现象很迷惑。
 *
 * 最终改成切两个 data 属性 + CSS 选择器：选择器匹配变化会正规触发样式失效，
 * 八套风格 × 浅深立刻全部正确。变量表在 tokens.css。
 *
 * ## 防闪烁
 *
 * index.html 的 <head> 里有一段内联脚本，在首帧前就把两个属性写好。
 * 它不内联变量值（那样两处容易走偏），只算 style/mode 两个字符串。
 */

import { getPrefs, type ThemeMode, type ThemeStyle } from './prefs'

export const THEME_STYLES: Array<{
  value: ThemeStyle
  label: string
  hint: string
  /** 菜单里的三色预览：强调 / 深色底 / 浅色底 */
  swatch: [string, string, string]
}> = [
  { value: 'meow', label: '猫窝青', hint: '品牌色', swatch: ['#03dac5', '#12141d', '#f4f6fa'] },
  { value: 'claude', label: 'Claude', hint: '暖棕 · 纸感', swatch: ['#e88a68', '#1f1e1b', '#efebe0'] },
  { value: 'material', label: 'Material', hint: '冷紫 · 克制', swatch: ['#d0bcff', '#141218', '#fefbff'] },
  { value: 'nord', label: 'Nord', hint: '冷灰 · 极简', swatch: ['#88c0d0', '#2e3440', '#eceff4'] },
  { value: 'tokyo', label: 'Tokyo Night', hint: '深蓝 · 夜', swatch: ['#7aa2f7', '#1a1b26', '#eef0f7'] },
  { value: 'catppuccin', label: 'Catppuccin', hint: '柔紫 · 奶油', swatch: ['#cba6f7', '#181825', '#eff1f5'] },
  { value: 'oled', label: 'OLED', hint: '纯黑 · 高对比', swatch: ['#ffb300', '#000000', '#ffffff'] },
  { value: 'everforest', label: 'Everforest', hint: '绿灰 · 护眼', swatch: ['#a7c080', '#2b3339', '#fdf6e3'] },
]

export const THEME_MODES: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: 'light', label: '浅色', hint: '' },
  { value: 'dark', label: '深色', hint: '' },
  { value: 'system', label: '跟随系统', hint: '' },
]

const VALID_STYLE = new Set<string>(THEME_STYLES.map((t) => t.value))

export function isThemeStyle(v: unknown): v is ThemeStyle {
  return typeof v === 'string' && VALID_STYLE.has(v)
}

type Vars = { base: string; accent: string }

/**
 * 每套风格的两个运行时值。
 *
 * ★ 只留 base 与 accent：真正生效的 27 个变量在 tokens.css 的
 *   `html[data-style][data-mode]` 里，本文件只用于
 *   ① 更新 <meta name="theme-color">（base）
 *   ② 算 TV 焦点光晕（accent）。
 *   以前这里抄了整份 23 键色板，加一套主题要两处同步，已经成为漂移源；
 *   现在 tokens.css 是唯一真源，tests/theme-tokens.test.ts 锁住一致性。
 */
const THEMES: Record<ThemeStyle, { light: Vars; dark: Vars }> = {
  meow: {
    dark: { base: '#12141d', accent: '#03dac5' },
    light: { base: '#f4f6fa', accent: '#00a896' },
  },
  claude: {
    dark: { base: '#1f1e1b', accent: '#e88a68' },
    light: { base: '#efebe0', accent: '#a14427' },
  },
  material: {
    dark: { base: '#141218', accent: '#d0bcff' },
    light: { base: '#fefbff', accent: '#6750a4' },
  },
  nord: {
    dark: { base: '#2e3440', accent: '#88c0d0' },
    light: { base: '#eceff4', accent: '#4c6f96' },
  },
  tokyo: {
    dark: { base: '#1a1b26', accent: '#7aa2f7' },
    light: { base: '#eef0f7', accent: '#2e5fbf' },
  },
  catppuccin: {
    dark: { base: '#181825', accent: '#cba6f7' },
    light: { base: '#eff1f5', accent: '#8839ef' },
  },
  oled: {
    dark: { base: '#000000', accent: '#ffb300' },
    light: { base: '#ffffff', accent: '#a34a00' },
  },
  everforest: {
    dark: { base: '#2b3339', accent: '#a7c080' },
    light: { base: '#fdf6e3', accent: '#667a00' },
  },
}

/**
 * 只导出 base/accent 两个值（给需要读当前主题色的模块/测试用）。
 *
 * 完整 27 个变量的唯一真源是 tokens.css；index.html 的首帧脚本只切
 * data 属性、不内联色值，所以这里不需要再抄一份全量色板。
 */
export const THEME_VARS = THEMES

/** 系统当前是否深色 */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 把偏好解析成实际明暗 */
export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

/**
 * 应用主题：只切 html 上的两个属性。
 *
 * ★ 为什么不在 JS 里写行内变量（虽然那样看着更直接）：
 *   实测 Chromium 只改根元素的自定义属性时，**已渲染元素的 background-color
 *   不会重算** —— 变量读出来是新值，但元素背景仍是旧色；同一父节点下新建的
 *   克隆元素却是对的。这是增量样式失效的缺陷。
 *   改成切 data 属性 + CSS 选择器后，选择器匹配变化会正规触发样式失效，
 *   八套主题 × 浅深所有元素立刻正确。
 *
 * 变量表因此挪到了 tokens.css（`html[data-style][data-mode]`），
 * 那份是唯一的运行时来源；本文件的 THEMES 只保留 base/accent。
 */
/**
 * 全屏播放 / 直播页强制暗色。
 *
 * <p>那两页的底是视频画面，所有面板（倍速菜单、弹幕搜索、选集、提示条）
 * 都压在画面上；浅色主题下 `--color-elevated` 接近白，浮层就会变成
 * 一块白斑（2026-11-12 用户报「浅色显示有的区域太白」）。
 *
 * <p>做法是在解析明暗时短路成 dark：不动 prefs，退出这两页立刻恢复用户
 * 选择；壁纸、顶栏这些只在普通页面出现的元素本来也不在那两页里。
 */
let forceDark = false

/** 进/出全屏播放、直播页时由 App.vue 调用 */
export function setForceDark(on: boolean) {
  if (forceDark === on) return
  forceDark = on
  syncThemeFromPrefs()
}

/** 给测试用：当前是否处于强制暗色 */
export function isForceDark(): boolean {
  return forceDark
}

export function applyTheme(style: ThemeStyle, mode: ThemeMode) {
  if (typeof document === 'undefined') return
  const s = isThemeStyle(style) ? style : 'meow'
  const resolved = forceDark ? 'dark' : resolveMode(mode)
  const root = document.documentElement

  root.setAttribute('data-style', s)
  root.setAttribute('data-mode', resolved)
  // 原生控件（滚动条、输入框、日期选择器）跟着走
  root.style.colorScheme = resolved

  // 浏览器 UI 主题色（地址栏/任务栏角标）：跟着当前底色
  const base = THEMES[s][resolved].base
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta && base) meta.setAttribute('content', base)

  /*
   * TV 焦点框的光晕色。
   *
   * tv-nav.js 画焦点框用 `var(--color-accent)`，光晕需要半透明同色值。
   * 不能用 CSS `color-mix()`——极米那台是 Chrome 66，实测整条规则被丢弃
   * （见 AGENTS §4.8 的老内核清单）。所以在 JS 里从 accent 直接算 rgba
   * 写进变量，兼容性最好。
   */
  const accent = THEMES[s][resolved].accent
  const halo = rgbaFromHex(accent, 0.28)
  if (halo) root.style.setProperty('--tv-focus-halo', halo)

  // 通知需要按明暗分别处理的组件（如背景压暗遮罩）
  window.dispatchEvent(
    new CustomEvent('meow:theme', { detail: { style: s, mode: resolved } }),
  )
}

/**
 * `#03dac5` → `rgba(3,218,197,0.28)`。
 *
 * 只处理 3/6 位十六进制（主题表里全是这种）；其他格式返回空串，
 * 让 CSS 的默认值生效——宁可光晕色不完美，也不要写非法值让整条规则失效。
 */
function rgbaFromHex(hex: string | undefined, alpha: number): string {
  if (!hex) return ''
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return ''
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

/** 从 prefs 读一次并应用（启动 / 恢复备份后调用） */
export function syncThemeFromPrefs() {
  const p = getPrefs()
  applyTheme(p.themeStyle, p.themeMode)
}

/**
 * 启动时挂一次：应用当前主题 + 监听 prefs 变化 + 跟随系统时监听系统切换。
 * 返回注销函数。
 */
export function installThemeWatcher(): () => void {
  syncThemeFromPrefs()

  const onPrefs = () => syncThemeFromPrefs()
  window.addEventListener('meow:prefs', onPrefs)

  // 只有「跟随系统」时才响应系统变化；手动锁定浅/深时不打扰
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onSystem = () => {
    if (getPrefs().themeMode === 'system') syncThemeFromPrefs()
  }
  mq?.addEventListener?.('change', onSystem)

  return () => {
    window.removeEventListener('meow:prefs', onPrefs)
    mq?.removeEventListener?.('change', onSystem)
  }
}

// ---------------------------------------------------------------- 背景

export interface Wallpaper {
  /** 存进 prefs 的值；'' 表示不用背景；'custom' 表示用户上传 */
  value: string
  label: string
  /** 图片路径（public 下），空表示无图 */
  src: string
  thumb: string
}

/**
 * 壁纸都在 public/wallpapers 下。
 *
 * ★ 必须经 `BASE_URL` 拼前缀：fnOS 微应用按 `--base=/app/meow/` 构建，
 *   写死 `/wallpapers/...` 会请求到飞牛站点根；且普通字符串拼接不会被
 *   打包器改写，只有 `import.meta.env.BASE_URL` 是编译期常量。
 */
const WP = `${import.meta.env.BASE_URL}wallpapers/`

export const WALLPAPERS: Wallpaper[] = [
  { value: '', label: '无背景', src: '', thumb: '' },
  {
    value: 'cinema',
    label: '影院光斑',
    src: `${WP}cinema.webp`,
    thumb: `${WP}cinema-thumb.webp`,
  },
  {
    value: 'aura',
    label: '青色光带',
    src: `${WP}aura.webp`,
    thumb: `${WP}aura-thumb.webp`,
  },
  {
    value: 'cat',
    label: '窗边猫',
    src: `${WP}cat.webp`,
    thumb: `${WP}cat-thumb.webp`,
  },
  /*
   * 以下 5 张是 2026-10-30 生成的"意境"系列。
   *
   * 共同的设计约束（有壁纸时整站会切到 `html[data-wallpaper='1']` 的配色，
   * 壁纸若抢眼会把正文压得看不清）：
   *   · 极低对比、无强焦点、大面积暗场留白
   *   · 单张 webp 6~16KB，比原有的 16~20KB 还小
   * 色系各不相同，便于对应不同主题：冷暖各两档 + 一个中性的星云。
   */
  {
    value: 'nightcity',
    label: '夜雨灯影',
    src: `${WP}nightcity.webp`,
    thumb: `${WP}nightcity-thumb.webp`,
  },
  {
    value: 'ember',
    label: '余烬微光',
    src: `${WP}ember.webp`,
    thumb: `${WP}ember-thumb.webp`,
  },
  {
    value: 'dusksea',
    label: '暮海沉照',
    src: `${WP}dusksea.webp`,
    thumb: `${WP}dusksea-thumb.webp`,
  },
  {
    value: 'nebula',
    label: '深空星云',
    src: `${WP}nebula.webp`,
    thumb: `${WP}nebula-thumb.webp`,
  },
  /*
   * 2026-11-09 新增：横屏双用系列（混元生图，后期统一到暗色组 YAVG 28–42）。
   *
   * 为什么是 16:9：与原有 14 张统一为 1920×1080，TV/桌面直接铺满；
   * 手机是 bg-cover + bg-center，会从中间裁出约 32% 宽度（607×1080），
   * 所以构图把主体放在中央三分之一，外圈只留渐变/散景。
   */
  {
    value: 'firefly',
    label: '萤火幽林',
    src: `${WP}firefly.webp`,
    thumb: `${WP}firefly-thumb.webp`,
  },
  {
    value: 'theater',
    label: '放映厅',
    src: `${WP}theater.webp`,
    thumb: `${WP}theater-thumb.webp`,
  },
  /*
   * 以下 6 张是 2026-10-31 生成的"浅色"系列（云端混元生图）。
   *
   * 与上面 8 张的关系：那批全是暗调（YAVG 27–42），这批是明亮有内容的
   * 画面（YAVG 224–247），专门给 light 主题用。设置页按当前主题只推荐
   * 同一组（见 wallpapers.ts 的 LIGHT_WALLPAPERS），避免深色主题的用户
   * 点到浅色壁纸导致正文看不清。
   *
   * 题材按"可爱 / 风景 / 山水"三类铺开，色系各不相同，便于对应不同主题：
   *   猫窝青 → 山水、云海   暖沙 → 樱花、小兔
   *   水泥   → 山野薄雾     米柚 → 窗边小憩
   */
  {
    value: 'shanshui',
    label: '淡彩山水',
    src: `${WP}shanshui.webp`,
    thumb: `${WP}shanshui-thumb.webp`,
  },
  {
    value: 'cloudsea',
    label: '云海晨光',
    src: `${WP}cloudsea.webp`,
    thumb: `${WP}cloudsea-thumb.webp`,
  },
  {
    value: 'sakura',
    label: '樱花窗前',
    src: `${WP}sakura.webp`,
    thumb: `${WP}sakura-thumb.webp`,
  },
  {
    value: 'catnap',
    label: '窗边小憩',
    src: `${WP}catnap.webp`,
    thumb: `${WP}catnap-thumb.webp`,
  },
  {
    value: 'rabbit',
    label: '青草小兔',
    src: `${WP}rabbit.webp`,
    thumb: `${WP}rabbit-thumb.webp`,
  },
  {
    value: 'meadow',
    label: '山野薄雾',
    src: `${WP}meadow.webp`,
    thumb: `${WP}meadow-thumb.webp`,
  },
  /*
   * 2026-11-09 新增：横屏双用（浅色组，YAVG 213–224）。
   * 同样是中央三分之一安全区构图；题材覆盖宣纸、茶田、窗台静物。
   */
  {
    value: 'inkpeak',
    label: '宣纸远山',
    src: `${WP}inkpeak.webp`,
    thumb: `${WP}inkpeak-thumb.webp`,
  },
  {
    value: 'teafield',
    label: '晨雾茶田',
    src: `${WP}teafield.webp`,
    thumb: `${WP}teafield-thumb.webp`,
  },
  {
    value: 'linen',
    label: '晨光窗台',
    src: `${WP}linen.webp`,
    thumb: `${WP}linen-thumb.webp`,
  },
]

/** 自定义背景单独存（体积大，不塞进 meow.prefs，避免 WebDAV 备份膨胀） */
const CUSTOM_KEY = 'meow.wallpaper.custom'

export function getCustomWallpaper(): string {
  try {
    return localStorage.getItem(CUSTOM_KEY) || ''
  } catch {
    return ''
  }
}

export function setCustomWallpaper(dataUrl: string) {
  try {
    if (dataUrl) localStorage.setItem(CUSTOM_KEY, dataUrl)
    else localStorage.removeItem(CUSTOM_KEY)
  } catch {
    /* 配额满：交给调用方提示 */
  }
}

/** 拿到某个预设值的实际图片地址（'custom' 时读上传的图） */
export function wallpaperSrc(value: string): string {
  if (value === 'custom') return getCustomWallpaper()
  return WALLPAPERS.find((w) => w.value === value)?.src ?? ''
}
