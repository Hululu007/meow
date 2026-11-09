import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PC 端 Tauri 命令不能阻塞主线程，子进程不能弹黑框。
 *
 * ## 起因（用户实测反馈）
 *
 * > "一进设置页就出现 2、3 次 curl 命令弹框" +
 * > "之前弹框时应用会卡死无响应，弹框结束才能动"
 *
 * 两件事同源，都是 Tauri 命令的实现问题：
 *
 * 1. **黑框**：命令内部 `Command::new(curl)` 起控制台程序，Windows 上会
 *    附带新控制台窗口。必须传 `CREATE_NO_WINDOW`（见 `src-tauri/src/proc.rs`）。
 * 2. **卡死**：**同步**的 `#[tauri::command]` 跑在 Tauri 主线程上。命令体里
 *    一旦有 curl 子进程，整块 GUI 就冻住直到它返回 —— 而 curl 最长 30s 超时、
 *    清单还要试 2 个候选地址 × 多次重试。
 *
 * ## 为什么写成源码断言而不是跑真实命令
 *
 * 这两条是**结构**约束，不是运行期行为：跑测试需要 GUI 主线程和一个会超时的
 * 网络源，在 CI 里既慢又不稳。读源码断言能精确锁住"哪个命令必须是 async"，
 * 改坏了立刻红。与 `search-async.test.ts`（断言 Java 侧把搜索丢到后台池）
 * 同一个套路。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SRC = join(ROOT, 'client', 'apps', 'desktop', 'src-tauri', 'src')
const LIB = join(SRC, 'lib.rs')
const PROC = join(SRC, 'proc.rs')
const INSTALLER = join(SRC, 'installer.rs')
const APPUPDATE = join(SRC, 'appupdate.rs')

/**
 * 判断一个命令的定义是不是 async。
 *
 * ★ 不用正则：模板字符串里的反斜杠转义规则在 heredoc / 编辑器之间不一致，
 *   写出来的正则到底匹配什么很难验证（这一点本身踩过一次）。
 *   用纯字符串查找，行为一目了然。
 */
function isAsyncFn(src: string, name: string): boolean {
  const i = src.indexOf(`fn ${name}(`)
  if (i < 0) throw new Error(`命令 ${name} 的定义没找到（改名了？测试要同步更新）`)
  const before = src.slice(Math.max(0, i - 12), i)
  return before.includes('async')
}

/** 取一个函数体（到下一个 `#[tauri::command]` 或文件尾） */
function bodyOf(src: string, name: string): string {
  const i = src.indexOf(`fn ${name}(`)
  if (i < 0) throw new Error(`命令 ${name} 的定义没找到`)
  const next = src.indexOf('#[tauri::command]', i)
  return src.slice(i, next > 0 ? next : src.length)
}

describe('PC 命令不阻塞主线程', () => {
  /*
   * 这些命令体内会起子进程（curl / tar），必须 async + spawn_blocking。
   * 改回同步的直接症状就是"界面冻住，黑框消失才恢复"。
   */
  const mustBeAsync = [
    'plugin_index', // 进设置页就调 → 内部 fetch_index → curl（黑框最多的一处）
    'plugin_test_source', // 「测试源」按钮 → curl
    'plugin_import', // 本地 zip 导入 → tar 解压
    'plugin_uninstall', // 停进程 + 删目录（Windows 文件锁会等待）
    'plugin_install', // 下载 + 解压（本来就 async，防回退）
    'app_update_manifest_text', // 启动检查更新 → curl
    'app_update_download', // 下载安装包 → curl
  ]

  for (const name of mustBeAsync) {
    it(`${name} 是 async`, () => {
      expect(
        isAsyncFn(readFileSync(LIB, 'utf8'), name),
        `${name} 变成了同步命令，会冻住 UI`,
      ).toBe(true)
    })
  }

  it('async 命令体真的有 spawn_blocking（只加 async 不够）', () => {
    const src = readFileSync(LIB, 'utf8')
    /*
     * 只把 `fn` 改成 `async fn`、函数体仍在原处，等于把阻塞调用搬到 async
     * runtime 的 worker 上 —— 那会饿死整个 runtime（比冻 UI 更糟：所有并发
     * 命令一起卡）。必须落到 spawn_blocking 的阻塞线程池。
     */
    const names = ['plugin_index', 'plugin_test_source', 'plugin_import', 'plugin_uninstall']
    for (const name of names) {
      expect(bodyOf(src, name), `${name} 是 async 但没走 spawn_blocking`).toContain(
        'spawn_blocking',
      )
    }
  })
})

describe('子进程不弹黑框', () => {
  it('proc.rs 用 DETACHED_PROCESS（CREATE_NO_WINDOW 在 Win11 不够）', () => {
    const p = readFileSync(PROC, 'utf8')
    /*
     * ★ 实测结论（2026-10-30，Win11 + Windows Terminal 默认终端）：
     * CREATE_NO_WINDOW 的语义是"创建控制台但隐藏窗口"，而默认终端处理器
     * 接管新控制台时会新开 Terminal 窗口（类名 CASCADIA_HOSTING_WINDOW_CLASS）
     * —— 那个窗口属于 Terminal 进程，不受"隐藏控制台窗口"约束。
     * DETACHED_PROCESS 是"根本不创建控制台"，从源头解决。
     *
     * 反例验证：把 quiet 改成空操作重建 → 能抓到该窗口；改回 → 0 个。
     */
    expect(p, '缺 DETACHED_PROCESS 常量（改回只有 CREATE_NO_WINDOW 会弹终端）').toContain(
      '0x0000_0008',
    )
    expect(p, '没有 cfg(windows) 守卫（非 Windows 平台会编译失败）').toContain(
      '#[cfg(windows)]',
    )
    expect(p, '缺 CommandExt').toContain('CommandExt')
    expect(p, '缺 creation_flags 调用').toContain('creation_flags')
    expect(p, 'creation_flags 里没用 DETACHED_PROCESS').toMatch(/DETACHED_PROCESS\s*\|/)
  })

  /**
   * 扫描文件里所有**真实的** `Command::new(...)` 调用点，
   * 要求每处附近都出现 `proc::quiet`。
   *
   * ★ 必须跳过注释：文档里有大量 `Command::new(exe)` 这样的讲解
   *   （"直接 Command::new 在某些环境缺工作目录会异常"），
   *   把它们当调用点会误报。判据是"去掉行尾注释后再看有没有 Command::new"。
   */
  function countQuietSites(file: string, label: string, windowLines: number): number {
    const lines = readFileSync(file, 'utf8').split('\n')
    let checked = 0
    for (let i = 0; i < lines.length; i++) {
      // 去掉行尾注释后再判（文档注释整行都是 //，自然被排除）
      const code = lines[i].split('//')[0]
      if (!code.includes('Command::new(')) continue
      /*
       * 非 Windows 平台的启动分支不需要压窗口：macOS 的 `open` / Linux 的
       * `xdg-open` 是 GUI 程序，本来就不带控制台。把它们算进"未压窗口"
       * 会让测试变红，但修起来只能加一句空操作 —— 那是噪音不是保障。
       */
      const ctx = lines.slice(Math.max(0, i - 3), i + 1).join(String.fromCharCode(10))
      if (ctx.includes('cfg(not(target_os = "windows"))')) continue
      checked++
      // 压窗口可能在 .spawn()/.output() 之前，也可能隔几行（.args 链式）
      const win = lines.slice(i, i + windowLines).join('\n')
      expect(win, `${label}:${i + 1} 的 Command::new 没压窗口`).toContain('proc::quiet')
    }
    return checked
  }

  it('installer.rs 的每个 curl / tar 都压了窗口', () => {
    const n = countQuietSites(INSTALLER, 'installer.rs', 14)
    expect(n, 'installer.rs 应有 3 处子进程（下载/清单/tar），扫到的不对').toBeGreaterThanOrEqual(
      3,
    )
  })

  it('appupdate.rs 的每个 curl 都压了窗口', () => {
    const n = countQuietSites(APPUPDATE, 'appupdate.rs', 18)
    expect(n, 'appupdate.rs 应有 3 处子进程（清单/下载/cmd start），扫到的不对').toBeGreaterThanOrEqual(
      3,
    )
  })
})

describe('进设置页不做无谓请求', () => {
  it('没配插件源时 loadIndex 直接返回', () => {
    const src = readFileSync(
      join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue'),
      'utf8',
    )
    const i = src.indexOf('async function loadIndex')
    expect(i, '找不到 loadIndex').toBeGreaterThan(-1)
    const body = src.slice(i, i + 900)
    expect(body, 'loadIndex 没有"没配源就跳过"的守卫').toContain('sources.value.current')
    expect(body, 'loadIndex 没有并发守卫（连点会叠加请求）').toContain('indexLoading.value')
  })

  it('索引拉取有缓存，失败也缓存（否则每次进页面都重试）', () => {
    const src = readFileSync(INSTALLER, 'utf8')
    expect(src, '缺 index_cache 字段').toContain('index_cache')
    expect(src, '缓存没区分成功/失败 TTL').toContain('IndexCache')
    expect(src, '失败也要缓存').toContain('ok: result.is_ok()')
  })
})
