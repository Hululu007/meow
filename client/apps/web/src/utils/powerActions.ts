/**
 * 倒计时电源动作的能力与默认项解析。
 *
 * 判据分工（见 site/docs/dev/power-actions.md §3）：
 *  - 能不能做 = 能力探测（桥方法 / Tauri 运行时）；
 *  - 默认选哪个 = 身份 + 形态（只用于预选与排序）。
 *
 * 组件不要再自己写 `innerWidth` / UA / `platform === 'tv'`。
 */

import { currentShell, type Shell } from '@/compat/shell'
import { formOf, type Form } from '@/compat/deviceProfile'
import { hasDesktopQuit, hasSystemSleep, tvPowerCaps } from '@/api/nativeBridge'

export type PowerAction = 'shutdown' | 'sleep' | 'quit' | 'pause'

export interface PowerCaps {
  shutdown: 'yes' | 'probe' | 'no'
  sleep: boolean
  quit: boolean
  pause: true
}

/** 当前端能做到哪些动作。 */
export function resolvePowerCaps(): PowerCaps {
  const shell = currentShell()
  if (shell === 'tauri') {
    // PC 关机（system_shutdown）尚未实现（方案 P1），先不报
    return { shutdown: 'no', sleep: hasSystemSleep(), quit: hasDesktopQuit(), pause: true }
  }
  if (shell === 'tv') {
    const c = tvPowerCaps()
    return { shutdown: c.shutdown, sleep: false, quit: c.quit, pause: true }
  }
  return { shutdown: 'no', sleep: false, quit: false, pause: true }
}

/** 有真实行为的动作（顺序即菜单顺序）。 */
export function powerActionsFor(caps: PowerCaps): PowerAction[] {
  const out: PowerAction[] = []
  if (caps.shutdown !== 'no') out.push('shutdown')
  if (caps.sleep) out.push('sleep')
  if (caps.quit) out.push('quit')
  out.push('pause')
  return out
}

/** 默认预选：只影响预选，不影响可用性。 */
export function defaultPowerAction(shell: Shell, form: Form): PowerAction {
  if (shell === 'tauri') return 'sleep'
  if (form === 'tv-large') return 'shutdown'
  if (form === 'phone' || form === 'tablet') return 'quit'
  return 'pause'
}

export const POWER_ACTION_LABEL: Record<PowerAction, string> = {
  shutdown: '关机',
  sleep: '休眠',
  quit: '退出应用',
  pause: '仅暂停',
}

/** 倒计时档位（分钟）；1 分钟档留给验证与"马上收工"场景。 */
export const POWER_TIMER_MINUTES = [0, 1, 15, 30, 60, 90] as const

/** 便捷：当前形态下的默认动作（组件用一次）。 */
export function currentDefaultPowerAction(): PowerAction {
  return defaultPowerAction(currentShell(), formOf())
}
