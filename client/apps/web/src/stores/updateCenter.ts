/**
 * 更新中心：壳 / TV 运行时模块 / PC 插件 / fnOS fpk 的统一检查状态。
 *
 * <p>这里只做「检查 + 展示状态」，**不合并安装器**：
 * 壳走 exe/apk 安装器、模块走系统 APK 安装器、插件走目录切换、
 * fpk 走 meowd + 应用中心。任何一项失败都不能阻塞其他项。
 *
 * <p>状态放 store 而不是 SettingsView：
 *  - 启动后台检查在 App.vue 里跑，和设置页是两棵组件树；
 *  - 更新中心与旧的分区共用同一份结果，避免两处显示不一致。
 */

import { reactive, ref } from 'vue'
import { isDesktop } from '@/api'
import {
  checkAppUpdate,
  getBackupUpdateSource,
  getUpdateSource,
  getUpdateToken,
  isNewer,
} from '@/api/appUpdate'
import {
  addPluginSource,
  fetchInstalledPlugins,
  fetchPluginIndex,
  fetchPluginSources,
  selectPluginSource,
  updatePluginSource,
} from '@/api'
import {
  detectFpkShell,
  fetchIndexes,
  pickLatestFromIndexes,
  type FpkLatest,
  type FpkShellInfo,
} from '@/api/fpkUpgrade'
import { getPrefs } from '@/stores/prefs'

export type UpdateKind = 'app' | 'module' | 'plugins' | 'fpk'

export interface ModuleLatest {
  version: string
  size: number
  abi: string
  sha256: string
  url: string
}

export interface PluginLatest {
  id: string
  name: string
  current: string
  latest: string
  size: number
}

const LAST_KEY = 'meow.update.lastCheck'
const DAY = 24 * 60 * 60 * 1000

/** 每个渠道的检查中状态 */
export const checking = reactive<Record<UpdateKind, boolean>>({
  app: false,
  module: false,
  plugins: false,
  fpk: false,
})

/** 每个渠道最后一次错误（成功时清空） */
export const errors = reactive<Record<UpdateKind, string>>({
  app: '',
  module: '',
  plugins: '',
  fpk: '',
})

/** 每个渠道最后一次检查时间（毫秒） */
export const lastCheckedAt = reactive<Record<UpdateKind, number>>({
  app: 0,
  module: 0,
  plugins: 0,
  fpk: 0,
})

export const moduleLatest = ref<ModuleLatest | null>(null)
export const moduleCurrent = ref('')
export const moduleInstalled = ref(false)
/** 是否读过模块状态（区分“未检查”和“未安装”） */
export const moduleChecked = ref(false)
export const pluginUpdates = ref<PluginLatest[]>([])
/** 是否已配置插件源（用于 UI 区分“没源”和“没更新”） */
export const pluginConfigured = ref(false)
/** 已安装插件数（0 = 未安装，不是“没更新”） */
export const pluginInstalledCount = ref(0)
/** 是否做过一次插件检查（区分“未检查”和“未安装”） */
export const pluginChecked = ref(false)
export const fpkLatest = ref<FpkLatest | null>(null)
export const fpkCurrent = ref('')
export const fpkVisible = ref(false)
/** 是否做过一次 fpk 探测（区分“未检查”和“不是 fpk 壳”） */
export const fpkChecked = ref(false)

function readLast(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) || '{}') as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const k of Object.keys(raw)) {
      const n = Number(raw[k])
      if (Number.isFinite(n) && n > 0) out[k] = n
    }
    return out
  } catch {
    return {}
  }
}

function initLast(): void {
  const raw = readLast()
  for (const k of Object.keys(lastCheckedAt) as UpdateKind[]) {
    lastCheckedAt[k] = raw[k] || 0
  }
}
initLast()

function mark(kind: UpdateKind): void {
  lastCheckedAt[kind] = Date.now()
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(lastCheckedAt))
  } catch {
    /* 配额满不影响检查结果 */
  }
}

/** 壳检查由 appUpdate store 负责，检查完在这里记一次时间 */
export function markChecked(kind: UpdateKind): void {
  mark(kind)
}

function setError(kind: UpdateKind, e: unknown, silent: boolean): void {
  const msg = e instanceof Error ? e.message : String(e || '未知错误')
  errors[kind] = msg
  if (!silent) console.warn(`[update] ${kind} 检查失败：`, msg)
}

/** 自动检查是否到期（默认 24h；手动检查不经过这里） */
export function autoCheckDue(kind: UpdateKind, maxAgeMs = DAY): boolean {
  const p = getPrefs()
  const enabled =
    kind === 'app'
      ? p.autoCheckApp
      : kind === 'module'
        ? p.autoCheckModule
        : kind === 'plugins'
          ? p.autoCheckPlugins
          : p.autoCheckFpk
  if (!enabled) return false
  // 平台不支持时不算“到期”，否则每次启动都白跑一次（且永远不会 mark）
  if (kind === 'module' && !isTvShell()) return false
  if (kind === 'plugins' && !isDesktop()) return false
  if (kind === 'fpk' && (isDesktop() || isTvShell())) return false
  return Date.now() - (lastCheckedAt[kind] || 0) >= maxAgeMs
}

/** TV 原生桥（老壳可能没有 moduleCheck） */
function tvBridge(): any {
  try {
    return (window as unknown as { meowTv?: any }).meowTv || null
  } catch {
    return null
  }
}

export function isTvShell(): boolean {
  const b = tvBridge()
  return !!b && typeof b.moduleCheck === 'function'
}

/** 应用壳更新（PC/TV）。复用 appUpdate store 的结果，避免两份状态 */
export async function checkApp(silent = false): Promise<boolean> {
  if (checking.app) return false
  checking.app = true
  errors.app = ''
  try {
    const up = await checkAppUpdate()
    // appUpdate store 会在设置页/弹框里自己显示 found；这里只记时间
    mark('app')
    return !!up
  } catch (e) {
    setError('app', e, silent)
    return false
  } finally {
    checking.app = false
  }
}

/** TV 运行时模块；未安装时只报告状态，不产生“可更新” */
export async function checkModule(silent = false): Promise<boolean> {
  if (!isTvShell() || checking.module) return false
  const b = tvBridge()
  checking.module = true
  errors.module = ''
  try {
    const state = JSON.parse(String(b.moduleState?.() || '{}'))
    moduleChecked.value = true
    moduleInstalled.value = !!state.installed
    moduleCurrent.value = String(state.version || '')
    if (!state.installed) {
      moduleLatest.value = null
      return false
    }
    const src = (await getUpdateSource()) || ''
    const tok = getUpdateToken()
    let chk = JSON.parse(String(b.moduleCheck(src, tok) || '{}'))
    // 显式备用源：主源失败才试（与应用更新同一份 Prefs）
    const backup = getBackupUpdateSource()
    if (chk.ok === false && backup && backup !== src) {
      chk = JSON.parse(String(b.moduleCheck(backup, tok) || '{}'))
    }
    if (chk.ok === false) throw new Error(chk.error || '检查失败')
    const latestVersion = String(chk.version || '')
    if (!latestVersion) throw new Error('清单里没有模块版本')
    const has = isNewer(latestVersion, moduleCurrent.value)
    moduleLatest.value = has
      ? {
          version: latestVersion,
          size: Number(chk.size) || 0,
          abi: String(chk.abi || state.abi || ''),
          sha256: String(chk.sha256 || ''),
          url: String(chk.url || ''),
        }
      : null
    mark('module')
    return has
  } catch (e) {
    setError('module', e, silent)
    moduleLatest.value = null
    return false
  } finally {
    checking.module = false
  }
}

function verCmp(a: string, b: string): number {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/** 确保“跟随应用更新源”已经落成一条插件源（PC 插件安装器仍然独立） */
async function ensurePluginAppSource(): Promise<void> {
  if (!isDesktop() || !getPrefs().pluginUseAppSource) return
  const url = (await getUpdateSource()) || ''
  if (!url) return
  const list = await fetchPluginSources()
  if (!list) return
  const hit = list.items.find((s) => s.url === url)
  if (hit) {
    // 已有自定义源在用时不要抢当前选择；只在“没选源”时补上
    if (!list.current) await selectPluginSource(hit.id)
    return
  }
  const named = list.items.find((s) => s.name === '应用更新源')
  if (named) {
    await updatePluginSource(named.id, url, '应用更新源')
    if (list.current !== named.id) await selectPluginSource(named.id)
    return
  }
  // 只有用户还没配源时才自动加；已有自定义源不抢当前选择
  if (!list.items.length) await addPluginSource(url, '应用更新源')
}

/** PC 插件更新（仅已安装的插件逐条比较） */
export async function checkPlugins(silent = false): Promise<boolean> {
  if (!isDesktop() || checking.plugins) return false
  checking.plugins = true
  errors.plugins = ''
  pluginConfigured.value = false
  try {
    const installed = await fetchInstalledPlugins()
    pluginChecked.value = true
    pluginInstalledCount.value = Object.keys(installed || {}).length
    if (!installed || !Object.keys(installed).length) {
      // 没装插件就不拉远端索引（设置页启动时的黑框/网络都省掉）
      pluginUpdates.value = []
      mark('plugins')
      return false
    }
    await ensurePluginAppSource()
    const list = await fetchPluginSources()
    if (!list || !list.current) {
      pluginUpdates.value = []
      return false
    }
    pluginConfigured.value = true
    const idx = await fetchPluginIndex()
    const out: PluginLatest[] = []
    for (const [id, info] of Object.entries(installed || {})) {
      const remote = idx?.packages?.[id]
      if (!remote || remote.hidden) continue
      if (verCmp(String(remote.version || ''), String(info.version || '')) > 0) {
        out.push({
          id,
          name: remote.display_name || id,
          current: String(info.version || ''),
          latest: String(remote.version || ''),
          size: Number(remote.size) || 0,
        })
      }
    }
    pluginUpdates.value = out
    mark('plugins')
    return out.length > 0
  } catch (e) {
    setError('plugins', e, silent)
    pluginUpdates.value = []
    return false
  } finally {
    checking.plugins = false
  }
}

/** fnOS fpk 更新（FnDepot 优先，主仓镜像兜底） */
export async function checkFpk(silent = false): Promise<boolean> {
  if (isDesktop() || isTvShell() || checking.fpk) return false
  checking.fpk = true
  errors.fpk = ''
  fpkVisible.value = false
  try {
    const det = await detectFpkShell()
    fpkChecked.value = true
    if (!det) {
      fpkLatest.value = null
      return false
    }
    fpkVisible.value = true
    fpkCurrent.value = det.installed?.version || det.info.version
    const indexes = await fetchIndexes(undefined, fpkCurrent.value)
    const picked = pickLatestFromIndexes(indexes, det.info as FpkShellInfo, fpkCurrent.value)
    if (!picked) {
      fpkLatest.value = null
      mark('fpk')
      return false
    }
    if ('noPackage' in picked) {
      throw new Error(`新版本 v${picked.version} 没有当前架构的安装包`)
    }
    fpkLatest.value = picked.latest
    mark('fpk')
    return true
  } catch (e) {
    setError('fpk', e, silent)
    fpkLatest.value = null
    return false
  } finally {
    checking.fpk = false
  }
}

/**
 * 后台自动检查（App.vue 启动后调用）。
 *
 * 壳仍走原来的 5 秒静默检查 + 弹框；模块/插件/fpk 只更新状态和角标，
 * 24 小时一次，且必须满足“已安装/有源/平台支持”。
 */
export async function runBackgroundChecks(): Promise<void> {
  const jobs: Array<Promise<unknown>> = []
  if (autoCheckDue('module')) jobs.push(checkModule(true))
  if (autoCheckDue('plugins')) jobs.push(checkPlugins(true))
  if (autoCheckDue('fpk')) jobs.push(checkFpk(true))
  await Promise.allSettled(jobs)
}

/** 手动“检查全部”：手动不受 24h 节流，也不看自动开关 */
export async function checkAll(): Promise<void> {
  await Promise.allSettled([checkModule(false), checkPlugins(false), checkFpk(false)])
}

/** 设置页改了自动检查开关后立即生效（只落 prefs，无需重启） */
export function autoCheckEnabled(kind: UpdateKind): boolean {
  const p = getPrefs()
  return kind === 'app'
    ? p.autoCheckApp
    : kind === 'module'
      ? p.autoCheckModule
      : kind === 'plugins'
        ? p.autoCheckPlugins
        : p.autoCheckFpk
}
