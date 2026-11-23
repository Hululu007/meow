import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import VersionBadge from './components/VersionBadge.vue'
import HomePage from './components/HomePage.vue'
import ScrollProgress from './components/ScrollProgress.vue'
import CursorGlow from './components/CursorGlow.vue'
import MusicPlayer from './components/MusicPlayer.vue'
import WelcomeGate from './components/WelcomeGate.vue'
import NotFoundPage from './components/NotFoundPage.vue'
import ImageZoom from './components/ImageZoom.vue'
import BackToTop from './components/BackToTop.vue'
import CapabilityGrid from './components/CapabilityGrid.vue'

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // 顶部 2px 滚动进度条 + 全站鼠标柔光
      'layout-top': () => [h(WelcomeGate), h(ScrollProgress), h(CursorGlow)],
      // 截图放大与回到顶部不占布局，挂在底部即可
      'layout-bottom': () => [h(MusicPlayer), h(ImageZoom), h(BackToTop)],
      'not-found': () => h(NotFoundPage),
    }),
  enhanceApp({ app }) {
    app.component('VersionBadge', VersionBadge)
    app.component('HomePage', HomePage)
    app.component('CapabilityGrid', CapabilityGrid)
  },
} satisfies Theme
