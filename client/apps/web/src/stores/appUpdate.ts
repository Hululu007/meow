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
import {
  checkAppUpdate,
  currentPlatform,
  currentVersion,
  isVersionSkipped,
  readProgress,
  skipVersion as skipVersionLs,
  startDownload,
  installDownloaded,
  cancelDownload,
  type AppUpdate,
} from '@/api/appUpdate'

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
/** 已下载校验通过、可以点安装 */
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
/** 本端能不能装包（PC / TV 可以，纯 Web 不行） */
export const canUpdate = computed(() => platform.value !== 'web')

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
  if (!canUpdate.value) return null
  if (checking.value) return found.value
  checking.value = true
  if (!opts.silent) resetCheckState()
  else error.value = ''
  try {
    const up = await checkAppUpdate()
    // 用户说过「这个版本稍后」：静默检查不再打扰，手动检查照常显示
    if (up && opts.silent && isVersionSkipped(up.version)) {
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
 * 下载并安装。
 *
 * 进度靠轮询原生状态（Tauri invoke / TV 桥都是"一次性调用 + 状态轮询"，
 * 没有回调通道）。轮询集中在 store 里而不是页面：两处同时轮询会让
 * 百分比互相覆盖。
 */
export async function runDownloadAndInstall(): Promise<void> {
  const up = found.value
  if (!up || busy.value) return
  busy.value = true
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

    /*
     * ★ 下载完成后**停在 ready**，由用户点「安装」（2026-10-31 实测改）。
     *
     * 原来这里立刻 `installDownloaded()` 然后 `ready.value = false`：
     *   · ready 只在一瞬间为真，界面上的按钮文案永远是「下载并安装」
     *   · 安装器是系统 UI，会盖住应用；用户回到应用时按钮又变回「下载并安装」，
     *     完全看不出"其实已经下好了，只差点安装"
     *   · 更糟的是 TV 上系统安装器弹窗需要用户确认，而我们的流程没有
     *     给用户任何"现在该点安装"的提示
     *
     * 现在：下载 + 校验完成 → ready=true、stage='已下载，点「安装」'；
     * 用户再点一次按钮 → installDownloaded()。
     * 这符合"绝不静默安装"的既有约定，也让状态可见。
     */
    percent.value = 100
    ready.value = true
    stage.value = '已下载，点「安装」'
  } catch (e: any) {
    error.value = e?.message || String(e)
    stage.value = ''
  } finally {
    stopPoll()
    busy.value = false
  }
}

/**
 * 安装已经下载好的包。
 *
 * <p>与下载分开是刻意的（2026-10-31）：应用内的"下载"和系统的"安装"
 * 是两个动作，中间隔着一次系统弹窗。混在一起会让用户看到
 * "点了下载，弹了个安装框，回来按钮又变回去了"。
 *
 * <p>只在 `ready === true` 时有效；否则什么都不做（防止误调）。
 */
export async function runInstall(): Promise<void> {
  if (!ready.value) return
  busy.value = true
  stage.value = '安装中…'
  error.value = ''
  try {
    stage.value = await installDownloaded()
  } catch (e: any) {
    error.value = e?.message || String(e)
    stage.value = ''
  } finally {
    // 交给系统安装器之后就不再是"待安装"态
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
  }
}

/** 记住「这个版本稍后」（下次只有更高版本才再提示） */
export function rememberSkip(): void {
  const v = found.value?.version
  if (v) skipVersionLs(v)
}

/**
 * 关弹框（并记住稍后）。
 *
 * <p>下载中不许关：任务是原生侧常驻的，关掉会让用户以为停了，
 * 然后又在设置页看到进度还在涨。返回 false 表示"这次没关成"。
 */
export function closeDialog(): boolean {
  if (busy.value && !ready.value) return false
  if (!error.value) rememberSkip()
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
