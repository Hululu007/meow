/**
 * 应用偏好。所有设置项集中在这里，方便：
 *  - 设置页统一读写
 *  - 一键导出/导入（后续接 WebDAV 同步）
 *
 * 存储用 localStorage。读取时都做兜底，坏数据不会让页面挂掉。
 */

// 只有 applyBackup 需要它：还原备份时走 favorites 的校验/排序/去重，
// 而不是直接写 localStorage（那份逻辑重复一遍迟早会漂移）。
import { replaceFavorites } from './favorites'
import { WALLPAPER_IDS } from './wallpapers'
import { DEFAULT_GIT_ACCEL, normalizeGitAccel, type GitAccelPrefs } from '../api/gitAccel'
// 快照里的「辅助数据」：手工标记 / 线路偏好 / 追剧基准 / 观看统计。
// 它们各自独立存 localStorage（不属于设置、也不该被 historyLimit 裁掉），
// 但换机时丢了很疼，所以随快照走一遍。四个 store 都不 import 本文件，无环。
import { listSkipMarks, mergeSkipMarks } from './skipMarks'
import { exportLinePrefs, mergeLinePrefs } from './linePref'
import { exportSeenRemarks, mergeSeenRemarks } from './favUpdates'
import { getWatchStats, mergeWatchDays } from './watchStats'

export interface Prefs {
  // ---------------------------------------------------------------- 更新源
  /**
   * 应用更新 / 插件清单 / 运行时模块 共用的清单地址（空 = 内置默认源）。
   *
   * ★ 放在 Prefs 而不是散在 localStorage：手机扫码推送只搬 Prefs
   *   （见 main.ts 的 __meowPrefsApply），裸 localStorage 键推不过去 ——
   *   结果就是"手机上填好更新源、推到电视仍然 404"。
   */
  updateSource: string
  /**
   * 显式备用更新源（主源失败时才试；空 = 不启用）。
   *
   * 只做“用户明确配置的备用源”，**不会**回落到官方源：
   * 自定义源可能来自 fork/内网/测试版，静默换源会提示错误版本。
   */
  updateBackupSource: string
  /** 私有仓访问令牌（公开源留空）。同样随 Prefs 推送，否则模块/更新都下不动 */
  updateToken: string
  /** 启动后是否自动检查应用自身更新 */
  autoCheckApp: boolean
  /** 启动后是否自动检查 TV 运行时模块（仅已安装时生效） */
  autoCheckModule: boolean
  /** 启动后是否自动检查 PC 插件（仅有源且已装插件时生效） */
  autoCheckPlugins: boolean
  /** 启动后是否自动检查 fnOS fpk（仅 fpk 壳生效） */
  autoCheckFpk: boolean
  /**
   * 插件源是否自动跟随“应用更新源”。
   *
   * 打开时会把应用更新源作为一条插件源加入并选中；插件安装器本身不变，
   * 仍然独立下载/解压/回滚。关闭只停止跟随，不删除已加入的源。
   */
  pluginUseAppSource: boolean
  /**
   * GitHub 加速（全局）：有序代理列表 + 每类渠道是否启用。
   *
   * 存成嵌套对象；getPrefs 里用 normalizeGitAccel 做白名单/内置项补齐，
   * 避免旧数据或手改 JSON 把列表弄坏。
   */
  gitAccel: GitAccelPrefs
  /** 首页每行列数 */
  homeCols: number
  /** 弹幕开关 */
  danmaku: boolean
  /**
   * 弹幕密度档位。
   *
   * 这是一个**预设组合**，同时决定滚动时长和显示区域，
   * 而不是独立参数：实测这两个才是耦合的——时长越短，同轨越快
   * 放下一条；区域越大，能容纳的轨道越多。用户单独调这两个
   * 很难猜出结果（实测「加大区域」只提升 4%，直觉上完全相反）。
   *
   * 三档的参数是拿真实数据反推的（《庆余年》第二季 ep1，
   * 最密集 30 秒 564 条）：
   *   稀疏 18s/55% → 上屏 48%，清爽
   *   标准 12s/70% → 上屏 70%，即历史默认值，升级零变化
   *   密集  9s/85% → 上屏 91%，明显更满
   *
   * 用户手动改动时长或区域后，档位会自动变成 'custom'，
   * 避免"档位写着标准、实际是别的值"的错位。
   */
  danmakuDensity: 'sparse' | 'standard' | 'dense' | 'custom'
  /** 弹幕透明度 0.2 ~ 1 */
  danmakuOpacity: number
  /** 弹幕字号缩放 0.7 ~ 1.6 */
  danmakuScale: number
  /** 弹幕滚动时长（秒），越大越慢。通常由 danmakuDensity 设定 */
  danmakuDuration: number
  /** 同时显示的弹幕最多占几成高度。通常由 danmakuDensity 设定 */
  danmakuArea: number
  /** 弹幕屏蔽词，逗号/换行分隔，命中即不显示 */
  danmakuBlock: string
  /** 画面缩放：contain 适应 / cover 铺满 / fill 拉伸 */
  videoFit: 'contain' | 'cover' | 'fill'
  /**
   * 播完一集之后的行为。
   *  - immediate：立刻播下一集
   *  - countdown：显示倒计时浮层，到点再播（可取消）
   *  - off：不自动播
   */
  autoNextMode: 'immediate' | 'countdown' | 'off'
  /** 倒计时秒数（仅 autoNextMode = countdown 时有效） */
  autoNextDelay: number
  /** 搜索结果展示：list 列表 / grid 缩略图 */
  searchLayout: 'list' | 'grid'
  /** 聚合搜索并发线程数 */
  searchThreads: number
  /** 列表缓存天数（仅展示用，实际缓存由浏览器负责） */
  cacheDays: number
  /** 历史记录上限 */
  historyLimit: number
  /** 片头跳过秒数，0 = 不跳 */
  skipIntro: number
  /** 片尾跳过秒数，0 = 不跳 */
  skipOutro: number
  /**
   * 跳过源站给的「中插广告」段（`skips` 里 type=middle）。
   *
   * 默认关：中插落在正片中间，自动跳会打断剧情，也容易在源站标错区间时
   * 直接吞掉一段正片。只有用户明确打开才生效。
   */
  skipMiddle: boolean
  /**
   * 「跳过片头/片尾」提示的倒计时秒数：到点自动跳。
   *
   * 0 = 直接跳（不给反悔机会，老行为）；
   * >0 = 显示环形进度 + 可取消，留出反应时间。
   */
  skipCountdown: number
  /**
   * 播放器右上角常驻显示「当前时间 / 总时长」。
   *
   * 电视上控制栏会自动隐藏，想知道播到哪就得按键唤出——加这个开关让
   * 想随时看进度的人可以常驻。默认关，避免挡画面。
   */
  showTimeBadge: boolean
  /** 播放器最底部常驻一条细进度条（不唤控制栏也能看到位置）。默认关。 */
  showMiniProgress: boolean
  /** 上次使用的音量 0 ~ 1，进播放页时恢复 */
  volume: number
  /**
   * 是否静音，进播放页时恢复。
   *
   * 必须单独存：只靠 volume=0 表示静音的话，用户点静音按钮（volume 没变）
   * 切集后就会自动有声 —— 而切集会重建整个播放页实例。
   */
  muted: boolean
  /** 上次使用的倍速，进播放页时恢复 */
  rate: number

  /**
   * 直播：配置了多条源时合并成一个台列表（同名台合并成多线路）。
   *
   * 关掉就是旧行为——列出多个源、一次只用一条。默认开：实测两个源只有
   * 14 个台重叠（CCTV 系列），合并后 332+153 → 471 个台，而"同一个台多条
   * 线路"正好提高可播率（一个源挂了另一个还在）。
   */
  liveMerge: boolean

  // ---------------- 外观 ----------------

  /** 主题风格（八套，每套有浅/深两档，见 stores/theme.ts） */
  themeStyle: ThemeStyle
  /** 明暗偏好：浅色 / 深色 / 跟随系统 */
  themeMode: ThemeMode
  /** 背景图预设 id；'' = 不用背景 */
  wallpaper: string
  /** 背景模糊半径（px），0 = 不模糊 */
  wallpaperBlur: number
  /**
   * 壁纸可见度 0~1，越大背景越清晰（卡片越透）。
   *
   * 旧字段叫 wallpaperDim（"压暗"），语义是往壁纸上盖一层遮罩。
   * 但遮罩画在卡片**底下**，卡片本身不透明，所以调它用户只看到
   * "调了没反应" —— 真正的可调项是卡片自身的不透明度。
   */
  wallpaperOpacity: number

  // ---------------- 桌面端行为（仅 PC 设置页可见） ----------------

  /**
   * 点窗口 X 时隐藏到托盘（false = 直接退出应用）。
   *
   * 这是**设备本地**偏好：Rust 在 CloseRequested 里同步读
   * {appData}/desktop-prefs.json，前端启动与变更时通过
   * `desktop_set_close_to_tray` 把值同步过去。默认开。
   */
  closeToTray: boolean

  // ---- AI 助手（docs/47 §4.3）----
  //
  // 字段**平铺**在这里，不嵌套成 llm:{...}：Prefs 整体是平铺结构，
  // 嵌一层会让 savePrefs 的合并与跨端同步白名单都要特殊处理。
  // 安全水位与 WebDAV 密码相同（都是 localStorage 明文），不是新增风险。
  /** 是否启用模型；关掉时诊断照常工作，只是没有人话解释 */
  llmEnabled?: boolean
  /** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
  llmBaseUrl?: string
  llmApiKey?: string
  llmModel?: string
  llmTimeoutMs?: number
  llmMaxTokens?: number
  /**
   * 对话保留几轮上文（默认 5）。
   *
   * 没有上文时用户必须每句都把片名重说一遍——实测模型会直接回
   * "上一轮的片名不在当前上下文里，随便猜会播错片"。
   * 上限 10：再多就是每轮带全量历史，延迟和费用线性上涨。
   */
  llmHistoryRounds?: number
}

/**
 * 八套深色风格。放成联合类型而不是 string，是为了让
 * ThemeStyle 在别处（theme.ts / 设置页选项）能被类型检查约束。
 *
 * `miuix` 已移除（和 Claude 同为暖橙强调、且按钮对比度不达标）。
 * 老数据里还留着这个值时由 getPrefs() 迁到 claude，不能直接回落 meow ——
 * 用户会以为自己的主题被改了。
 */
export type ThemeStyle =
  | 'meow'
  | 'claude'
  | 'material'
  | 'nord'
  | 'tokyo'
  | 'catppuccin'
  | 'oled'
  | 'everforest'

/** 明暗偏好；system = 跟随操作系统 */
export type ThemeMode = 'light' | 'dark' | 'system'

export const DEFAULTS: Prefs = {
  updateSource: '',
  updateBackupSource: '',
  updateToken: '',
  autoCheckApp: true,
  autoCheckModule: true,
  autoCheckPlugins: true,
  autoCheckFpk: true,
  pluginUseAppSource: true,
  gitAccel: DEFAULT_GIT_ACCEL,
  homeCols: 6,
  danmaku: true,
  danmakuDensity: 'standard',
  danmakuOpacity: 0.9,
  danmakuScale: 1,
  danmakuDuration: 12,
  danmakuArea: 0.7,
  danmakuBlock: '',
  videoFit: 'contain',
  autoNextMode: 'countdown',
  autoNextDelay: 5,
  searchLayout: 'grid',
  searchThreads: 12,
  cacheDays: 1,
  historyLimit: 30,
  skipIntro: 0,
  skipOutro: 0,
  skipMiddle: false,
  skipCountdown: 5,
  showTimeBadge: false,
  showMiniProgress: false,
  volume: 1,
  muted: false,
  rate: 1,
  liveMerge: true,
  themeStyle: 'meow',
  themeMode: 'dark',
  // 默认无背景：背景图是可选装饰，首屏应该是干净的深色。
  // 想开的话在「设置 → 外观」里选，模糊/可见度会跟着生效。
  wallpaper: '',
  wallpaperBlur: 2,
  wallpaperOpacity: 0.2,
  // 桌面端：默认「关闭 = 最小化到托盘」，与绝大多数 PC 播放器的习惯一致。
  closeToTray: true,
  // AI 助手：默认关闭、不预填任何厂商。
  // 预填 key 是不可能的，但连 baseUrl 也不预填 —— 默认指向某家会让
  // "没配过"看起来像"配好了但不通"。用户必须自己去设置页选一家。
  llmEnabled: false,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  llmTimeoutMs: 8000,
  /*
   * 300 是"单句解释"的量，装不下编排的一轮：推理模型会把 300 全烧在思维链上，
   * 返回 content 为空、tool_calls 也为空，面板只能报"模型返回空内容"（2026-11-02 实测）。
   * 编排层另有硬下限（orchestrate 的 MIN_ROUND_TOKENS），这里只是把新装的默认值
   * 调到够用；老用户存的 300 由那条下限 + 一次翻倍重试兜住。
   */
  llmMaxTokens: 800,
  llmHistoryRounds: 5,
}

const KEY = 'meow.prefs'

/**
 * 弹幕密度档位 → 具体参数。
 *
 * 参数来自真实数据反推（见 Prefs.danmakuDensity 的注释）。
 * 标准档必须与历史默认（12s / 70%）完全一致，保证老用户升级后
 * 观感不变。
 */
export const DENSITY_PRESETS: Record<
  Exclude<Prefs['danmakuDensity'], 'custom'>,
  { duration: number; area: number }
> = {
  sparse: { duration: 18, area: 0.55 },
  standard: { duration: 12, area: 0.7 },
  dense: { duration: 9, area: 0.85 },
}

/** 把档位展开成 duration + area（custom 时返回 null，表示用现值） */
export function densityToParams(d: Prefs['danmakuDensity']): { duration: number; area: number } | null {
  if (d === 'custom') return null
  return DENSITY_PRESETS[d] || null
}

/** 从现存参数反推它属于哪一档（用于老数据迁移和 UI 显示） */
export function paramsToDensity(duration: number, area: number): Prefs['danmakuDensity'] {
  for (const [k, v] of Object.entries(DENSITY_PRESETS)) {
    if (Math.abs(v.duration - duration) < 0.01 && Math.abs(v.area - area) < 0.01) {
      return k as Prefs['danmakuDensity']
    }
  }
  return 'custom'
}

/** 兼容旧版本的散装键，迁移后写入新结构 */
const LEGACY: Record<string, keyof Prefs> = {
  'meow.homeCols': 'homeCols',
  'meow.danmaku': 'danmaku',
  'meow.cacheDays': 'cacheDays',
  'meow.history': 'historyLimit',
}

function readRaw(): Record<string, unknown> {
  try {
    const s = localStorage.getItem(KEY)
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

let cache: Prefs | null = null

/** 仅供测试：清掉内存缓存，让下次 getPrefs() 重新读 localStorage */
export function __resetPrefsCache(): void {
  cache = null
}

function migrate(): void {
  const raw = readRaw()
  let touched = false
  for (const [oldKey, field] of Object.entries(LEGACY)) {
    const v = localStorage.getItem(oldKey)
    if (v == null) continue
    if (raw[field] === undefined) {
      if (field === 'danmaku') raw[field] = v !== '0'
      else raw[field] = Number(v)
      touched = true
    }
    localStorage.removeItem(oldKey)
  }
  // v1 的 autoNext 是布尔值，v2 拆成三态。老用户开着就沿用"立即"，
  // 关着就沿用"不自动"，不要因为升级把行为悄悄改掉。
  if (typeof raw.autoNext === 'boolean' && raw.autoNextMode === undefined) {
    raw.autoNextMode = raw.autoNext ? 'countdown' : 'off'
    touched = true
  }
  delete raw.autoNext
  if (touched) localStorage.setItem(KEY, JSON.stringify(raw))
}

export function getPrefs(): Prefs {
  if (cache) return cache
  migrate()
  const raw = readRaw()
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS) as (keyof Prefs)[]) {
    const v = raw[k]
    if (v === undefined || v === null) continue
    if (typeof DEFAULTS[k] === 'boolean') {
      if (typeof v === 'boolean') out[k] = v as never
    } else if (typeof DEFAULTS[k] === 'number') {
      const n = Number(v)
      if (Number.isFinite(n)) out[k] = n as never
    } else if (typeof v === 'string') {
      if (typeof v === 'string') out[k] = v as never
    }
  }
  // GitHub 加速：嵌套对象，单独规范化（内置项补齐、非法前缀丢弃）
  out.gitAccel = normalizeGitAccel((raw as { gitAccel?: unknown }).gitAccel)
  // 枚举字段白名单
  if (!['contain', 'cover', 'fill'].includes(out.videoFit)) out.videoFit = 'contain'
  if (!['list', 'grid'].includes(out.searchLayout)) out.searchLayout = 'grid'
  if (!['immediate', 'countdown', 'off'].includes(out.autoNextMode)) out.autoNextMode = 'countdown'
  // 主题风格：非法值回落默认（老数据没有这个字段时也走这里）
  //
  // ★ miuix → claude 是一次显式迁移（2026-11-09 移除该风格）：
  //   它和 Claude 同为暖橙强调，且深色按钮白字只有 2.60:1。
  //   直接让白名单把它打成 meow 会让用户以为主题被重置。
  //   cast 是必须的：ThemeStyle 已经没有 miuix，但老数据里可能还有。
  if ((out.themeStyle as string) === 'miuix') out.themeStyle = 'claude'
  if (
    ![
      'meow',
      'claude',
      'material',
      'nord',
      'tokyo',
      'catppuccin',
      'oled',
      'everforest',
    ].includes(out.themeStyle)
  ) {
    out.themeStyle = 'meow'
  }
  if (!['light', 'dark', 'system'].includes(out.themeMode)) out.themeMode = 'system'
  // 背景：只接受内置预设 id，避免历史值 / 手改数据把界面搞白
  //
  // ★ 白名单来自 wallpapers.ts，不要再手写数组。
  // 踩过（2026-10-30 新增 5 张壁纸时）：这里原本硬编码
  // `['', 'cinema', 'aura', 'cat', 'custom']`，新 id 会被静默重置成
  // 'aura' —— 用户在设置页选了新图、刷新后又变回去，看起来像"没保存"。
  if (out.wallpaper !== 'custom' && !(WALLPAPER_IDS as readonly string[]).includes(out.wallpaper)) {
    out.wallpaper = 'aura'
  }
  // 密度档位：老数据没有这个字段，从现存的 duration/area 反推。
  //
  // ★ 必须查 raw 而不是 out：out 已经合过 DEFAULTS，
  // danmakuDensity 一定有值（'standard'），用白名单判断永远为真，
  // 反推逻辑就死了 —— 老用户手调过 17s/0.62 会被标成"标准"，
  // 下次点标准档还会覆盖他的值（实测踩过）。
  if (raw.danmakuDensity === undefined || !['sparse', 'standard', 'dense', 'custom'].includes(out.danmakuDensity)) {
    out.danmakuDensity = paramsToDensity(out.danmakuDuration, out.danmakuArea)
  }
  // 倒计时秒数收紧到 3–30
  const delay = Number(out.autoNextDelay)
  out.autoNextDelay = Number.isFinite(delay) ? Math.min(30, Math.max(3, Math.round(delay))) : 5
  // 背景模糊 0–20px、可见度 0–1
  const wb = Number(out.wallpaperBlur)
  out.wallpaperBlur = Number.isFinite(wb) ? Math.min(20, Math.max(0, Math.round(wb))) : 2
  const wo = Number(out.wallpaperOpacity)
  out.wallpaperOpacity = Number.isFinite(wo) ? Math.min(1, Math.max(0, wo)) : 0.2
  // 旧字段 wallpaperDim（"压暗"）→ 新字段 wallpaperOpacity（"可见度"）。
  // 语义相反：压暗 0.7 ≈ 可见度 0.3，所以用 1 - d 换算，老用户的观感基本不变。
  if (raw.wallpaperOpacity === undefined && raw.wallpaperDim !== undefined) {
    const d = Number(raw.wallpaperDim)
    if (Number.isFinite(d)) out.wallpaperOpacity = Math.min(1, Math.max(0, 1 - d))
  }
  // 迁移完顺手把旧键从存储里抹掉，否则它会一直跟着 meow.prefs
  // 进 WebDAV 备份、并在每台设备上重复出现。
  //
  // ★ 判断要查 raw（存储里的原始对象），不能查 out ——
  //   out 是从 DEFAULTS 展开的，DEFAULTS 里本来就没有 wallpaperDim，
  //   所以 `'wallpaperDim' in out` 永远为 false，清理逻辑等于死代码。
  //   主题迁移也一样：raw 里还是 miuix，写回后才是 claude。
  const dirty =
    'wallpaperDim' in raw || (raw as { themeStyle?: unknown }).themeStyle === 'miuix'
  // 跳过提示的倒计时：0 = 直接跳，否则 3–15 秒
  const scd = Number(out.skipCountdown)
  if (!Number.isFinite(scd) || scd < 0) out.skipCountdown = 5
  else out.skipCountdown = scd === 0 ? 0 : Math.min(15, Math.max(3, Math.round(scd)))
  cache = out
  if (dirty) {
    try {
      localStorage.setItem(KEY, JSON.stringify(out))
    } catch {
      /* 配额满：下次 savePrefs 时还会再试 */
    }
  }
  return out
}

/**
 * 合并写入。
 *
 * `silent` 用于音量/倍速这类"每拖一下都变"的高频项：只落 localStorage，
 * 不广播 `meow:prefs`。否则入口处的自动同步会被拖音量条刷屏。
 */
export function savePrefs(patch: Partial<Prefs>, opts: { silent?: boolean } = {}): Prefs {
  const next = { ...getPrefs(), ...patch }
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 配额满时忽略 */
  }
  if (opts.silent) return next
  // 通知各页面刷新（列数、弹幕样式等）
  window.dispatchEvent(new CustomEvent('meow:prefs', { detail: next }))
  return next
}

/** 单项写入，最常用 */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): Prefs {
  return savePrefs({ [key]: value } as Partial<Prefs>)
}

/**
 * 切换弹幕密度档位（同时写入 duration + area）。
 *
 * 两处 UI（设置页、播放器弹框）都走这里，保证口径一致。
 */
export function setDanmakuDensity(d: Prefs['danmakuDensity']): Prefs {
  const preset = densityToParams(d)
  if (!preset) return savePrefs({ danmakuDensity: 'custom' })
  return savePrefs({
    danmakuDensity: d,
    danmakuDuration: preset.duration,
    danmakuArea: preset.area,
  })
}

/**
 * 手动改「时长」或「区域」时调用：档位自动降级为 custom。
 *
 * 不这么做的话，用户把时长从 12 调到 8，界面还显示"标准"，
 * 下次切档位又会把它覆盖回去，很容易困惑。
 */
export function setDanmakuTuning(patch: { duration?: number; area?: number }): Prefs {
  const next = {
    ...(patch.duration !== undefined ? { danmakuDuration: patch.duration } : {}),
    ...(patch.area !== undefined ? { danmakuArea: patch.area } : {}),
  }
  const merged = { ...getPrefs(), ...next }
  return savePrefs({
    ...next,
    danmakuDensity: paramsToDensity(merged.danmakuDuration, merged.danmakuArea),
  })
}

// ---------------------------------------------------------------- WebDAV

/**
 * WebDAV 同步。
 *
 * 浏览器直连 WebDAV 会被 CORS 挡住（且 MKCOL/PUT 的预检多数服务器不支持），
 * 所以统一走后端 `/api/webdav` 转发。
 */
export interface WebdavConfig {
  enabled: boolean
  /** 根地址，例如 http://192.168.1.10:5005/mysyc */
  url: string
  user: string
  pass: string
  /** 存放子目录，默认 meow */
  dir: string
  /** 是否同步观看历史 */
  syncHistory: boolean
  /** 是否同步设置备份 */
  syncPrefs: boolean
  /** 是否同步搜索关键词历史 */
  syncSearchHistory: boolean
  /**
   * 是否备份片库配置（地址/账号/子目录，**不含密码**）。
   *
   * <p>默认关闭：片库连哪台 NAS 是每台设备的本地决定，默认跟着同步走会让
   * 「在公司打开」把家里的配置冲掉。用户主动打开才备份。
   */
  syncLibrary?: boolean
  lastSyncAt?: number
}

export const DEFAULT_WEBDAV: WebdavConfig = {
  enabled: false,
  url: '',
  user: '',
  pass: '',
  dir: 'meow',
  syncHistory: true,
  syncPrefs: true,
  syncSearchHistory: true,
  syncLibrary: false,
}

const WEBDAV_KEY = 'meow.webdav'

export function getWebdav(): WebdavConfig {
  try {
    const s = localStorage.getItem(WEBDAV_KEY)
    if (!s) return { ...DEFAULT_WEBDAV }
    return { ...DEFAULT_WEBDAV, ...JSON.parse(s) }
  } catch {
    return { ...DEFAULT_WEBDAV }
  }
}

export function saveWebdav(cfg: Partial<WebdavConfig>): WebdavConfig {
  const next = { ...getWebdav(), ...cfg }
  localStorage.setItem(WEBDAV_KEY, JSON.stringify(next))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('meow:webdav', { detail: next }))
  }
  return next
}

export interface Backup {
  version: 1
  exportedAt: number
  prefs: Prefs
  history: unknown[]
  /** 搜索关键词历史（去重后的最近若干条） */
  searchHistory?: string[]
  /** 收藏。老备份里没有这个字段，还原时保持本地不变（不能当成"清空收藏"）。 */
  favorites?: unknown[]
  /** 用户在用的源 */
  site?: string
  /**
   * 辅助数据：换机/重装后手工重建代价最高的几类。
   *
   * <p>它们不属于 `prefs`（不是设置项），也不属于 `history`（不该被
   * historyLimit 裁掉），但都只存在本机 localStorage —— 没有这一块，
   * 用户换台电视就发现"片头标记、追剧进度、观看统计全没了"。
   *
   * <p>还原语义一律是**只合并不删除**（见 applyBackup）：
   * 旧快照不能抹掉本机后来产生的新数据。
   */
  aux?: {
    /** 手动片头/片尾标记（site|vod_id → 秒数） */
    skipMarks?: Array<{ key: string; marks: { intro: number; outro: number; at: number } }>
    /** 线路偏好（site|vod_id → 线路名 + 选择时间） */
    linePrefs?: Record<string, { name: string; at: number }>
    /** 追剧基准（site|vod_id → 收藏时看到的 remarks） */
    favRemarks?: Record<string, string>
    /** 观看时长（'YYYY-MM-DD' → 秒） */
    watchDays?: Record<string, number>
  }
}

/**
 * 备份里**永远不能出现**的 prefs 字段。
 *
 * <p><b>为什么必须有一条这样的名单</b>（2026-10-30 审计发现的真实缺陷）：
 * `makeBackup` 原来是 `prefs: getPrefs()` 全量搬运，于是 `llmApiKey`
 * 被明文写进 WebDAV 快照、也被写进「导出备份」的 JSON —— 而设置页那句
 * 「Key 只存在本机…不进备份、不上传」写得明明白白，两边是相反的。
 * 用户把导出的 JSON 发给别人排障，就等于直接交出 Key。
 *
 * <p>用**黑名单**而不是白名单：prefs 会不断加字段，白名单式漏加一个
 * 新字段顶多"没备份"，而黑名单式漏加一个密钥字段就是泄密。
 * 所以这里只列敏感项，其余照旧全量走。
 *
 * <p><b>updateToken 也在这张名单里</b>（2026-11-12 审计）：私有仓访问令牌
 * 是 PAT，写进 NAS/云盘上的快照等于把仓库读写能力交给存储方。用户能接受
 * “备份丢了重填”，不能接受“备份泄露”。
 */
const SECRET_PREF_KEYS = ['llmApiKey', 'updateToken'] as const

/** 剥掉敏感字段，其余原样返回（导出/上传的唯一入口）。 */
export function redactPrefs(p: Prefs): Prefs {
  const out = { ...p } as Record<string, unknown>
  for (const k of SECRET_PREF_KEYS) delete out[k]
  // 先过 unknown 再转回 Prefs：Record<string, unknown> 与 Prefs 之间没有
  // 足够的重叠字段，直接断言会被 TS2352 拒绝。
  return out as unknown as Prefs
}

export function makeBackup(
  history: unknown[],
  searchHistory: string[] = [],
  favorites: unknown[] = [],
): Backup {
  return {
    version: 1,
    exportedAt: Date.now(),
    // ★ 绝不能是裸的 getPrefs()：那会把 llmApiKey 一起带上远端
    prefs: redactPrefs(getPrefs()),
    history,
    searchHistory,
    favorites,
    site: localStorage.getItem('meow.site') || undefined,
    aux: {
      skipMarks: listSkipMarks(),
      linePrefs: exportLinePrefs(),
      favRemarks: exportSeenRemarks(),
      watchDays: getWatchStats().days,
    },
  }
}

/**
 * 还原一份备份。
 *
 * @param opts.prefsOnly true = **只还原设置**，不动历史/收藏/源。
 *
 * <p><b>为什么要这个开关</b>（2026-10-30 审计）：设置页「还原到某个时间点」
 * 的确认框写的是「会把这个时间点的设置覆盖到本地（**历史不受影响**）」，
 * 但 applyBackup 实际会 `setItem('meow.history.list', b.history)` ——
 * 换机时挑一份旧快照还原，刚拉下来的历史直接被冲掉。文案与行为相反，
 * 而且丢失的是用户数据。
 *
 * <p>现在：设置页还原传 `prefsOnly: true`（与文案一致）；
 * 「导入备份文件」仍走全量（那是用户明确要恢复一整份备份）。
 */
export function applyBackup(
  b: Partial<Backup>,
  opts: { prefsOnly?: boolean } = {},
): boolean {
  if (!b || typeof b !== 'object') return false
  if (b.prefs && typeof b.prefs === 'object') {
    /*
     * 还原时保留本机 Key：备份里已经没有它了（见 SECRET_PREF_KEYS），
     * 若照抄 prefs 会把 Key 抹成 undefined —— 用户换机还原后 AI 突然不可用，
     * 还得重新去申请/粘一遍 Key。
     *
     * 即使还原的是**老版本导出的、含 Key 的**备份，也不采纳那份 Key：
     * 那份文件已经在外面流转过，不该再被当成可信来源。
     */
    const patch = { ...(b.prefs as Partial<Prefs>) }
    delete (patch as Record<string, unknown>).llmApiKey
    delete (patch as Record<string, unknown>).updateToken
    savePrefs(patch)
  }
  // 辅助数据：只合并不删除（旧快照不许抹掉本机后来产生的标记/统计）。
  // 放在 prefsOnly 的 return 之前——设置页「还原到某个时间点」也该带回它们。
  if (b.aux && typeof b.aux === 'object') {
    const aux = b.aux
    if (Array.isArray(aux.skipMarks)) mergeSkipMarks(aux.skipMarks)
    if (aux.linePrefs && typeof aux.linePrefs === 'object') mergeLinePrefs(aux.linePrefs)
    if (aux.favRemarks && typeof aux.favRemarks === 'object') mergeSeenRemarks(aux.favRemarks)
    if (aux.watchDays && typeof aux.watchDays === 'object') mergeWatchDays(aux.watchDays)
  }
  if (opts.prefsOnly) return true
  if (Array.isArray(b.history)) {
    localStorage.setItem('meow.history.list', JSON.stringify(b.history))
  }
  if (Array.isArray(b.searchHistory)) {
    localStorage.setItem('meow.search.history', JSON.stringify(b.searchHistory))
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('meow:search-history'))
    }
  }
  // 只有备份里**确实带了** favorites 才覆盖。老备份没有这个字段，
  // 若按"缺失即清空"处理，用户还原一份旧备份就会把现有收藏全删掉。
  if (Array.isArray(b.favorites)) {
    replaceFavorites(b.favorites as never[])
  }
  if (typeof b.site === 'string' && b.site) localStorage.setItem('meow.site', b.site)
  return true
}

/**
 * 把后端透出的网络异常翻译成人话。
 *
 * <p>原来直接把 Java 异常拼给用户看（`IOException: unexpected end of stream
 * on http://…`），普通用户无法判断是地址写错、服务没开还是网络不通。
 * 保留原始信息（截断 80 字）供排查，但结论先给人话。
 */
export function friendlyDavError(raw?: string): string {
  const msg = (raw || '').trim()
  const lower = msg.toLowerCase()
  const hint = /unknownhost|failed to connect|connectexception|connection refused|sockettimeout|unexpected end of stream|sslhandshake|econnrefused|timeout/.test(
    lower,
  )
    ? '连不上 WebDAV 服务器（检查地址、端口、服务是否在运行）'
    : ''
  if (!hint) return msg || '连接失败'
  return msg ? `${hint}｜${msg.slice(0, 80)}` : hint
}

/** 连接测试：对目录发 PROPFIND */
export async function webdavPing(
  apiBase: string,
  cfg: WebdavConfig,
): Promise<{ ok: boolean; status: number; msg: string }> {
  try {
    const base = cfg.url.replace(/\/$/, '')
    const dir = cfg.dir.replace(/^\/|\/$/g, '')
    const url = `${base}/${dir}`
    const res = await fetch(`${apiBase}/api/webdav`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        method: 'PROPFIND',
        user: cfg.user,
        pass: cfg.pass,
        depth: '1',
      }),
    })
    if (!res.ok) return { ok: false, status: res.status, msg: `代理错误 ${res.status}` }
    const r = (await res.json()) as { ok: boolean; status: number; body: string; msg?: string }
    // ★ status=0 是代理层失败（后端连不上/超时），不是 WebDAV 的响应码。
    //   不先拦住它，`0 < 300` 会让「地址写错」显示成「连接成功」——
    //   用户以为配置没问题，等到上传才报错，排查方向全错（2026-11-12 实测）。
    if (r.status === 0) {
      return {
        ok: false,
        status: 0,
        msg: friendlyDavError(r.msg),
      }
    }
    if (r.status < 300) {
      // 数一下目录里已有几个文件，用户能直观看到同步状态。
      // 前缀大小写随服务器（D: / d: / dav:），不能只认 <D:href>——
      // SabreDAV / Nextcloud 返回小写，会被误报成「空目录」。
      const files = (r.body.match(/<(?:\w+:)?href>/gi) || []).length
      const existing = files > 1 ? (files - 1) + ' 个文件' : '空目录'
      return { ok: true, status: r.status, msg: `连接成功（${existing}）` }
    }
    const hint =
      r.status === 401
        ? '认证失败（检查用户名/密码）'
        : r.status === 404
          ? '目录不存在（会自动创建，可直接上传）'
          : `HTTP ${r.status}`
    return { ok: false, status: r.status, msg: hint }
  } catch (e: any) {
    return { ok: false, status: 0, msg: friendlyDavError(e?.message || String(e)) }
  }
}
