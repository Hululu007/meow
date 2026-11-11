import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「好多源点进去 500」的可诊断化。
 *
 * 2026-11-11 实测（.76 设备网关，171 个源逐个打 home）：
 *   200 有数据 50 · 200 空壳 53 · 500 **66** · 超时 2
 * 66 个 500 里 58 个是同一类：jar 的源类依赖了当前构建没有的类 ——
 *   `com.github.catvod.spider.DexNative`（整族 *Guard 源）
 *   `com.thegrizzlylabs.sardineandroid.Sardine`（WebDAV 源）
 *
 * 但这些 500 冒到最外层 dispatcher，没经过 recordHealth → 永远不标 unsupported，
 * 用户每次点都再撞一次 500，界面上只有"服务器错误"。
 *
 * 门禁三件事：
 *   ① 实例化失败回结构化错误（含"缺少哪个类"），不是 500
 *   ② 失败要记健康（前缀 cannot load spider → classify=unsupported）
 *   ③ 预热期也记，冷启动后站点列表就能看出哪些跑不了
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const J = readFileSync(join(ROOT, 'server', 'host', 'src', 'shared', 'ApiServer.java'), 'utf8')

describe('源实例化失败：不 500、可分类、说清缺什么', () => {
  it('实例化失败返回结构化错误并指出缺失类', () => {
    expect(J, '没提取缺失类').toMatch(/private static String missingClassOf\(/)
    expect(J, '缺类的两种消息形态没覆盖').toContain('Failed resolution of: L')
    expect(J).toContain("Didn't find class")
    expect(J, '用户看到的还是 500 而不是人话').toContain('该源在当前构建不可用')
  })

  it('失败要进健康表（classify 靠 cannot load spider 判 unsupported）', () => {
    expect(J, '没拼 classify 认得的字样').toMatch(/return "cannot load spider " \+ site/)
    // call()：instance 抛错 → recordHealth + 返回 code -1
    expect(J).toMatch(/o = instance\(site\);[\s\S]{0,2000}recordHealth\(site, false/)
    // warmup：冷启动就分类
    expect(J).toMatch(/warmInstance[\s\S]{0,1800}loadFailureChain\(site, t\)/)
  })
})
