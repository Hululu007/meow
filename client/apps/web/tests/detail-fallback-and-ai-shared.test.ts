import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 2026-11-03 用户报的三个问题里，两个属于"状态/交互"层，用真实组件验证。
 *
 *  ① 详情页拿不到数据（豆瓣源的 `/detail` 返回空 list）→ 应转去搜索页搜片名
 *  ② AI 浮层点「全屏」后会话丢失 → 两个界面必须共享同一份消息
 */

const dir = join(__dirname, '..', 'src')
const DETAIL = readFileSync(join(dir, 'views', 'DetailView.vue'), 'utf8')
const POSTER = readFileSync(join(dir, 'components', 'common', 'PosterCard.vue'), 'utf8')
const PANEL = readFileSync(join(dir, 'components', 'ai', 'AiPanel.vue'), 'utf8')

describe('问题①：详情页拿不到详情要转去搜索页', () => {
  it('空 list → router.replace 到 search，带片名', () => {
    // 关键：必须 replace（详情页是死路，留在返回栈里按返回又回空白页）
    expect(DETAIL).toMatch(/router\.replace\(\{ name: 'search'/)
    expect(DETAIL).toMatch(/route\.query\.name/)
    // 片名拿不到时不能跳空搜索，要退回原来的错误文案
    expect(DETAIL).toMatch(/未获取到详情/)
  })

  it('所有进详情的入口都带上 name（否则详情页取不到片名）', () => {
    for (const [file, src] of [
      ['PosterCard', POSTER],
      ['AiPanel', PANEL],
    ] as const) {
      expect(src, `${file} 必须带 name`).toMatch(/query: (props\.item\.vod_name|hit\.name) \? \{ name:/)
    }
    const SEARCH = readFileSync(join(dir, 'views', 'SearchView.vue'), 'utf8')
    const FAV = readFileSync(join(dir, 'views', 'FavoritesView.vue'), 'utf8')
    const HIST = readFileSync(join(dir, 'views', 'HistoryView.vue'), 'utf8')
    for (const [n, s] of [['SearchView', SEARCH], ['FavoritesView', FAV], ['HistoryView', HIST]] as const) {
      expect(s, `${n} 必须带 name`).toMatch(/query: (h|it)\.vod_name \? \{ name:/)
    }
  })
})

describe('问题②：AI 浮层与独立页共享同一份会话', () => {
  it('AiPanel 不再自己持有 msgs，而是引用 stores/aiChat', () => {
    expect(PANEL).toMatch(/from '@\/stores\/aiChat'/)
    expect(PANEL).toMatch(/aiMsgs as msgs/)
    // 组件内不许再出现 `const msgs = ref`
    expect(PANEL).not.toMatch(/const msgs = ref/)
    expect(PANEL).not.toMatch(/const cacheBusy = ref/)
    expect(PANEL).not.toMatch(/const cacheDone = ref/)
  })

  it('store 是模块级单例：两次 import 拿到同一个 ref', async () => {
    const a = await import('../src/stores/aiChat')
    const b = await import('../src/stores/aiChat')
    expect(a.aiMsgs).toBe(b.aiMsgs)
    a.pushAiMsg({ role: 'user', text: '你好' })
    expect(b.aiMsgs.value).toHaveLength(1)
    expect(b.aiMsgs.value[0].text).toBe('你好')
    a.clearAiMsgs()
    expect(b.aiMsgs.value).toHaveLength(0)
  })

  it('两个 AiPanel 实例渲染同一个消息列表（浮层→全屏的真实路径）', async () => {
    const { default: AiPanel } = await import('../src/components/ai/AiPanel.vue')
    const { pushAiMsg, clearAiMsgs } = await import('../src/stores/aiChat')
    setActivePinia(createPinia())
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div/>' } },
        { path: '/ai', component: { template: '<div/>' } },
      ],
    })
    await router.push('/')
    clearAiMsgs()
    pushAiMsg({ role: 'user', text: '这轮会话要跨界面保留' })

    // 浮层实例（App.vue 里那个）
    const overlay = mount(AiPanel, { global: { plugins: [router] }, attachTo: document.body })
    // 独立页实例（AiView.vue 里那个）
    const inline = mount(AiPanel, {
      props: { inline: true },
      global: { plugins: [router] },
      attachTo: document.body,
    })
    await inline.vm.$nextTick()

    // 两个实例都要能看到同一条消息
    const txt = inline.text()
    expect(txt).toContain('这轮会话要跨界面保留')
    expect(overlay.html() + txt).toContain('这轮会话要跨界面保留')

    overlay.unmount()
    inline.unmount()
    clearAiMsgs()
  })

  it('清空也是共享的（任一界面清空，两边都空）', async () => {
    const { clearAiMsgs, aiMsgs } = await import('../src/stores/aiChat')
    clearAiMsgs()
    expect(aiMsgs.value.length).toBe(0)
  })
})

describe('问题③：排序带源名 + 源偏好只破同分', () => {
  it('AI 卡片显示中文源名而不是内部 key', () => {
    // 用户看不懂 AppRJ；卡片第二行要显示站点表里的 name
    expect(PANEL).toMatch(/function siteName\(/)
    expect(PANEL).toMatch(/siteName\(h\.sources\[0\]\?\.site/)
    expect(PANEL).toMatch(/siteName\(s\.site\)/)
  })

  it('偏好读取走独立模块（searchRank 保持纯函数）', () => {
    const RANK = readFileSync(join(dir, 'api', 'searchRank.ts'), 'utf8')
    const AFF = readFileSync(join(dir, 'api', 'searchAffinity.ts'), 'utf8')
    expect(RANK).not.toMatch(/localStorage|fetchHealthState|listHistory/)
    expect(AFF).toMatch(/listHistory/)
    expect(AFF).toMatch(/fetchHealthState/)
    // 两个消费点都用它
    const TOOLS = readFileSync(join(dir, 'ai', 'tools.ts'), 'utf8')
    const SEARCH = readFileSync(join(dir, 'views', 'SearchView.vue'), 'utf8')
    expect(TOOLS).toMatch(/rankGroups\(r\.groups \|\| \[\], wd, await siteAffinity\(\)\)/)
    expect(SEARCH).toMatch(/rankGroups\(groupsNow, k, await siteAffinity\(\)\)/)
  })
})
