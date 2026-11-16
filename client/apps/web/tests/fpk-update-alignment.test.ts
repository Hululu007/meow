import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fpkFileName,
  fpkIsVersionSkipped,
  fpkMarkPrompted,
  fpkPromptDue,
  fpkSkipVersion,
  type FpkLatest,
} from '../src/api/fpkUpgrade'
import { isVersionSkipped, skipVersion } from '../src/api/appUpdate'

/**
 * 「fpk 对齐壳更新」的契约（2026-11-16 用户点单 1~5）。
 *
 * 背景：fnOS 的 fpk 是完整应用（有自己的版本线、安装器、更新说明），
 * 却因为 `platform === 'web'` 被排除在弹框之外；用户明确要求
 * 「对齐 tv、pc」，并且 fpk 经常被当 TV 后端用。
 *
 * 这里锁三件事：
 *   1. 两条通道共用同一套「发现 → 待提示 → 弹框 → 稍后」状态机；
 *   2. 但「稍后」的版本 key 必须分开（同一条 1.2.x 版本线，共用会互相压制）；
 *   3. 弹框的安装动作按 kind 分派（壳=系统安装器，fpk=应用中心重启）。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SRC = join(ROOT, 'client', 'apps', 'web', 'src')

function src(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
}

describe('fpk 更新：跳过版本与壳互不影响', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('两条通道各记各的 key', () => {
    skipVersion('1.2.11')
    expect(isVersionSkipped('1.2.11')).toBe(true)
    // 壳点了「稍后」不能把 fpk 也压住
    expect(fpkIsVersionSkipped('1.2.11')).toBe(false)

    fpkSkipVersion('1.2.11')
    expect(fpkIsVersionSkipped('1.2.11')).toBe(true)
    expect(isVersionSkipped('1.2.11')).toBe(true)
  })

  it('更高版本不受旧的跳过记录影响（由调用方用 isNewer 判断）', () => {
    fpkSkipVersion('1.2.11')
    expect(fpkIsVersionSkipped('1.2.12')).toBe(false)
  })
})

describe('fpk 更新：同版本 24h 只提示一次', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('没提示过 → 到期', () => {
    expect(fpkPromptDue('1.2.11')).toBe(true)
  })

  it('提示过同一版本 → 冷却中；换了版本 → 立刻可提示', () => {
    fpkMarkPrompted('1.2.11')
    expect(fpkPromptDue('1.2.11')).toBe(false)
    expect(fpkPromptDue('1.2.12')).toBe(true)
  })

  it('冷却记录损坏时按"没提示过"处理，不能永久静默', () => {
    localStorage.setItem('meow.fpk.prompted', '{oops')
    expect(fpkPromptDue('1.2.11')).toBe(true)
  })
})

describe('fpk 更新：文件名按版本+架构拼', () => {
  it('x86 / arm 都与应用中心登记的文件名一致', () => {
    const base = {
      version: '1.2.11',
      release: {},
      pkg: { download_url: './meow_1.2.11_x86.fpk', sha256: 'a'.repeat(64), size: 1 },
      url: 'https://example.test/meow_1.2.11_x86.fpk',
      notes: [],
    } as unknown as FpkLatest
    expect(fpkFileName({ ...base, arch: 'x86' })).toBe('meow_1.2.11_x86.fpk')
    expect(fpkFileName({ ...base, arch: 'arm' })).toBe('meow_1.2.11_arm.fpk')
  })
})

describe('对齐实现：源码契约', () => {
  it('能力探测取代「platform !== web」，且 fpk 也算可更新', () => {
    const store = src('stores/appUpdate.ts')
    expect(store, '还在用平台字符串判 canUpdate').not.toContain(
      "computed(() => platform.value !== 'web')",
    )
    expect(store).toContain('export function probeCapability')
    expect(store).toContain("capability.value === 'shell' || capability.value === 'fpk'")
  })

  it('安装动作按 kind 分派：壳走安装器、fpk 走应用中心并等重启', () => {
    const store = src('stores/appUpdate.ts')
    expect(store).toContain("if (kind.value === 'fpk') return runFpkDownloadAndInstall()")
    const at = store.indexOf('async function runFpkDownloadAndInstall')
    expect(at).toBeGreaterThan(-1)
    const block = store.slice(at, at + 1600)
    expect(block, 'fpk 没等 /api/health 恢复就收尾').toContain('waitForRestart(120_000)')
    expect(block).toContain('location.reload()')
  })

  it('启动调度：shell 与 fpk 各按自己的开关，且 fpk 有同版本冷却', () => {
    const app = src('App.vue')
    expect(app).toContain('void probeCapability().then((cap) => {')
    expect(app).toContain("if (cap === 'shell' && getPrefs().autoCheckApp)")
    expect(app).toContain("if (cap === 'fpk' && getPrefs().autoCheckFpk)")
    expect(app).toContain('fpkPromptDue(up.version)')
    expect(app).toContain('fpkMarkPrompted(up.version)')
  })

  it('弹框按 kind 显示 fnOS 而不是 Windows/Android', () => {
    const dialog = src('components/common/UpdateDialog.vue')
    expect(dialog).toContain("if (found.value?.kind === 'fpk') return 'fnOS 应用'")
    expect(dialog).toContain("found.value.fileName || fileNameFor(found.value)")
  })

  it('更新中心：只有 fpk 托管时才显示 fpk 勾选框，Web 上不再有死掉的「壳」勾选框', () => {
    const center = src('components/common/UpdateCenter.vue')
    expect(center).toContain('v-if="capability === \'fpk\'"')
    expect(center).toContain('v-if="capability === \'shell\'"')
    expect(center, '打开设置页仍不探测 fpk 当前版本').toContain('void checkFpk(true)')
  })

  it('TV/PC 连到 fnOS 后端时只读提示「后端可升级」，不在客户端执行安装', () => {
    const center = src('components/common/UpdateCenter.vue')
    expect(center).toContain('checkBackendFpk()')
    expect(center).toContain('请在 NAS 上升级')
    // 只读行不能放「立即更新/去更新」按钮
    const at = center.indexOf('data-update-row="backend-fpk"')
    expect(at).toBeGreaterThan(-1)
    expect(center.slice(at, at + 900)).not.toContain('runFpkUpgrade')
  })
})
