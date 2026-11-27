/**
 * 应用更新的共享状态（设置页 + 启动弹框 + 将来的提示条）。
 *
 * ## 为什么必须抽成 store
 *
 * 原来全部状态是 `SettingsView.vue` 里的页内 `ref`（`updChecking` /
 * `updFound` / `updChecked` / `updError` / `updReady`）。启动时自动检查要
 * 在 `App.vue` 里跑，和设置页是**两棵组件树**——同一个 ref 拿不到，
 * 各留一份则会出现「弹框说发现 0.9.38、设置页仍显示已是最新」。
 *
 * 轮询进度也必须只有一处：两处同时 `setInterval` 会让百分比互相覆盖
 * （TV 上实测数字乱跳）。
 *
 * ## 为什么不塞进 prefs
 *
 * `prefs` 是用户可见、可导出、会被 WebDAV 同步的设置项。这里的
 * 「检查中 / 已发现 / 下载进度」是运行时状态，写进去会让设置备份带上
 * 一个毫无意义的 `percent`，且换设备时会同步过去一个假进度。
 *
 * ## 状态机
 *
 * ```
 * idle ──check()──> checking ──有新版──> found ──download()──> busy ──> ready
 *                      └──无新版──> checked(已是最新)              └──> failed
 *                      └──异常──>  error
 * ```
 *
 * `ready` 之后仍停在 `found`（`found` 保留版本信息，界面要靠它显示"安装"）。
 */

import { computed, ref } from 'vue'
import { markShell } from '@/compat/deviceProfile'
import {
  checkAppUpdate,
  checkIosAppUpdate,
  currentPlatform,
  currentVersion,
  isIosUpdateShell,
  isVersionSkipped,
  readProgress,
  skipVersion as skipVersionLs,
  startDownload,
  installDownloaded,
  cancelDownload,
  type AppUpdate,
} from '@/api/appUpdate'
import {
  checkFpkUpdate,
  detectFpkShell,
  fpkFileName,
  fpkIsVersionSkipped,
  fpkSkipVersion,
  runFpkUpgrade,
  waitForRestart,
  type FpkLatest,
  type FpkProgress,
  type FpkShellInfo,
  type InstalledApp,
} from '@/api/fpkUpgrade'

/** 检查中（防重复点击 / 防启动自动检查与手动检查并发） */
export const checking = ref(false)
/** 下载或安装中 */
export const busy = ref(false)
/** 至少完成过一次检查（用于区分"没查过"与"查了没新版"） */
export const checked = ref(false)
/** 检查或下载的错误信息；空串表示无错 */
export const error = ref('')
/** 发现的新版本；null 表示没有 */
export const found = ref<AppUpdate | null>(null)
/** 下载百分比 0–100 */
export const percent = ref(0)
/** 阶段文案（下载中 / 校验中 / 安装中） */
export const stage = ref('')
/**
 * 阶段：idle | downloading | installing | done。
 *
 * <p><b>为什么要有它（2026-11-13）</b>：原来只有 `busy` 一个布尔，
 * 分不清"在下"和"在装"，于是取消按钮在安装阶段仍显示「取消下载」，
 * 弹框也分不清该不该自动收起。用户口径是**一步到位**：
 * 下载完直接调起安装器，界面上不再出现第二次「安装」按钮。
 */
export const phase = ref<'idle' | 'downloading' | 'installing' | 'done'>('idle')
/** 兼容旧调用点：已下载校验通过（只在"即将安装"的那一瞬为真） */
export const ready = ref(false)
/**
 * 弹框是否打开。
 *
 * <p>放 store 而不是组件局部：TV 的返回键由 `App.vue` 的
 * `__meowTvConsumeBack` 统一接管，它需要知道"现在有没有弹框要关"，
 * 才能决定这一下返回是关弹框还是走「再按一次退出」。
 * 组件内部判断不跨树，拿不到这个状态。
 */
export const dialogOpen = ref(false)
/**
 * 「有更新待提示，但还没弹出来」。
 *
 * <p>为什么需要它而不是直接开弹框：启动检查可能在**播放页**命中新版，
 * 那时弹框会盖住正在放的画面。所以检查只把这里置 true，
 * 由 `App.vue` 在路由允许（非播放/直播）时再开。
 *
 * <p>用户点「稍后」会清掉它——否则关掉后 watcher 会立刻重开。
 */
export const promptPending = ref(false)

/** 当前平台（决定提示哪些 id；web 端没有"安装包"概念） */
export const platform = computed(() => currentPlatform())

/**
 * 这一端能装哪种更新。`null` = 还没探测完。
 *
 * <p><b>为什么不是 `platform !== 'web'`（2026-11-16）</b>：fnOS 的 fpk 应用
 * 也是「装了就能升级的完整应用」，只是它跑在浏览器里。按平台字符串判会把
 * fnOS 一并排除——弹框永远不出现。现在按**能力**判：
 *   · PC（Tauri）/ TV（原生桥）→ `shell`（同步可判）；
 *   · 其余页面 → 探一次 `detectFpkShell()`（`/api/_shell/*` + `/app-center/*` 同源）
 *     → 通了就是 `fpk`；
 *   · 都不通（普通浏览器直连 30010）→ `none`。
 */
export type UpdateCapability = 'shell' | 'fpk' | 'ios' | 'none'
export const capability = ref<UpdateCapability | null>(null)
/** 当前这条更新属于哪条通道（决定标题/文件名/安装动作） */
export const kind = ref<'shell' | 'fpk' | 'ios'>('shell')
/** 本端能不能拿到更新信息（PC / TV / fnOS / iOS 侧载 IPA 都可以；ios 只提示不下载） */
export const canUpdate = computed(
  () => capability.value === 'ios' || capability.value === 'shell' || capability.value === 'fpk',
)

/** fpk 检查结果的缓存（安装时要用到 info/installed/latest 三件套） */
export const fpkInfo = ref<FpkShellInfo | null>(null)
export const fpkInstalled = ref<InstalledApp | null>(null)
export const fpkLatest = ref<FpkLatest | null>(null)
export const fpkCurrent = ref('')

let capabilityPromise: Promise<UpdateCapability> | null = null

/**
 * 探测本端的更新能力（结果缓存，整个会话只探一次）。
 *
 * <p>探测失败不抛：普通浏览器直连 `:30010` 时 `/app-center/*` 不通，
 * 属于正常情况，返回 `none` 即可，界面不会出现永远灰着的按钮。
 *
 * @param force 手动「检查更新」时允许重探一次：启动瞬间应用中心可能还没就绪，
 *              一次探测失败不能把整个会话的更新入口永久关掉。
 */
export function probeCapability(force = false): Promise<UpdateCapability> {
  if (force) capabilityPromise = null
  if (capabilityPromise) return capabilityPromise
  capabilityPromise = (async () => {
    // iOS 先判：它的 currentPlatform() 仍是 'web'（没有 PC/TV 那种原生更新桥），
    // 但走侧载商店源这条独立通道（只提示 + 给链接，不能自装 IPA）。
    if (isIosUpdateShell()) {
      capability.value = 'ios'
      kind.value = 'ios'
      return 'ios'
    }
    if (currentPlatform() !== 'web') {
      capability.value = 'shell'
      kind.value = 'shell'
      return 'shell'
    }
    try {
      const det = await detectFpkShell()
      if (det) {
        capability.value = 'fpk'
        kind.value = 'fpk'
        fpkInfo.value = det.info
        fpkInstalled.value = det.installed
        // 壳身份补写（data-shell）：fpk 是异步探测出来的，set 一次即可。
        markShell('fpk')
        return 'fpk'
      }
    } catch {
      /* 落 none */
    }
    capability.value = 'none'
    return 'none'
  })()
  return capabilityPromise
}

/** 进行中任务的定时器（模块级：跨组件只有一份轮询） */
let pollTimer: number | undefined

function stopPoll(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

/** 把「发现新版本」之外的状态全部复位（不清 found 之外的成果） */
function resetCheckState(): void {
  error.value = ''
  found.value = null
  checked.value = false
  ready.value = false
  percent.value = 0
  stage.value = ''
  phase.value = 'idle'
}

/**
 * 检查更新。
 *
 * @param opts.silent 启动自动检查用：出错不写 error（用户没主动问，
 *                    网络抖动不该在界面上留一条红字），
 *                    且「稍后」记过的版本直接跳过
 * @returns 找到的新版本；没有则 null
 */
export async function runCheck(opts: { silent?: boolean } = {}): Promise<AppUpdate | null> {
  // 手动检查时允许重探一次：启动瞬间应用中心可能还没就绪，
  // 一次探测失败不能把整个会话的更新入口永久关掉（静默检查不重探，
  // 免得每次启动都多打两次接口）。
  if (capability.value === null || (capability.value === 'none' && !opts.silent)) {
    capabilityPromise = null
    await probeCapability()
  }
  if (!canUpdate.value) return null
  if (kind.value === 'ios') return runCheckIos(opts)
  if (kind.value === 'fpk') return runCheckFpk(opts)
  if (checking.value) return found.value
  checking.value = true
  if (!opts.silent) resetCheckState()
  else error.value = ''
  try {
    const up = await checkAppUpdate()
    // 用户说过「这个版本稍后」：静默检查不弹框，但**仍记下发现** ——
    // 否则更新中心会把「已跳过」显示成「已是最新」，用户以为真没新版。
    if (up && opts.silent && isVersionSkipped(up.version)) {
      found.value = up
      checked.value = true
      return null
    }
    found.value = up
    checked.value = true
    return up
  } catch (e: any) {
    // 静默模式的失败只留在控制台：启动时用户没在等结果
    if (opts.silent) {
      console.warn('[update] 自动检查失败：', e?.message || e)
      return null
    }
    error.value = e?.message || String(e)
    return null
  } finally {
    checking.value = false
  }
}

/**
 * iOS 侧载通道的检查（AltStore 源 → 同一个 `AppUpdate`，只提示不下载）。
 *
 * <p>与 shell 通道共用「发现 → 稍后 → 再提示」语义；skip 复用 `meow.update.skipVersion`
 * （同一条 iOS 版本线，不与 PC/TV 混），静默检查同样要尊重 skip。
 */
async function runCheckIos(opts: { silent?: boolean }): Promise<AppUpdate | null> {
  if (checking.value) return found.value
  checking.value = true
  if (!opts.silent) resetCheckState()
  else error.value = ''
  try {
    const up = await checkIosAppUpdate()
    if (up && opts.silent && isVersionSkipped(up.version)) {
      found.value = up
      checked.value = true
      return null
    }
    found.value = up
    checked.value = true
    return up
  } catch (e: any) {
    if (opts.silent) {
      console.warn('[update] iOS 侧载源检查失败：', e?.message || e)
      return null
    }
    error.value = e?.message || String(e)
    return null
  } finally {
    checking.value = false
  }
}

/**
 * fpk 通道的检查（把 FnDepot 索引的一条 release 映射成同一个 `AppUpdate`）。
 *
 * <p>数据形状对齐壳：`notes` 直接来自索引的 `changelog`（就是 CHANGELOG 那 6 条），
 * `fileName` 用版本+架构拼，安装动作在 `runDownloadAndInstall` 里分派。
 */
async function runCheckFpk(opts: { silent?: boolean }): Promise<AppUpdate | null> {
  if (checking.value) return found.value
  checking.value = true
  if (!opts.silent) resetCheckState()
  else error.value = ''
  try {
    const res = await checkFpkUpdate()
    if (!res) {
      // 页面失去 fnOS 托管（例如直连 30010）→ 本端不再提供更新
      capability.value = 'none'
      return null
    }
    fpkInfo.value = res.info
    fpkInstalled.value = res.installed
    fpkCurrent.value = res.current
    fpkLatest.value = res.latest
    const up: AppUpdate | null = res.latest
      ? {
          kind: 'fpk',
          version: res.latest.version,
          url: res.latest.url,
          sha256: res.latest.pkg.sha256,
          size: res.latest.pkg.size,
          notes: res.latest.notes.join('\n'),
          lasttime: String(res.latest.release.updated_at || '').slice(0, 10),
          packageId: 'meow-fpk',
          fileName: fpkFileName(res.latest),
        }
      : null
    if (up && opts.silent && fpkIsVersionSkipped(up.version)) {
      found.value = up
      checked.value = true
      return null
    }
    found.value = up
    checked.value = true
    return up
  } catch (e: any) {
    if (opts.silent) {
      console.warn('[update] fpk 自动检查失败：', e?.message || e)
      return null
    }
    error.value = e?.message || String(e)
    return null
  } finally {
    checking.value = false
  }
}

/**
 * 下载 → 校验 → **直接调起安装器**（一步到位，2026-11-13 用户要求）。
 *
 * <p><b>为什么不再停在「点安装」</b>：原来的流程是下载完把按钮改成「安装」，
 * 等用户再点一次。实际用起来有两类问题：
 *   · 用户以为「安装」是二次确认，点了之后又看到进度条（其实是重新下载），
 *     来回循环、永远装不上（2026-11-13 用户实测反馈）；
 *   · 明明已经下载好了，界面上还要再点一下，多一步没有信息量的确认。
 *
 * <p>现在的语义：按钮就是「下载并安装」，点一次 → 下载 → 校验 →
 * 自动调起系统安装器（Windows 的 NSIS 向导 / Android 的系统安装器）。
 * 系统层面的确认弹窗仍然存在，这不是"静默安装"。
 */
export async function runDownloadAndInstall(): Promise<void> {
  if (kind.value === 'fpk') return runFpkDownloadAndInstall()
  const up = found.value
  if (!up || busy.value) return
  busy.value = true
  phase.value = 'downloading'
  percent.value = 0
  stage.value = '下载中…'
  error.value = ''
  stopPoll()
  try {
    await startDownload(up)
    // 每 300ms 读一次进度。1s 太钝（TV 上 11MB 几秒就完了，看不到进度条动）
    const done = await new Promise<boolean>((resolve, reject) => {
      pollTimer = window.setInterval(async () => {
        try {
          const st = await readProgress()
          percent.value = Math.max(0, Math.min(100, st.percent || 0))
          if (st.stage === 'downloading') {
            stage.value = st.message || `下载中 ${percent.value}%`
          } else if (st.stage === 'verifying') {
            stage.value = '校验中…'
          } else if (st.stage === 'ready') {
            resolve(true)
          } else if (st.stage === 'failed') {
            reject(new Error(st.message || '下载失败'))
          } else if (st.stage === 'cancelled') {
            reject(new Error('已取消'))
          }
        } catch (e) {
          reject(e)
        }
      }, 300)
    })
    stopPoll()
    if (!done) return

    // ---- 一步到位：校验通过直接交给系统安装器 ----
    percent.value = 100
    ready.value = true
    phase.value = 'installing'
    stage.value = '正在调起安装程序…'
    let msg = ''
    try {
      msg = await installDownloaded()
    } finally {
      ready.value = false
      stopPoll()
    }
    phase.value = 'done'
    stage.value = msg || '安装程序已启动'
  } catch (e: any) {
    error.value = e?.message || String(e)
    stage.value = ''
    phase.value = 'idle'
  } finally {
    stopPoll()
    busy.value = false
  }
}

/**
 * fpk 通道的「下载并安装」：浏览器下载 → sha256 → 交应用中心 → 等重启 → 刷新。
 *
 * <p>与壳的差别只有最后一步：壳把包交给系统安装器后主进程就退出；
 * fpk 是应用中心原地替换载荷并重启 meowd，页面会短暂断开，
 * 所以这里必须 `waitForRestart()` 轮询 `/api/health`，通了再 reload ——
 * 否则用户看到的是白页/502，以为升级失败。
 *
 * <p>安装阶段不允许关弹框（`closeDialog` 里已按 `busy` 拦住）：
 * 应用中心的任务一旦提交就停不下来，关掉只会让人以为没在装。
 */
async function runFpkDownloadAndInstall(): Promise<void> {
  const latest = fpkLatest.value
  const info = fpkInfo.value
  if (!latest || !info || busy.value) return
  busy.value = true
  phase.value = 'downloading'
  percent.value = 0
  stage.value = '正在下载安装包…'
  error.value = ''
  try {
    await runFpkUpgrade(latest, fpkInstalled.value, info, (p: FpkProgress) => {
      percent.value = Math.max(0, Math.min(100, p.percent || 0))
      stage.value = p.text
      if (p.phase === 'installing' || p.phase === 'done') phase.value = 'installing'
    })
    // 应用中心返回成功 ≠ 服务已起来：继续等 meowd 的 health
    percent.value = 100
    phase.value = 'installing'
    stage.value = '正在等待服务恢复…'
    const ok = await waitForRestart(120_000)
    if (ok) {
      // 直接刷新，让页面与新载荷同版本（不清缓存会把旧 index.html 拉回来）
      location.reload()
      return
    }
    throw new Error('升级已提交，但服务在 2 分钟内没有恢复；请稍后手动刷新页面')
  } catch (e: any) {
    error.value = e?.message || String(e)
    stage.value = ''
    phase.value = 'idle'
  } finally {
    busy.value = false
  }
}

/**
 * 安装已经下载好的包（旧的二次点击入口）。
 *
 * <p>保留导出只为一个场景：`ready === true` 的瞬间（自动安装开始前）
 * 外部万一调到了，也还能走安装。UI 已经**不再**提供「安装」按钮 ——
 * 下载结束会自动调起安装器（见 `runDownloadAndInstall`）。
 */
export async function runInstall(): Promise<void> {
  if (!ready.value) return
  busy.value = true
  phase.value = 'installing'
  stage.value = '正在调起安装程序…'
  error.value = ''
  try {
    stage.value = await installDownloaded()
    phase.value = 'done'
  } catch (e: any) {
    error.value = e?.message || String(e)
    stage.value = ''
    phase.value = 'idle'
  } finally {
    ready.value = false
    busy.value = false
  }
}

/** 取消下载（TV 上没有鼠标指针，误点要能退出来） */
export async function runCancel(): Promise<void> {
  try {
    await cancelDownload()
  } catch {
    /* 取消失败不影响界面状态，由轮询纠正 */
  } finally {
    // 取消后回到可再次点击「下载并安装」的状态（否则按钮会卡在「处理中…」）
    if (phase.value === 'downloading') {
      phase.value = 'idle'
      stage.value = ''
      percent.value = 0
    }
  }
}

/** 记住「这个版本稍后」（下次只有更高版本才再提示） */
export function rememberSkip(): void {
  const v = found.value?.version
  if (!v) return
  // 两条通道分开记：同一条版本线（1.2.11），共用 key 会互相压制
  if (kind.value === 'fpk') fpkSkipVersion(v)
  else skipVersionLs(v)
}

/**
 * 关弹框。
 *
 * <p><b>只有显式「稍后」才记住版本</b>（`skip: true`）。点空白、按 Esc、
 * 电视按返回都不算表态 —— 以前它们统统调用 rememberSkip，于是"想先看一眼
 * 别的页面"就把这个版本永久标记成稍后：之后每次检查都显示「已是最新」，
 * 用户再也收不到更新（2026-11-13 .77 实测踩到，skip=1.2.7）。
 *
 * <p>下载中不许关：任务是原生侧常驻的，关掉会让用户以为停了，
 * 然后又在设置页看到进度还在涨。返回 false 表示"这次没关成"。
 */
export function closeDialog(opts: { skip?: boolean } = {}): boolean {
  if (busy.value && !ready.value) return false
  if (opts.skip && !error.value) rememberSkip()
  dialogOpen.value = false
  // 关掉就算处理过了：不清的话路由 watcher 会看到"待提示"又弹回来
  promptPending.value = false
  return true
}

/** 打开弹框（有更新才开），并清掉待提示标记 */
export function openDialog(): void {
  if (!found.value) return
  promptPending.value = false
  dialogOpen.value = true
}

/** 当前版本号（弹框标题要用） */
export function appVersion(): string {
  return currentVersion()
}

/*
 * 调试入口（仅 dev）。
 *
 * <p>为什么需要：纯 Web 端 `canUpdate()` 恒为 false（没有安装包这个概念），
 * 真实的检查/下载路径在浏览器里永远走不到，于是弹框、进度条、TV 焦点这些
 * UI 契约**无法在 Web 上验证**，只能盲写。
 *
 * <p>有了它就能在 dev 控制台里直接：
 * ```js
 * __meowUpdate.found.value = { version: '0.9.99', url: '...', sha256: '...', size: 1, notes: '一行
两行' }
 * __meowUpdate.open()
 * ```
 *
 * <p>和 `window.__meowDm` / `window.__playerDebug` 同一套做法（AGENTS §5.2）。
 * 生产构建里 `import.meta.env.DEV` 是 false，整段被 tree-shake 掉。
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __meowUpdate?: unknown }).__meowUpdate = {
    found, checked, checking, busy, error, percent, stage, ready, dialogOpen, promptPending,
    open: openDialog,
    close: closeDialog,
    skip: rememberSkip,
    check: runCheck,
  }
}
