import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 本地 / 服务器目录片库：来源、穿越、去重、TV 交互。
 *
 * 这些点每一条都是"少一行就静默失效"：根来源少一个变量 → 弹窗永远空；
 * 穿越少一道校验 → 能读根外任意文件；去重缺失 → 同一目录加两次、重复扫描。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'src')
/** 仓库根：web/tests → web → apps → client → root */
const REPO = join(HERE, '..', '..', '..', '..')

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function repo(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

describe('片库根的来源与防护', () => {
  it('三种来源都读，且没有可浏览目录时返回空数组（不猜路径）', () => {
    const r = repo('server/host/src/shared/core/LibraryRoots.java')
    expect(r).toContain('MEOW_SHARE_PATHS')
    expect(r).toContain('MEOW_ALLOWED_PATHS')
    expect(r).toContain('MEOW_LIBRARY_ROOTS')
    // 空变量必须直接 return：猜 /vol1、/mnt 只会给出一堆死链接
    expect(r).toMatch(/if \(raw == null \|\| raw\.trim\(\)\.isEmpty\(\)\) return;/)
  })

  it('穿越防护两道：normalize 后仍在根内 + toRealPath 再复核（挡符号链接逃逸）', () => {
    const r = repo('server/host/src/shared/core/LibraryRoots.java')
    expect(r).toContain('!candidate.startsWith(root)')
    expect(r).toContain('toRealPath')
    expect(r).toMatch(/if \(!real\.startsWith\(realRoot\)\)/)
    // 本地块设备不能被当成共享名（否则整卷显示成 sda1）
    expect(r).toContain('dev.startsWith("//")')
  })

  it('网络挂载用共享名做 label（//host/视频 → 视频，而不是内部卷名）', () => {
    const r = repo('server/host/src/shared/core/LibraryRoots.java')
    expect(r).toContain('mountLabel')
    expect(r).toContain('/proc/mounts')
  })

  it('三端点在 lib 分支之前分发，且列目录有 3 秒上限', () => {
    const r = repo('server/host/src/shared/routes/LibraryRoutes.java')
    const iAction = r.indexOf('"roots".equals(action)')
    const iLib = r.indexOf('String libId = Api.trimToEmpty(q.get("lib"))')
    expect(iAction).toBeGreaterThan(0)
    // 放到 lib 分支后面就会被"没指定库→返回配置"吃掉，弹窗只能拿到 libs
    expect(iLib).toBeGreaterThan(iAction)
    expect(r).toContain('"capabilities".equals(action)')
    expect(r).toContain('lsWithTimeout')
    // 远程挂载（FUSE）可能卡住：没有超时就是前端永远转圈
    expect(r).toMatch(/TimeUnit\.MILLISECONDS/)
    // 守护线程池：卡死的列举不能拖累 JVM 退出
    expect(r).toContain('setDaemon(true)')
  })

  it('根去重：同根拒绝并指名冲突库，父子只警告', () => {
    const lib = repo('server/host/src/shared/core/Library.java')
    expect(lib).toContain('saveConfigEx')
    expect(lib).toContain('DUP_ROOT')
    expect(lib).toContain('overlaps')
    // 本地路径必须走真实路径归一化（/a 与 /a/ 与 /a/../a 是同一个）
    expect(lib).toContain('toRealPath')
  })
})

describe('选择目录弹窗：语义与 TV 交互', () => {
  it('本机选择器只在本机后端出现（远程后端读不到本机路径）', () => {
    const dlg = src('components/library/LibraryAddDialog.vue')
    expect(dlg).toMatch(/onDesktop && localBackend/)
    expect(dlg).toMatch(/localBackend && tvDirBridge\(\)/)
    expect(src('api/index.ts')).toContain('export function backendIsLocal')
  })

  it('文案跟着后端位置走：本地片库/服务器片库、本地目录/服务器目录', () => {
    expect(src('views/LibraryView.vue')).toContain("backendIsLocal() ? '本地片库' : '服务器片库'")
    expect(src('components/library/LibraryAddDialog.vue')).toContain("'服务器目录'")
  })

  it('TV 焦点：落第一个目录、pin=true、空根跳过、返回逐级退', () => {
    const dlg = src('components/library/LibraryAddDialog.vue')
    expect(dlg).toContain('focusFirstDir')
    // pin=false 时方向键不接管焦点（tv-nav 只在钉住时走几何移动）
    expect(dlg).toMatch(/if \(f\) f\(el, true\)/)
    // 右栏空目录时焦点要有去处
    expect(dlg).toContain('pickerRootsEl')
    // 返回：子目录先回上一层，到根才关弹窗
    expect(dlg).toMatch(/pickerStack\.value\.length > 0[\s\S]{0,90}upDir\(\)/)
    // 打开时自动跳到第一个有内容的根（应用共享目录装完是空的）
    expect(dlg).toMatch(/!pickerDirs\.value\.length && roots\.length > 1/)
  })

  it('弹层遵守 TV 弹框三约定（Teleport / scope / 稳定路径钩子）', () => {
    const dlg = src('components/library/LibraryAddDialog.vue')
    expect(dlg).toContain('Teleport to="body"')
    expect(dlg).toContain('data-tv-scope')
    expect(dlg).toContain('data-picker-path')
  })
})

describe('fpk 与 Docker 侧的落地', () => {
  it('supervisor 透传授权目录，并钉 UTF-8 locale（中文目录必需）', () => {
    const sup = repo('client/apps/fnos/meowd/src/supervisor.rs')
    expect(sup).toContain('TRIM_DATA_ACCESSIBLE_PATHS')
    expect(sup).toContain('MEOW_ALLOWED_PATHS')
    expect(sup).toContain('TRIM_DATA_SHARE_PATHS')
    expect(sup).toContain('MEOW_SHARE_PATHS')
    // Paths.get 用 sun.jnu.encoding；只给 -D 不够，Java 21 还要 LANG
    expect(sup).toContain('sun.jnu.encoding')
    expect(sup).toContain('C.UTF-8')
  })

  it('wizard_library_mode 不再是死选项（share 时建首个库）', () => {
    const cb = repo('client/apps/fnos/fpk/cmd/install_callback')
    expect(cb).toContain('wizard_library_mode')
    expect(cb).toContain('library.json')
    expect(cb).toContain('chown meow:meow')
  })

  it('四个 compose 都声明了 MEOW_LIBRARY_ROOTS', () => {
    for (const f of [
      'docker-compose.yml',
      'docker-compose.build.yml',
      'docker-compose.standalone.yml',
      'docker-compose.with-sources.yml',
    ]) {
      expect(repo('deploy/docker/' + f)).toContain('MEOW_LIBRARY_ROOTS')
    }
  })
})
