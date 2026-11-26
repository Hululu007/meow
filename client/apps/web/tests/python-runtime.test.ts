/**
 * iOS 端内 CPython 运行时（2026-11-26）：
 *
 * 目标：`.py` 源不依赖局域网 pyrt，和 PC/Docker 一样本地执行；
 * 同时控制包体（裁剪标准库/dynload、只带 requests/bs4、AES 用纯 Python shim）。
 *
 * 这些是构建期契约：少一个环节 CI 的 IPA 就缺运行时，真机表现为 .py 源全挂。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const WEB = join(__dirname, '..')
const ROOT = join(WEB, '..', '..', '..')
const IOS = join(ROOT, 'client', 'apps', 'ios')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const prep = read(join(IOS, 'scripts', 'prepare-python-payload.sh'))
const project = read(join(IOS, 'project.yml'))
const bridge = read(join(IOS, 'Meow', 'NodeBridge.swift'))
const pyrt = read(join(IOS, 'Meow', 'PythonRuntime.swift'))
const cbridge = read(join(IOS, 'Meow', 'MeowPython.c'))
const ci = read(join(ROOT, '.github', 'workflows', '_ios.yml'))

describe('载荷组装', () => {
  it('下载 Python-Apple-support 3.12 并裁剪标准库/dynload', () => {
    expect(prep).toContain('Python-${PV}-iOS-support')
    expect(prep).toContain('Python.xcframework/ios-arm64/Python.framework')
    // 大块无关目录必须裁掉（test 单项 ~27MB）
    for (const d of ['test', 'idlelib', 'tkinter', 'ensurepip', 'lib2to3']) {
      expect(prep).toContain(d)
    }
    expect(prep).toContain('_ssl.cpython-312-iphoneos.so')
    expect(prep).toContain('_sysconfigdata')
  })

  it('第三方只带纯 Python wheel，AES/Hash 用 shim', () => {
    expect(prep).toContain('requests urllib3 certifi idna charset-normalizer beautifulsoup4 soupsieve')
    expect(prep).toContain('python-shim/Crypto')
    expect(existsSync(join(IOS, 'python-shim', 'Crypto', 'Cipher', 'AES.py'))).toBe(true)
    expect(existsSync(join(IOS, 'python-shim', 'Crypto', 'Util', 'Padding.py'))).toBe(true)
  })

  it('pyrt.py 随 runtime 一起打包', () => {
    expect(prep).toContain('server/pyrt/pyrt.py')
    expect(prep).toContain('"$RT/pyrt.py"')
  })

  it('C 扩展进 Frameworks/pyext（侧载器只递归签名 Frameworks）', () => {
    expect(prep).toContain('DYN="$OUT/extensions"')
    expect(project).toContain('build/python/extensions')
    expect(project).toContain('destination: frameworks')
    expect(pyrt).toContain('Frameworks/pyext')
  })
})

describe('Xcode 工程 / CI', () => {
  it('framework embed + runtime 资源 + 头文件路径', () => {
    expect(project).toContain('build/python/Python.framework')
    expect(project).toContain('path: build/python/runtime')
    expect(project).toContain('build/python/Python.framework/Headers')
    // 模拟器包不带 CPython（只有真机切片）
    expect(project).toContain('- MeowPython.c')
  })

  it('CI 缓存并校验 CPython 产物', () => {
    expect(ci).toContain('client/apps/ios/build/python')
    expect(ci).toContain('prepare-python-payload.sh')
    expect(ci).toContain('_ssl.cpython-312-iphoneos.so')
    expect(ci).toContain('Python.framework/Python')
  })
})

describe('启动链路', () => {
  it('C 桥在后台线程 Py_Initialize 并执行 pyrt', () => {
    expect(cbridge).toContain('Py_Initialize()')
    expect(cbridge).toContain('PyRun_FileExFlags')
    expect(cbridge).toContain('pthread_create')
  })

  it('drpy 就绪后拉起 Python，可用则 jsRuntime 指向 pyrt', () => {
    expect(bridge).toContain('PythonRuntime.startIfPossible()')
    expect(bridge).toContain('PythonRuntime.waitHealthy(timeout: 25)')
    expect(bridge).toContain('writeJsRuntime(url:')
    // 端内 loopback 地址允许升级，自定义远端保留
    expect(bridge).toContain('!t.hasPrefix("http://127.0.0.1:")')
    expect(pyrt).toContain('PYTHONHOME')
    expect(pyrt).toContain('PYRT_SCRIPTS')
    expect(pyrt).toContain('PYRT_DRPY')
  })
})
