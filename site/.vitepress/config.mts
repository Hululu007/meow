import { defineConfig } from 'vitepress'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * GitHub Pages 的子路径。head 里的 favicon 是原样输出的绝对地址，
 * 不经过 VitePress 的 base 前缀处理——写成 `/logo.svg` 会在 /meow/ 下 404。
 */
const SITE_BASE = '/meow/'

/** 站点展示的版本号与应用版本保持一致，避免文档和安装包脱节。 */
const appVersion = JSON.parse(
  readFileSync(join(here, '..', '..', 'client', 'package.json'), 'utf8'),
).version

/**
 * 搜索分词。
 *
 * VitePress 默认按空白切词，中文整句会变成一个 token——搜「备份」可能命中，
 * 搜「怎么备份」「备份在哪」就搜不到。这里用浏览器内置的 Intl.Segmenter
 * 按词切中文，英文/代码标识符（spiderJvm、fnpack.json）整体保留。
 */
function tokenizeForSearch(text: string): string[] {
  const tokens: string[] = []
  const latin = text.match(/[A-Za-z0-9_.#/@-]+/g) || []
  tokens.push(...latin)

  const cjk = text.replace(/[A-Za-z0-9_.#/@-]+/g, ' ')
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale: string, opts: object) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter
  if (Segmenter) {
    const seg = new Segmenter('zh-CN', { granularity: 'word' })
    for (const part of seg.segment(cjk)) {
      if (part.isWordLike && part.segment.trim()) tokens.push(part.segment)
    }
  } else {
    for (const ch of cjk) {
      if (/[一-鿿]/.test(ch)) tokens.push(ch)
    }
  }
  return tokens
}

const devSidebar = [
  {
    text: '总览',
    items: [
      { text: '三端架构', link: '/dev/architecture' },
      { text: '接口契约', link: '/dev/api-contract' },
    ],
  },
  {
    text: '客户端',
    items: [
      { text: '前端手册', link: '/dev/frontend' },
      { text: '端与尺寸适配', link: '/dev/device-adaptive' },
      { text: '播放与转码', link: '/dev/playback' },
      { text: '倒计时电源动作', link: '/dev/power-actions' },
      { text: '投屏', link: '/dev/casting' },
      { text: '弹幕', link: '/dev/danmaku' },
      { text: '片库与离线缓存', link: '/dev/library-cache' },
      { text: '本地目录片库与目录树', link: '/dev/library-local-browse' },
      { text: '直播', link: '/dev/live' },
      { text: 'AI 助手', link: '/dev/ai-assistant' },
    ],
  },
  {
    text: '源与扩展',
    items: [
      { text: '配置系统', link: '/dev/config-system' },
      { text: '插件系统', link: '/dev/plugin-system' },
      { text: '插件生态统一规范', link: '/dev/plugin-ecosystem' },
    ],
  },
  {
    text: '端',
    items: [
      { text: 'TV 接入与 Fongmi', link: '/dev/tv-integration' },
      { text: 'iOS 端接入（IPA）', link: '/dev/ios-integration' },
      { text: 'iOS 运行时（js / py 源）', link: '/dev/ios-runtime' },
    ],
  },
  {
    text: '运维',
    items: [
      { text: '数据与状态', link: '/dev/data-state' },
      { text: 'Docker 部署', link: '/dev/docker' },
      { text: '公网部署与访问控制', link: '/dev/public-deployment' },
      { text: 'fnOS 网关身份接入', link: '/dev/fnos-gateway-auth' },
      { text: '构建与发版', link: '/dev/build-release' },
      { text: '测试与验收', link: '/dev/testing' },
    ],
  },
]

const guideSidebar = [
  {
    text: '开始使用',
    items: [
      { text: '这是什么', link: '/guide/what-is-meow' },
      { text: '快速开始', link: '/guide/quick-start' },
    ],
  },
  {
    text: '安装',
    items: [
      { text: 'Web / Docker', link: '/guide/web-docker' },
      { text: 'PC 桌面端', link: '/guide/pc' },
      { text: 'TV / 投影仪 / 手机', link: '/guide/tv' },
      { text: 'iPhone / iPad', link: '/guide/ios' },
      { text: '飞牛 fnOS', link: '/guide/fnos' },
    ],
  },
  {
    text: '源导入',
    items: [
      { text: '导入源包', link: '/guide/source-pack' },
    ],
  },
  {
    text: '日常使用',
    items: [
      { text: '播放与弹幕', link: '/guide/playback' },
      { text: '点播与直播', link: '/guide/vod-live' },
      { text: '片库与缓存', link: '/guide/library' },
      { text: 'AI 助手', link: '/guide/ai' },
    ],
  },
  {
    text: '维护',
    items: [
      { text: '升级与迁移', link: '/guide/upgrade' },
      { text: '备份与恢复', link: '/guide/backup' },
      { text: '脚本与 AI 操作（MCP）', link: '/guide/automation' },
      { text: '常见问题', link: '/guide/faq' },
    ],
  },
]

const ecosystemSidebar = [
  {
    text: '插件',
    items: [
      { text: '插件与安装', link: '/ecosystem/plugins' },
      { text: 'TV 运行时模块', link: '/ecosystem/runtime-module' },
    ],
  },
  {
    text: '插件开发',
    items: [
      { text: '插件 manifest 规范', link: '/ecosystem/plugin-manifest' },
      { text: '自建插件源', link: '/ecosystem/plugin-source' },
    ],
  },
  {
    text: '源包',
    items: [{ text: '源包与配置格式', link: '/ecosystem/source-format' }],
  },
]

const referenceSidebar = [
  {
    text: '版本与排障',
    items: [
      { text: '下载与版本', link: '/reference/downloads' },
      { text: '更新日志', link: '/reference/changelog' },
      { text: '版本兼容矩阵', link: '/reference/compatibility' },
      { text: '诊断手册', link: '/reference/diagnostics' },
    ],
  },
  {
    text: '项目信息',
    items: [
      { text: '应用计划', link: '/reference/roadmap' },
      { text: '安全与隐私', link: '/reference/security' },
      { text: '已知限制', link: '/reference/limits' },
      { text: '术语表', link: '/reference/glossary' },
      { text: '反馈与贡献', link: '/reference/contributing' },
      { text: '许可与免责', link: '/reference/license' },
    ],
  },
]

export default defineConfig({
  lang: 'zh-CN',
  title: '猫窝 Meow',
  description:
    '跨端影视客户端：Web / PC / TV / iOS 一套内核。同一套前端与源包格式，源包由用户自行导入。',
  base: SITE_BASE,
  srcDir: './docs',
  lastUpdated: true,
  cleanUrls: false,
  // 影院感：首屏默认深色，用户仍可切回浅色
  appearance: 'dark',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${SITE_BASE}logo.svg` }],
    ['link', { rel: 'apple-touch-icon', href: `${SITE_BASE}logo-192.png` }],
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
    ['meta', { property: 'og:image', content: 'https://upchr.github.io/meow/og.png' }],
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://upchr.github.io/meow/og.png' }],
    // spa: true 让文档内链接切换也上报——VitePress 是客户端路由，缺了只统计首次进入
    [
      'script',
      {
        type: 'module',
        defer: '',
        src: 'https://static.cloudflareinsights.com/beacon.min.js',
        'data-cf-beacon': '{"token":"c765d0f5dd3242cba4d40c2dd487fd2e","spa":true}',
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
      // 导航直接落到各栏目第一页，不做中间导览页
      { text: '指南', link: '/guide/what-is-meow', activeMatch: '^/guide/' },
      { text: '插件与源包', link: '/ecosystem/plugins', activeMatch: '^/ecosystem/' },
      { text: '下载与版本', link: '/reference/downloads' },
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
        miniSearch: {
          options: {
            tokenize: tokenizeForSearch,
          },
        },
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
