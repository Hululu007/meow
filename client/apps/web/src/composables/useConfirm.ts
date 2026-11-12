import { reactive } from 'vue'

/**
 * 应用内确认 / 提示弹框（替代 window.confirm / window.alert）。
 *
 * ## 为什么不用原生
 *
 * TV 的 WebView 把 `confirm()` 画成系统弹框，标题还带着
 * 「网址为 "http://meow.local" 的网页显示:」——既不跟主题，也不能用遥控器
 * 在「取消 / 确定」之间移动焦点；Web / PC 上是浏览器默认样式，和站点两套语言。
 *
 * ## 为什么集中成一个模块
 *
 * 调用点有 30 多处（设置、历史、收藏、片库、缓存、日志），各页面自己维护
 * 一份弹框必然漂移。这里只有一份状态机，组件（ConfirmDialog.vue）在 App.vue
 * 挂一次，调用方只 `await confirmDialog(...)`。
 */

export interface ConfirmOptions {
  /** 不填就只有正文。正文里的 `\n` 会原样换行 */
  title?: string
  okText?: string
  cancelText?: string
  /** 危险操作（删除 / 清空）：确定按钮用 hot 色 */
  danger?: boolean
}

type Kind = 'confirm' | 'alert'

interface DialogState {
  open: boolean
  kind: Kind
  title: string
  message: string
  okText: string
  cancelText: string
  danger: boolean
}

export const dialogState = reactive<DialogState>({
  open: false,
  kind: 'confirm',
  title: '',
  message: '',
  okText: '确定',
  cancelText: '取消',
  danger: false,
})

let settle: ((ok: boolean) => void) | null = null

function open(kind: Kind, message: string, opts: ConfirmOptions): Promise<boolean> {
  // 上一个还开着时先按「取消」收尾：否则它的 await 永远不返回，
  // 调用方的后续逻辑（比如删完刷新）会静默不执行。
  settle?.(false)
  dialogState.kind = kind
  dialogState.title = opts.title || ''
  dialogState.message = message
  dialogState.okText = opts.okText || '确定'
  // alert 没有取消按钮：这里必须显式置空，否则 `|| '取消'` 会把空串顶回来
  dialogState.cancelText = kind === 'alert' ? '' : opts.cancelText || '取消'
  dialogState.danger = !!opts.danger
  dialogState.open = true
  return new Promise<boolean>((resolve) => {
    settle = resolve
  })
}

/** 确认：走「取消 / 确定」两个按钮，返回是否点了确定 */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return open('confirm', message, opts)
}

/** 提示：只有「确定」（Esc 也算关掉），返回恒为 true */
export function alertDialog(
  message: string,
  opts: Omit<ConfirmOptions, 'cancelText'> = {},
): Promise<boolean> {
  return open('alert', message, { ...opts, cancelText: '' })
}

/** 弹框组件用：确定 / 取消 / Esc 之后收尾 */
export function settleDialog(ok: boolean) {
  if (!dialogState.open) return
  dialogState.open = false
  const fn = settle
  settle = null
  fn?.(ok)
}
