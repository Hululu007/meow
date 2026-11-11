import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 加载看门狗不该把"慢"当成"打不开"。
 *
 * 2026-11-11 用户报障：「点击 更多国家/地区 无反应卡死，最后出现 打不开这个地址」。
 * 实机测下来页面其实一直活着（DevTools/DebugServer 都能 eval、250 个国家都在
 * DOM 里），真正发生的是：
 *
 *   · 本机前端在这台 MuMu 上 `DOMInteractive` = **14.3 秒**（主 bundle 解析占大头）
 *   · 壳的看门狗按 **8 秒** 判死，盖了一张整屏「打不开这个地址」
 *   · 用户点什么都看不到反馈 —— 表现就是"卡死"
 *
 * 看门狗只该负责"一个字都没画出来"。所以门禁三条：
 *   ① 有内容提交（onPageCommitVisible）/ 进度 ≥10% 就撤掉
 *   ② 时间窗放宽到 12 秒（真·地址不通仍然会报）
 *   ③ 错误文案跟着改成 12 秒，别和实际不符
 */
const ROOT = join(__dirname, '..', '..', '..', '..')
const MAIN = readFileSync(
  join(ROOT, 'client', 'apps', 'tv', 'app', 'src', 'main', 'java', 'com', 'meow', 'tv', 'MainActivity.java'),
  'utf8',
)

describe('TV 壳：加载看门狗只看「有没有画面」', () => {
  it('首帧提交 / 进度起来就撤看门狗', () => {
    expect(MAIN, '没有 onPageCommitVisible 撤看门狗').toMatch(
      /onPageCommitVisible[\s\S]{0,200}cancelLoadWatchdog\(\)/,
    )
    expect(MAIN, '没有按进度撤看门狗').toMatch(
      /onProgressChanged[\s\S]{0,160}newProgress >= 10[\s\S]{0,80}cancelLoadWatchdog\(\)/,
    )
  })

  it('时间窗放宽到 30 秒，文案与实际一致', () => {
    expect(MAIN, '看门狗窗口没放宽').toMatch(/postDelayed\(watchdog, 30000\)/)
    expect(MAIN, '文案还写着 8 秒').not.toMatch(/8 秒内没有加载完成/)
    expect(MAIN).toContain('30 秒内没有加载完成')
  })

  it('只有首次加载用定时判死，重载一律不挂', () => {
    // 首次加载：冷 bundle 解析慢（实测 14.3s），留 30 秒兜底"什么都没有"
    expect((MAIN.match(/armLoadWatchdog\("/g) || []).length, '定时判死只该剩首次加载').toBe(1)
    // 重载（自启注入 / 换后端 / 重新连接）：页面已经活着，慢≠打不开
    expect(MAIN, '重载还在挂看门狗').not.toContain('armReloadWatchdog')
    // 失败兜底交给 onReceivedError，不能靠定时器
    expect(MAIN).toContain('onReceivedError')
  })
})
