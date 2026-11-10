import { defineConfig } from 'vitepress'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** 站点展示的版本号与应用版本保持一致，避免文档和安装包脱节。 */
const appVersion = JSON.parse(
  readFileSync(join(here, '..', '..', 'client', 'package.json'), 'utf8'),
).version

const devSidebar = [
  { text: '总览', link: '/dev/' },
  { text: '三端架构', link: '/dev/architecture' },
  { text: '接口契约', link: '/dev/api-contract' },
  { text: '前端手册', link: '/dev/frontend' },
  { text: 'TV 接入与 Fongmi', link: '/dev/tv-integration' },
  { text: '插件系统', link: '/dev/plugin-system' },
  { text: 'Docker 部署', link: '/dev/docker' },
  { text: '片库与离线缓存', link: '/dev/library-cache' },
  { text: 'TV 签名', link: '/dev/tv-signing' },
  { text: 'AI 助手', link: '/dev/ai-assistant' },
]

const guideSidebar = [
  {
    text: '开始使用',
    items: [
      { text: '这是什么', link: '/guide/what-is-meow' },
      { text: '快速开始', link: '/guide/quick-start' },
      { text: '导入源包', link: '/guide/source-pack' },
    ],
  },
  {
    text: '各端安装',
    items: [
      { text: 'Web / Docker', link: '/guide/web-docker' },
      { text: 'PC 桌面端', link: '/guide/pc' },
      { text: 'TV / 投影仪', link: '/guide/tv' },
      { text: '飞牛 fnOS', link: '/guide/fnos' },
    ],
  },
  {
    text: '日常使用',
    items: [
      { text: '播放、弹幕与直播', link: '/guide/playback' },
      { text: '常见问题', link: '/guide/faq' },
    ],
  },
]

const ecosystemSidebar = [
  {
    text: '插件',
    items: [
      { text: '插件生态与安装', link: '/ecosystem/plugins' },
      { text: '插件 manifest 规范', link: '/ecosystem/plugin-manifest' },
      { text: '自建插件源', link: '/ecosystem/plugin-source' },
    ],
  },
  {
    text: '源包',
    items: [
      { text: '源包与配置格式', link: '/ecosystem/source-format' },
      { text: 'TV 运行时模块', link: '/ecosystem/runtime-module' },
    ],
  },
]

const referenceSidebar = [
  {
    text: '参考',
    items: [
      { text: '下载与版本', link: '/reference/downloads' },
      { text: '更新日志', link: '/reference/changelog' },
      { text: '已知限制', link: '/reference/limits' },
      { text: '许可与免责', link: '/reference/license' },
    ],
  },
]

export default defineConfig({
  lang: 'zh-CN',
  title: '猫窝 Meow',
  description:
    '跨端影视客户端：Web / PC / TV 一套内核，三个出口。同一套 JVM 宿主与 spider jar，源包由用户自行导入。',
  base: '/meow/',
  srcDir: './docs',
  lastUpdated: true,
  cleanUrls: false,
  // 影院感：首屏默认深色，用户仍可切回浅色
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/logo-192.png' }],
    ['meta', { name: 'theme-color', content: '#03dac5' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: '猫窝 Meow — 跨端影视客户端' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Web / PC / TV 共用一套播放内核。不提供内容源，源包由用户导入。',
      },
    ],
  ],

  sitemap: {
    hostname: 'https://upchr.github.io/meow/',
  },

  markdown: {
    image: { lazyLoading: true },
    // 文档里大量源站域名与占位地址，不当作可点击外链校验
    externalLinks: { target: '_blank', rel: 'noreferrer' },
    // 构建日志会对 docs/ 里的 ```gradle 报「语言未加载」，借 java 高亮
    languageAlias: { gradle: 'java' },
  },

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: '猫窝 Meow',

    nav: [
      { text: '指南', link: '/guide/what-is-meow', activeMatch: '^/guide/' },
      { text: '插件与源包', link: '/ecosystem/plugins', activeMatch: '^/ecosystem/' },
      { text: '下载', link: '/reference/downloads' },
      { text: '更新日志', link: '/reference/changelog' },
      { text: '开发文档', link: '/dev/', activeMatch: '^/dev/' },
    ],

    sidebar: {
      '/guide/': guideSidebar,
      '/ecosystem/': ecosystemSidebar,
      '/reference/': referenceSidebar,
      '/dev/': devSidebar,
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '没有找到结果',
            resetButtonTitle: '清空',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    outline: { level: [2, 3], label: '本页目录' },

    docFooter: { prev: '上一篇', next: '下一篇' },
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '返回顶部',
    lastUpdatedText: '最后更新',

    editLink: {
      pattern: 'https://github.com/upchr/meow/edit/main/site/docs/:path',
      text: '在 GitHub 上编辑此页',
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/upchr/meow' }],

    footer: {
      message:
        '本项目不提供任何内容源。影视内容、站点配置与弹幕数据均来自第三方，由用户自行导入并承担合规责任。',
      copyright: '猫窝 Meow 非商业许可 1.0 · source-available',
    },
  },

  vite: {
    define: {
      __MEOW_VERSION__: JSON.stringify(appVersion),
    },
  },
})
