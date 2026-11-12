import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 更新中心的“状态 / 按钮”契约（2026-11-11 用户截图）。
 *
 * 用户原话：「这个怎么有，检查全部 右侧还有检查。还有未安装 未检查。是否合理」。
 * 截图里三处确实不合理：
 *   1. 壳已经「已是最新」，行内还留一个「检查」——和顶部「检查全部」重复；
 *   2. 模块行同时出现「未安装」和「未检查」——版本未知被当成未安装，
 *      再叠一条未检查；实际模块可能正在运行；
 *   3. 「最近检查」把 TV 上根本不存在的「插件 / fpk」也列出来，
 *      而且模块那一项是上次会话留下的时间戳，和本次「未检查」自相矛盾。
 *
 * 这里按源码契约锁住改法，避免以后又退回去。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const CENTER = join(ROOT, 'client', 'apps', 'web', 'src', 'components', 'common', 'UpdateCenter.vue')
const STORE = join(ROOT, 'client', 'apps', 'web', 'src', 'stores', 'updateCenter.ts')

describe('更新中心：状态不重复、按钮不重复', () => {
  const src = readFileSync(CENTER, 'utf8')

  it('模块版本未知显示 —，不拿「未安装」顶替', () => {
    expect(src).toContain("{{ moduleCurrent || '—' }}")
    expect(src, '版本单元格又用未安装冒充未知状态').not.toContain(
      "{{ moduleCurrent || '未安装' }}",
    )
  })

  it('模块只显示一条状态：未安装 / 未检查 / 已是最新', () => {
    const at = src.indexOf('const moduleLabel')
    expect(at).toBeGreaterThan(-1)
    const block = src.slice(at, at + 420)
    expect(block, '未安装判断被未检查挡住了').toMatch(
      /!moduleInstalled\.value\) return '未安装'/,
    )
    expect(block, '比对版本与读安装状态共用一个标志').toContain('!moduleUpdateChecked.value')
  })

  it('已是最新时不再显示行内「检查」', () => {
    expect(src, '壳已检查后按钮还在').toContain('v-else-if="!updChecked || updError"')
    expect(src, '模块已比对后按钮还在').toContain(
      'v-else-if="!moduleUpdateChecked || errors.module"',
    )
  })

  it('模块未安装时给「去安装」，不要求先检查', () => {
    expect(src).toContain('v-else-if="moduleChecked && !moduleInstalled"')
    const at = src.indexOf('v-else-if="moduleChecked && !moduleInstalled"')
    expect(src.slice(at, at + 320), '未安装却只给检查').toContain('去安装')
  })

  it('最近检查只列当前端、本次会话真的查过的渠道', () => {
    expect(src).toContain("if (tv && moduleUpdateChecked.value)")
    expect(src).toContain("if (desktop && pluginChecked.value)")
    expect(src).toContain('if (!desktop && !tv && fpkVisible.value && fpkChecked.value)')
    expect(src, '没有按 lastParts 条件渲染').toContain('v-if="lastParts.length"')
  })

  it('打开更新中心先读本地模块状态（不发网络请求）', () => {
    expect(src).toContain('hydrateModuleState()')
    const store = readFileSync(STORE, 'utf8')
    const at = store.indexOf('export function hydrateModuleState')
    expect(at).toBeGreaterThan(-1)
    const block = store.slice(at, at + 700)
    expect(block, '读状态却发了网络请求').not.toContain('fetch(')
    expect(block).toContain('moduleState?.()')
  })

  it('根容器不能用 .set-sub（它是横向 flex，说明会被排到行尾）', () => {
    /*
     * 实测（2026-11-11 TV）：行内按钮变少后，说明文字不再换行，
     * 直接被 flex 排到「运行时模块」那一行的最右边。根容器改成普通块级。
     */
    expect(src).not.toContain('class="set-sub mt-3 border-t border-line pt-3"')
    expect(src).toContain('text-[11px] text-ink-2" data-update-center')
  })
})

/**
 * 模块下载轮询必须用原生的状态词表（2026-11-12 极米投影仪实测）。
 *
 * 原生 AppUpdater 的状态机是 idle|downloading|verifying|ready|failed|cancelled，
 * **没有 'done'**。设置页 modInstall() 曾写成 `st.state === 'done'`——
 * 下载到 100% 后轮询永远不命中，3 分钟超时退出，系统安装器根本不拉起，
 * 用户看到的是「下载中 100%」永久卡死。应用自更新链（stores/appUpdate.ts）
 * 用的是 `stage === 'ready'`，所以那条链一直是好的。
 */
describe('模块安装：轮询状态与原生词表一致', () => {
  const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')

  it('modInstall 判 ready（原生词表），不再判不存在的 done', () => {
    const src = readFileSync(SETTINGS, 'utf8')
    expect(src, '轮询还在判原生不存在的 done').not.toContain("st.state === 'done'")
    expect(src, '没有判 ready，安装器永远不会被拉起').toContain("st.state === 'ready'")
  })

  it('sync-packages 复制继承资产用快照的本次上传端点，不用被覆盖的 $rel', () => {
    /*
     * 自检循环（:558 起）会逐条把 $rel 覆盖成"被查条目自己的 release"，
     * 最后一条往往是沿用旧 release 的模块条目。复制循环若再用
     * $rel.upload_url，继承资产会被传回旧 release（already_exists 被当
     * 成功），url 却改写成新 tag——release-v1.1.7 的 tv-node 三件套就是这么
     * 丢的，全新安装模块下载 404。
     */
    const p = readFileSync(join(ROOT, 'deploy', 'scripts', 'sync-packages.ps1'), 'utf8')
    expect(p, '没有在 $rel 被覆盖前快照本次上传端点').toContain('$curUploadBase')
    const snapshotAt = p.indexOf('$curUploadBase =')
    const relOverwriteAt = p.indexOf('$rel = Get-GhApi "/repos/$Repo/releases/tags/$uTag"')
    expect(snapshotAt, '快照必须在自检循环覆盖 $rel 之前').toBeGreaterThan(-1)
    expect(relOverwriteAt).toBeGreaterThan(snapshotAt)
    // 复制循环的上传目标必须用快照（834 行那处 $rel.upload_url 是清单上传，
    // 它前面 810 行刚重新取过 $rel，合法）——只检查复制循环区间内
    const copyStart = p.indexOf('复制继承资产')
    const copyEnd = p.indexOf('继承条目的存活校验')
    expect(copyStart, '找不到复制循环').toBeGreaterThan(-1)
    expect(copyEnd).toBeGreaterThan(copyStart)
    const copyBlock = p.slice(copyStart, copyEnd)
    expect(copyBlock, '复制循环没改用快照端点').toContain('${curUploadBase}?name=$fname')
    expect(copyBlock, '复制循环还在用被覆盖的 $rel.upload_url').not.toContain('$rel.upload_url')
  })
})
