/**
 * TV 端原生能力桥。
 *
 * ## 为什么要有这一层
 *
 * 电视上的 WebView 解码能力受盒子固件限制：HEVC/AV1 常不解、Dolby 音轨无声、
 * 4K 掉帧。同一台机器上 ExoPlayer 走 MediaCodec 往往能播。
 *
 * 但"能不能播"只有**试了才知道**——设备能力表不可靠（某些盒子谎报支持）。
 * 所以策略是：WebView 先播，失败了再让原生兜底，而不是一上来就猜。
 *
 * ## 探测方式
 *
 * TV 壳通过 `addJavascriptInterface` 注入 `window.meowTv`。
 * **必须用 typeof 判断而不是 `if (window.meowTv)`**：
 * 旧版本 WebView 在没有该接口时访问 window.meowTv 会抛异常。
 */

import { isDesktop, tauriInvoke } from './index'

interface MeowTvBridge {
  nativePlayerAvailable(): boolean
  openNative(url: string, title: string, headers: string, positionMs: number): boolean
  platform(): string
  appVersion(): string
  /**
   * 弹原生输入框（遥控器打字的唯一方式）。取消返回 null。
   * 第四参 theme 是 JSON（见 nativeInputText），老壳会忽略多余参数。
   */
  inputText?(title: string, initial: string, mask: boolean, theme?: string): string | null
  /**
   * 把当前主题推给壳，供「原生页面」使用（TV 配置页没有 WebView，读不到 CSS）。
   * 老壳没有这个方法，调用处静默跳过。
   */
  setUiTheme?(json: string): void
}

/**
 * 把当前主题的配色打包给原生输入框。
 *
 * 为什么要传：原生 AlertDialog 默认是系统灰底（深色主题下也是一块浅灰），
 * 和页面/播放器放在一起像另一个应用。Java 侧读不到 Web 的 CSS 变量，
 * 所以由页面把实际生效的颜色读出来传过去。
 *
 * 读的是 `getComputedStyle(document.documentElement)`——它拿到的是**当前
 * 生效值**（主题切换靠 html 上的 data-style/data-mode 选择器，变量值会随之
 * 变化），不是 tokens.css 里那份默认值。八套主题（meow/claude/… × dark/light）
 * 全都自动跟随，不用在 Java 里再抄一份色板。
 */
function themePayload(): string {
  try {
    const cs = getComputedStyle(document.documentElement)
    const pick = (name: string, fallback: string) => (cs.getPropertyValue(name) || '').trim() || fallback
    return JSON.stringify({
      base: pick('--color-base', '#12141d'),
      elevated: pick('--color-elevated', '#242838'),
      panel: pick('--color-panel', '#2e3346'),
      accent: pick('--color-accent', '#03dac5'),
      onAccent: pick('--color-on-accent', '#0a0b11'),
      ink: pick('--color-ink', '#ffffff'),
      ink2: pick('--color-ink-2', '#b8bdcc'),
      ink3: pick('--color-ink-3', '#7a8095'),
      warn: pick('--color-warn', '#ff5f00'),
      hot: pick('--color-hot', '#ff0057'),
      line: pick('--color-line-hover', 'rgba(255,255,255,0.12)'),
      field: pick('--color-field', 'rgba(0,0,0,0.3)'),
      radius: pick('--radius-lg', '14px'),
      light: document.documentElement.getAttribute('data-mode') === 'light',
    })
  } catch {
    return ''
  }
}

/** 当前是否跑在 TV 壳里（有原生桥） */
export function hasNativePlayer(): boolean {
  try {
    const b = (window as unknown as { meowTv?: MeowTvBridge }).meowTv
    return !!b && typeof b.openNative === 'function' && b.nativePlayerAvailable()
  } catch {
    return false
  }
}

/** 是否支持原生输入框（TV 壳 0.9.24+；老壳没有这个方法） */
export function hasNativeInput(): boolean {
  try {
    const b = (window as unknown as { meowTv?: MeowTvBridge }).meowTv
    return !!b && typeof b.inputText === 'function'
  } catch {
    return false
  }
}

/**
 * 弹原生输入框，返回用户输入的文本；取消或不可用返回 null。
 *
 * TV 上没有键盘：页面里的 `<input>` 拿到的是 tv-nav 的 `click()`，
 * 而 WebView 只对**真实触摸**弹输入法 —— 所以必须借原生对话框。
 * PC/Web 不走这里（它们的 input 本来就能打字）。
 *
 * 同步阻塞：原生侧用 CountDownLatch 等用户输完，这里直接拿到结果。
 */
export function nativeInputText(title: string, initial = '', mask = false): string | null {
  try {
    const b = (window as unknown as { meowTv?: MeowTvBridge }).meowTv
    if (!b || typeof b.inputText !== 'function') return null
    const r = b.inputText(title, initial, mask, themePayload())
    return typeof r === 'string' ? r : null
  } catch {
    return null
  }
}

/**
 * 这个输入框会不会被软键盘遮住 → 该不该弹原生输入框。
 *
 * 判据是几何位置，与 tv-nav 里 `needsNativeInput` 完全一致（两处必须同源，
 * 否则同一个输入框在"页面接管"和"tv-nav 接管"两条路径上行为不同）：
 * 输入法从底部推起，约占视口下 40%；输入框**底部**越过中线就算可能被遮。
 *
 * 页面侧要用这个而不是硬编码：搜索页的框在上方（bottom≈162 / vh=720），
 * 原生框纯属多一步；AI 面板的框贴在屏幕最底部，必须弹原生框。
 */
export function shouldUseNativeInput(el: Element | null): boolean {
  if (!el) return true
  if (el.hasAttribute('data-tv-native-input')) return true
  const vh = window.innerHeight || document.documentElement.clientHeight || 0
  if (!vh) return true
  return el.getBoundingClientRect().bottom > vh * 0.5
}

/**
 * 就地输入：聚焦页面上的输入框 + 让原生补一次系统输入法。
 *
 * 为什么必须由原生补：WebView 只对**真实触摸**弹输入法，遥控器 OK 不会。
 * 少了这一步，用户看到的是"有焦点框但打不了字"（这正是把输入框
 * 做成原生对话框的起因，但上方输入框不该付那个代价）。
 */
export function beginInlineInput(el: HTMLElement | null): void {
  /*
   * data-tv-ime 是给原生侧找目标用的标记。
   *
   * 为什么需要：原生 showIme() 要先让 WebView 拿到窗口焦点、再重新
   * focus 一次页面元素（顺序反了就只是"输入法弹出来但打不进字"）。
   * 那一秒里 page 侧的 activeElement 可能已经变了（实测成了 <a>），
   * 所以给个稳定标记，让原生按标记找，而不是依赖 activeElement。
   */
  if (el) {
    try {
      const prev = document.querySelector('[data-tv-ime]')
      if (prev && prev !== el) prev.removeAttribute('data-tv-ime')
      el.setAttribute('data-tv-ime', '1')
    } catch {
      /* 属性设置失败不影响后续 */
    }
  }
  try {
    el?.focus()
  } catch {
    /* 不可聚焦就算了 */
  }
  try {
    const b = (window as unknown as { meowTv?: { showIme?: () => boolean } }).meowTv
    if (b && typeof b.showIme === 'function') b.showIme()
  } catch {
    /* 老壳没有这个方法：退化成只有聚焦 */
  }
}

/** 当前平台标识（web / tv）；非 TV 返回 'web' */
export function platformName(): string {
  try {
    const b = (window as unknown as { meowTv?: MeowTvBridge }).meowTv
    return b && typeof b.platform === 'function' ? b.platform() : 'web'
  } catch {
    return 'web'
  }
}

/** 请求头 → 原生侧要的 `k=v&k=v`（值 URL 编码，避免值里的 & 破坏分隔） */
function encodeHeaders(header: unknown): string {
  let obj: Record<string, string> = {}
  if (typeof header === 'string' && header.trim()) {
    try {
      const parsed = JSON.parse(header)
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, string>
    } catch {
      /* 坏 JSON 就当没有头 */
    }
  } else if (header && typeof header === 'object') {
    obj = header as Record<string, string>
  }
  const pairs: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string' || !v) continue
    // 头名里不会有 & =，值可能有（如 Cookie），所以值必须编码
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return pairs.join('&')
}

/**
 * 用原生播放器打开。返回 false 表示没拉起来（不是 TV、桥坏了、参数非法），
 * 调用方应退回 WebView 播放。
 */
export function openNative(
  url: string,
  title: string,
  header?: unknown,
  positionSec = 0,
): boolean {
  if (!url || !/^https?:/i.test(url)) return false
  try {
    const b = (window as unknown as { meowTv?: MeowTvBridge }).meowTv
    if (!b || typeof b.openNative !== 'function') return false
    const headers = encodeHeaders(header)
    return b.openNative(url, title || '', headers, Math.max(0, Math.round(positionSec * 1000)))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 系统睡眠

/**
 * 当前环境是否可能支持"让系统睡眠"。
 *
 * 只有 Tauri 桌面端有这条命令；Web / TV 一律返回 false（TV 的 DEVICE_POWER
 * 要系统签名，普通应用拿不到，所以不尝试）。
 *
 * 这里只能判断环境，**判断不了命令是否真的存在**——比桌面端更老的安装包
 * 没有 system_sleep，invoke 会 reject，由 systemSleep() 吞掉返回 false。
 */
export function hasSystemSleep(): boolean {
  if (!isDesktop()) return false
  try {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke?: unknown }
      __TAURI__?: { core?: { invoke?: unknown } }
    }
    return typeof w.__TAURI_INTERNALS__?.invoke === 'function'
      || typeof w.__TAURI__?.core?.invoke === 'function'
  } catch {
    return false
  }
}

/**
 * 请求系统进入睡眠（桌面端）。返回 false 表示当前端不支持或调用失败。
 *
 * 失败是正常形态：Web/TV 没有这条命令；Windows 开了休眠的系统会改成休眠
 * 而不是睡眠（powrprof 的固有行为，见 docs/38）。调用方不应把它当致命错误。
 */
export async function systemSleep(): Promise<boolean> {
  if (!hasSystemSleep()) return false
  try {
    await tauriInvoke<void>('system_sleep')
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 片库本地副本（TV）
//
// 片库数据全来自后端（NAS）。断网或 NAS 重启时海报墙会变灰，而"用 NAS 库"
// 的目的恰恰是局域网脱网访问。TV 壳提供了私有目录（`files/library/`）做只读副本：
// 后端给出的数据顺手存一份，后端不可达时拿出来用。
//
// ★ 只读副本，不是独立数据源：永远后端优先，这些方法只在拉不到时兜底。

interface MeowTvMirror {
  saveMetaMirror?(json: string): boolean
  loadMetaMirror?(): string
  cachePoster?(url: string): string
  posterMirrorBase?(): string
  metaMirrorStats?(): string
  clearMetaMirror?(): boolean
}

function mirrorBridge(): MeowTvMirror | null {
  try {
    const b = (window as unknown as { meowTv?: MeowTvMirror }).meowTv
    return b && typeof b.saveMetaMirror === 'function' ? b : null
  } catch {
    return null
  }
}

/** 当前端是否支持片库本地副本（TV 壳 0.9.26+） */
export function hasMetaMirror(): boolean {
  return mirrorBridge() !== null
}

/** 存一份元数据快照（后端返回的原始 JSON 文本） */
export function saveMetaMirror(json: string): boolean {
  const b = mirrorBridge()
  if (!b?.saveMetaMirror) return false
  try {
    return !!b.saveMetaMirror(json)
  } catch {
    return false
  }
}

/** 读本地元数据快照；没有返回空串 */
export function loadMetaMirror(): string {
  const b = mirrorBridge()
  if (!b?.loadMetaMirror) return ''
  try {
    return b.loadMetaMirror() || ''
  } catch {
    return ''
  }
}

/** 让原生把一张海报存到本地，返回文件名（失败空串） */
export function cachePoster(url: string): string {
  const b = mirrorBridge()
  if (!b?.cachePoster) return ''
  try {
    return b.cachePoster(url) || ''
  } catch {
    return ''
  }
}

/** 本地副本的访问前缀，如 `http://meow.local/mirror/poster/` */
export function posterMirrorBase(): string {
  const b = mirrorBridge()
  if (!b?.posterMirrorBase) return ''
  try {
    return b.posterMirrorBase() || ''
  } catch {
    return ''
  }
}

/** 清空本地副本（设置页用） */
export function clearMetaMirror(): boolean {
  const b = mirrorBridge()
  if (!b?.clearMetaMirror) return false
  try {
    return !!b.clearMetaMirror()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 系统音量 / 亮度（2026-11-03）

/**
 * 系统级音量与亮度。
 *
 * <p><b>为什么必须走原生</b>（用户明确要求"亮度、音量都走系统级"）：
 * <ul>
 *   <li><b>亮度</b>：Web 只有 CSS `filter: brightness()`，**只能变暗**（0–1），
 *       调不亮；而手机上用户最常做的就是"太暗了调亮"。真正的系统亮度
 *       要 `WindowManager.LayoutParams.screenBrightness`（Android）/
 *       `UIScreen.main.brightness`（iOS），浏览器两者都没有。</li>
 *   <li><b>音量</b>：TV 端已经把遥控器音量键旁路掉了（只保留静音），
 *       页面上再没有别的入口；而 `video.volume` 是**元素音量**，
 *       用户调完退出应用会发现"系统音量没变"。要靠
 *       `AudioManager.STREAM_MUSIC`。</li>
 * </ul>
 *
 * <p><b>接口设计成"读当前值 + 设当前值"而不是"加/减一步"</b>：
 * 手势是连续的（拖动多少像素就变多少），如果只给 step 接口，页面要自己
 * 记绝对值，一旦系统侧被别的应用改了就会漂。读回来再写回去才能对齐。
 */
interface MeowTvSystemCtl {
  /** 系统媒体音量 0–100；读不到返回 -1 */
  getVolume?(): number
  /** 设系统媒体音量 0–100；成功返回 true */
  setVolume?(v: number): boolean
  /** 屏幕亮度 0–100；-1 = 自动/读不到 */
  getBrightness?(): number
  /** 设屏幕亮度 0–100（100 及以上转成"跟随系统自动"）；成功返回 true */
  setBrightness?(v: number): boolean
}

function systemCtl(): MeowTvSystemCtl | null {
  try {
    const b = (window as unknown as { meowTv?: MeowTvSystemCtl }).meowTv
    if (!b || typeof b.setVolume !== 'function') return null
    return b
  } catch {
    return null
  }
}

/** 这个环境能不能调系统音量/亮度（TV 壳 1.0.6+；浏览器/PC 都返回 false） */
export function hasSystemVolume(): boolean {
  const b = systemCtl()
  return !!b && typeof b.getVolume === 'function' && typeof b.setVolume === 'function'
}

export function hasSystemBrightness(): boolean {
  const b = systemCtl()
  return !!b && typeof b.getBrightness === 'function' && typeof b.setBrightness === 'function'
}

/** 读系统音量（0–100）；不可用返回 null */
export function systemVolume(): number | null {
  const b = systemCtl()
  if (!b?.getVolume) return null
  try {
    const v = Number(b.getVolume())
    return Number.isFinite(v) && v >= 0 ? Math.min(100, Math.round(v)) : null
  } catch {
    return null
  }
}

/** 设系统音量（0–100）；不可用或失败返回 false */
export function setSystemVolume(v: number): boolean {
  const b = systemCtl()
  if (!b?.setVolume) return false
  try {
    return !!b.setVolume(Math.max(0, Math.min(100, Math.round(v))))
  } catch {
    return false
  }
}

/** 读屏幕亮度（0–100）；-1（自动）或不可用都返回 null */
export function systemBrightness(): number | null {
  const b = systemCtl()
  if (!b?.getBrightness) return null
  try {
    const v = Number(b.getBrightness())
    return Number.isFinite(v) && v >= 0 ? Math.min(100, Math.round(v)) : null
  } catch {
    return null
  }
}

/** 设屏幕亮度（0–100）；不可用或失败返回 false */
export function setSystemBrightness(v: number): boolean {
  const b = systemCtl()
  if (!b?.setBrightness) return false
  try {
    return !!b.setBrightness(Math.max(0, Math.min(100, Math.round(v))))
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ 输入状态同步 */

/**
 * 把「页面里是否有输入框正在聚焦编辑」推给 TV 壳。
 *
 * <p><b>为什么必须由页面推</b>（2026-11-03，修「输入法打字时方向键被壳吃掉」）：
 * 壳的 `dispatchKeyEvent` 是同步的，`evaluateJavascript` 是异步的，
 * 它没办法在按键那一刻知道 activeElement 是不是输入框。不判断的后果：
 * 用户在搜索框里输入时，方向键被壳拿去搬焦点（焦点跳到历史胶囊），
 * 再按 OK 就点到背景；输入法里也没法用方向键选词。
 *
 * <p>推的时机只有焦点变化，开销可忽略；壳侧读一个 volatile 字段。
 * 没有 `setEditing`（Web/PC/TV 旧包）时整段静默跳过。
 */
function syncEditingToShell(): void {
  const b = (window as unknown as { meowTv?: { setEditing?: (v: boolean) => void } }).meowTv
  if (!b || typeof b.setEditing !== 'function') return
  const editable = (el: Element | null): boolean => {
    if (!el) return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable
  }
  const push = (v: boolean) => {
    try {
      b.setEditing?.(v)
    } catch {
      /* 桥调用失败不该影响页面 */
    }
  }
  document.addEventListener('focusin', (e) => push(editable(e.target as Element)), true)
  document.addEventListener(
    'focusout',
    () => {
      // focusout 派发时 activeElement 还没切换，下一帧再读
      window.setTimeout(() => push(editable(document.activeElement)), 0)
    },
    true,
  )
  // 首帧可能已经有焦点（例如页面恢复时输入框是 activeElement）
  push(editable(document.activeElement))
}

if (typeof document !== 'undefined') syncEditingToShell()

/**
 * 把当前主题推给原生壳。
 *
 * <p><b>两个消费者</b>：
 * <ul>
 *   <li>TV：`setUiTheme(json)` 存进 SharedPreferences，配置页（没有 WebView，
 *       读不到 CSS 变量）下次打开时用这份色板，不再写死 #0e0f12/#14bfa8；</li>
 *   <li>PC：`desktop_set_window_bg` 改 Tauri 窗口底色。窗口在 WebView
 *       首帧之前/缩放时会露出这层底色，写死在 tauri.conf.json 里会在浅色
 *       主题下闪一块深 navy。</li>
 * </ul>
 * 两个都是可选能力：老壳 / Web 端静默跳过。
 */
function pushThemeToShell(): void {
  const json = themePayload()
  if (!json) return
  try {
    const b = (window as unknown as { meowTv?: { setUiTheme?: (v: string) => void } }).meowTv
    if (b && typeof b.setUiTheme === 'function') b.setUiTheme(json)
  } catch {
    /* 桥调用失败不该影响页面 */
  }

  if (!isDesktop()) return
  try {
    const base = (getComputedStyle(document.documentElement)
      .getPropertyValue('--color-base') || '').trim()
    if (/^#[0-9a-f]{6}$/i.test(base)) {
      // Tauri 命令可能不存在（旧版本壳），失败就算了
      void Promise.resolve(tauriInvoke('desktop_set_window_bg', { color: base })).catch(() => {})
    }
  } catch {
    /* 忽略 */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('meow:theme', pushThemeToShell)
  // 首帧补推一次：applyTheme 可能在模块加载前已经跑过（installThemeWatcher
  // 在 main.ts 很早的位置），那时的事件本模块收不到。
  pushThemeToShell()
}
