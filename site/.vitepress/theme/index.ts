import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import VersionBadge from './components/VersionBadge.vue'
import HomePage from './components/HomePage.vue'
import ScrollProgress from './components/ScrollProgress.vue'

export default {
  extends: DefaultTheme,
  // 顶部 2px 滚动进度条，挂在 VitePress 的 layout-top 插槽上
  Layout: () => h(DefaultTheme.Layout, null, { 'layout-top': () => h(ScrollProgress) }),
  enhanceApp({ app }) {
    app.component('VersionBadge', VersionBadge)
    app.component('HomePage', HomePage)
  },
} satisfies Theme
