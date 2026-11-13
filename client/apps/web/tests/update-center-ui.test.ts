import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

/**
 * 模块链的 git 加速接入（2026-11-12 用户问「模块安装是否需要参与，
 * 避免连不上 github 的用户」）。
 *
 * 事实：模块清单与 50MB 的模块 APK 都在 GitHub 上；应用自更新一直有候选
 * 列表（直连+代理+jsDelivr），模块链原先只传单地址 → 被墙用户能更新壳、
 * 却装不上模块。修复后：
 *   · 清单：按 downloadCandidates(src) 逐个试 moduleCheck
 *   · APK：把清单 url 的候选 join('|') 传给 moduleDownload（原生逐个试）
 *   · 原生侧新增 fetchManifestAny + moduleCheck/moduleDownload 三参重载，
 *     且候选必须包含原始 url（防止被换下载目标）
 */
describe('模块链参与 git 加速', () => {
  const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
  const STORE = join(ROOT, 'client', 'apps', 'web', 'src', 'stores', 'updateCenter.ts')
  const BRIDGE = join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'TvBridge.java')
  const UPDATER = join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'AppUpdater.java')

  it('设置页：清单按候选逐个试，APK 候选 join 后传给 moduleDownload', () => {
    const src = readFileSync(SETTINGS, 'utf8')
    // 2026-11-12：优先把**整个候选列表**交给原生非阻塞任务（netJobStart +
    // manifest-any，原生线程里逐个试），老壳才回退到 JS 里逐个 moduleCheck。
    // 两种形态都算"按候选试"，所以两条都要锁住，避免有人只删掉其中一条。
    expect(src).toContain("downloadCandidates(src).join('|')")
    expect(src).toContain("for (const c of pipe.split('|'))")
    expect(src).toContain('b.moduleDownloadCandidates(src, tok, assetCands)')
    expect(src).toContain("downloadCandidates(String(chk.url)).join('|')")
    // 轮询超时必须有结论，不能停在「下载中 100%」
    expect(src).toContain('安装超时')
  })

  it('更新中心 checkModule 同样按候选试清单', () => {
    const src = readFileSync(STORE, 'utf8')
    expect(src).toContain('for (const c of downloadCandidates(src))')
  })

  it('原生：清单支持多候选，模块下载校验候选必须包含原地址', () => {
    const up = readFileSync(UPDATER, 'utf8')
    expect(up, '缺 fetchManifestAny').toContain('public static String fetchManifestAny')
    expect(up).toContain('contains("\\"packages\\"")')
    const br = readFileSync(BRIDGE, 'utf8')
    expect(br).toContain('public String moduleCheckCandidates(String source, String token, String urlsPipe)')
    expect(br).toContain('public String moduleDownloadCandidates(String source, String token, String urlsPipe)')
    // Android WebView 的 JS 桥不支持同名重载：三参版必须用独立名字
    expect(br, '桥方法又出现了同名重载').not.toContain(
      'public String moduleCheck(String source, String token, String urlsPipe)',
    )
    expect(br, '桥方法又出现了同名重载').not.toContain(
      'public String moduleDownload(String source, String token, String urlsPipe)',
    )
    expect(br, '候选没有"必须包含原 url"的安全闸').toContain('if (!c.contains(real)) continue;')
  })
})

/**
 * 更新检查的性能/体验护栏（2026-11-12）。
 *
 * 这几条都是"性能与体验"，跑不出单元测试，只能断言源码形态：
 *   - 候选线路必须**并发**（串行时一次检查 30–40 秒，全在等前面失败的线路）
 *   - 检查要有取消出口（最多 4 条线路并发，最坏要等几十秒）
 *   - `/api/health` 要合并（同一次进设置页会打两三次）
 *   - 设置页分区要懒挂载（14 个分区一次性建几千个节点，TV 的焦点扫描变重）
 *   - 直播源要进分区才拉（冷缓存要现拉远端 m3u）
 */
describe('更新检查与设置页的性能护栏', () => {
  const UPDATER = join(
    ROOT,
    'client',
    'apps',
    'tv',
    'app',
    'src',
    'main',
    'java',
    'com',
    'meow',
    'tv',
    'AppUpdater.java',
  )
  const API = join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'index.ts')
  const UPD = join(ROOT, 'client', 'apps', 'web', 'src', 'api', 'appUpdate.ts')
  const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')

  it('候选线路并发竞速，不是一个一个串行试', () => {
    const up = readFileSync(UPDATER, 'utf8')
    const body = up.slice(up.indexOf('public static String fetchManifestAny'))
    expect(body, 'fetchManifestAny 里没有并发线程').toContain('new Thread(')
    expect(body, 'fetchManifestAny 里没有并发线程').toContain('meow-manifest-race')
    // 旧的串行写法（for 里直接 fetchManifest 并逐个判断）不能再出现
    expect(body).not.toMatch(
      /for \(String raw : urlsPipe[\s\S]{0,240}?String text = fetchManifest\(u, token\)/,
    )
  })

  it('检查可以取消', () => {
    const upd = readFileSync(UPD, 'utf8')
    expect(upd, '缺取消入口').toContain('export function cancelAppUpdateCheck')
    const s = readFileSync(SETTINGS, 'utf8')
    expect(s, '设置页没有取消按钮').toContain('cancelUpdCheck')
    expect(s, '检查按钮没有耗时').toContain('检查中…')
  })

  it('/api/health 合并同一次请求', () => {
    const api = readFileSync(API, 'utf8')
    expect(api, '缺 health 合并缓存').toContain('HEALTH_TTL_MS')
    expect(api, '缺 health 合并缓存').toContain('healthInflight')
  })

  it('设置页分区懒挂载 + 直播源进分区才拉', () => {
    const s = readFileSync(SETTINGS, 'utf8')
    expect(s, '缺分区懒挂载').toContain('visitedSec')
    expect(s, '缺分区懒挂载').toContain('min-h-[20rem]')
    /*
     * 2026-11-13 用户报「滚动后才出现下一配置区，远没有改之前有体验」：
     * 懒挂载只该对**真电视**（遥控器几何选焦）生效，PC/Web/触屏一律立即渲染。
     * 这两条断言防止后人把守卫删掉——删了 PC 上又是一屏空卡片。
     */
    expect(s, '懒挂载缺「仅电视」守卫').toContain('const lazySections = tvMode && !isTouchDevice')
    expect(s, 'visitedSec 缺非电视直通').toContain('if (!lazySections) return true')
    expect(s, '直播源仍在 onMounted 里拉').not.toContain('void refreshLives()')
    expect(s, '缺 ensureLives').toContain('ensureLives')
  })

  /**
   * TV 端不许再有"永不超时"的读等待。
   *
   * readTimeout(0) = 无限：连接断掉时线程永远等下去，任务卡在"进行中"，
   * 后续操作全被挡住，用户看到的是"点了没反应"。2026-11-12 之前 TV 上
   * 有两处这种写法（更新清单、缓存下载），都已改成有上限。
   */
  it('TV 端没有"永不超时"的读等待', () => {
    const dir = join(
      ROOT,
      'client',
      'apps',
      'tv',
      'app',
      'src',
      'main',
      'java',
      'com',
      'meow',
      'tv',
    )
    const hits: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.java')) continue
      const src = readFileSync(join(dir, f), 'utf8')
      if (src.includes('readTimeout(0') || src.includes('setReadTimeout(0')) hits.push(f)
    }
    expect(hits, '这些文件还在无限等待：' + hits.join(', ')).toEqual([])
  })
})
