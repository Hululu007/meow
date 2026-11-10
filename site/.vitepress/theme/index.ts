import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'
import VersionBadge from './components/VersionBadge.vue'
import DownloadCards from './components/DownloadCards.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VersionBadge', VersionBadge)
    app.component('DownloadCards', DownloadCards)
  },
} satisfies Theme
