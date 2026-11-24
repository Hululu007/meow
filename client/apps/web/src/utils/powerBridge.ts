/**
 * 电源定时器的 Web 回推通道。
 *
 * 为什么独立成模块：TV 的定时器在原生层，退出播放页后仍在倒计时。
 * 若把 `window.__meowPowerFire` 绑在 VideoPlayer 实例上并在卸载时删除，
 * 到点回推就没人接——`shutdown/quit` 照常执行，但 `pause` 静默失效。
 * 这里用模块级变量 + 常驻全局函数，组件只注册/注销处理器。
 */

export interface PowerResult {
  ok?: boolean
  reason?: string
}

type FireHandler = (action: string) => void
type ResultHandler = (action: string, result: PowerResult | null) => void

let fireHandler: FireHandler | null = null
let resultHandler: ResultHandler | null = null

/** 组件挂载时注册处理器；全局函数只装一次，常驻。 */
export function installPowerBridge(fire: FireHandler, result: ResultHandler): void {
  fireHandler = fire
  resultHandler = result
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, any>
  // 多个播放器实例不会并存；已装过就不覆盖，避免闭包被后一个实例替换掉。
  if (typeof w.__meowPowerFire !== 'function') {
    w.__meowPowerFire = (a: string) => fireHandler?.(a)
  }
  if (typeof w.__meowPowerResult !== 'function') {
    w.__meowPowerResult = (a: string, r: PowerResult | null) => resultHandler?.(a, r)
  }
}

/** 组件卸载时只注销处理器，保留全局函数（原生定时器还要往这里回推）。 */
export function uninstallPowerBridge(): void {
  fireHandler = null
  resultHandler = null
}
