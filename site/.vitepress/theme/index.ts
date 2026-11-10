import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import VersionBadge from './components/VersionBadge.vue'
import HomePage from './components/HomePage.vue'
import ScrollProgress from './components/ScrollProgress.vue'
import CursorGlow from './components/CursorGlow.vue'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // 顶部 2px 滚动进度条 + 全站鼠标柔光
      'layout-top': () => [h(ScrollProgress), h(CursorGlow)],
    }),
  enhanceApp({ app }) {
    app.component('VersionBadge', VersionBadge)
    app.component('HomePage', HomePage)
  },
} satisfies Theme
