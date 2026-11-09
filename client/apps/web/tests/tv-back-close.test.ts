import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 两个返回键缺口（2026-11-03 用户实测）。
 *
 * 1. 连接弹层：连按两次 BACK 都不关。App.vue 的 __meowTvConsumeBack 只向
 *    document 派发 Escape，组件不监听就没人关。
 * 2. 主题上传：点「上传图片」后系统文件选择器根本没打开（WebChromeClient
 *    没实现 onShowFileChooser），BACK 被当成页面返回，路由从 #/settings
 *    退到 #/ai。
 *
 * 这两条都不在浏览器里复现（浏览器有自己的文件选择器和 Esc），
 * 所以用源码契约锁住，真机轨迹另存在 tmp/2026-11-03-tv-方向键/。
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const SETTINGS = join(ROOT, 'client', 'apps', 'web', 'src', 'views', 'SettingsView.vue')
const MAIN = join(
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
  'MainActivity.java',
)
const CACHE = join(
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
  'CacheDownloader.java',
)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('返回键：连接弹层', () => {
  it('Escape 处理同时覆盖站点明细与连接弹层', () => {
    const s = read(SETTINGS)
    const i = s.indexOf('function onSitesKey')
    expect(i, '找不到 onSitesKey').toBeGreaterThan(-1)
    // 窗口从 260 放宽到 460：函数里新增了扫码弹层分支（2026-11-04），
    // 断言的内容没变，只是正文变长了
    const body = s.slice(i, i + 460)
    expect(body, '没判 Escape').toContain("e.key !== 'Escape'")
    expect(body, '站点明细的关闭行为被改掉了').toContain('closeSites()')
    // 缺这一段就是"连按两次 BACK 弹框仍不关"的直接原因
    expect(body, '连接弹层没有接 Escape').toContain('connDialog.open')
    expect(body, '连接弹层没有调用 closeConnDialog').toContain('closeConnDialog()')
  })

  it('closeConnDialog 只关弹层，不停掉别的东西', () => {
    const s = read(SETTINGS)
    const i = s.indexOf('function closeConnDialog')
    expect(i).toBeGreaterThan(-1)
    const body = s.slice(i, i + 160)
    expect(body).toContain('connDialog.open = false')
    expect(body, '扫描轮询不停会一直读桥').toContain('stopConnPoll()')
  })

  it('keydown 监听在 onMounted 挂、onBeforeUnmount 清', () => {
    const s = read(SETTINGS)
    expect(s).toContain("document.addEventListener('keydown', onSitesKey)")
    expect(s).toContain("document.removeEventListener('keydown', onSitesKey)")
  })

  it('弹层仍是 data-tv-scope，焦点才有归还可依', () => {
    const s = read(SETTINGS)
    const i = s.indexOf('connDialog.open')
    expect(i).toBeGreaterThan(-1)
    const around = s.slice(Math.max(0, i - 400), i + 1200)
    expect(around, '连接弹层缺 data-tv-scope，tv-nav 收不窄范围').toContain('data-tv-scope')
    expect(s, '触发入口缺 openConnDialog').toContain('@click="openConnDialog()"')
  })
})

describe('返回键：主题上传的文件选择器', () => {
  it('WebChromeClient 实现了 onShowFileChooser', () => {
    const m = read(MAIN)
    const i = m.indexOf('onShowFileChooser')
    expect(i, '缺 onShowFileChooser：点上传不会打开任何界面').toBeGreaterThan(-1)
    const end = m.indexOf('});', m.indexOf('return false;', i))
    const body = m.slice(i, end > i ? end : i + 1200)
    expect(body, '没走 startActivityForResult 就拿不到选择结果').toContain(
      'startActivityForResult(params.createIntent(), REQ_FILE_CHOOSER)',
    )
    expect(body, '失败时要显式回取消，否则控件永远等待').toContain(
      'callback.onReceiveValue(null)',
    )
  })

  it('请求码与 CacheDownloader 的目录授权分开', () => {
    const m = read(MAIN)
    const req = m.match(/REQ_FILE_CHOOSER\s*=\s*(0x[0-9A-Fa-f]+)/)
    expect(req, '缺 REQ_FILE_CHOOSER 常量').not.toBeNull()
    const cache = read(CACHE).match(/REQ_TREE\s*=\s*(0x[0-9A-Fa-f]+)/)
    expect(cache, 'CacheDownloader 的 REQ_TREE 改了？').not.toBeNull()
    expect(Number(req![1]), '请求码与目录授权撞了').not.toBe(Number(cache![1]))
  })

  it('onActivityResult 先处理文件选择，再走 CacheDownloader', () => {
    const m = read(MAIN)
    const fileAt = m.indexOf('requestCode == REQ_FILE_CHOOSER')
    expect(fileAt, 'onActivityResult 没接文件选择结果').toBeGreaterThan(-1)
    const cacheAt = m.indexOf('CacheDownloader.handleResult', fileAt)
    expect(cacheAt, '顺序反了：目录授权会先吃掉文件选择结果').toBeGreaterThan(fileAt)
  })

  it('取消（RESULT_CANCELED）回 null 且不触发 change', () => {
    const m = read(MAIN)
    const i = m.indexOf('requestCode == REQ_FILE_CHOOSER')
    const body = m.slice(i, i + 1000)
    // result 默认 null：非 RESULT_OK 分支不赋值，页面拿到 null = 取消
    expect(body, '缺少 result 默认 null').toContain('Uri[] result = null')
    expect(body).toContain('resultCode == RESULT_OK')
    // 回调必须消费并清空，否则下一次点击不触发
    expect(body).toContain('fileChooserCallback = null')
    expect(body).toContain('cb.onReceiveValue(result)')
  })
})
