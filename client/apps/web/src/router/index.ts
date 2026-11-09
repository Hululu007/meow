import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 用 hash 路由：Tauri 打包后加载的是本地 file://，
 * history 模式在 file:// 下会 404，hash 模式最稳。
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
    {
      path: '/category/:site',
      name: 'category',
      component: () => import('@/views/CategoryView.vue'),
    },
    {
      path: '/detail/:site/:id',
      name: 'detail',
      component: () => import('@/views/DetailView.vue'),
    },
    {
      path: '/play/:site',
      name: 'play',
      component: () => import('@/views/PlayView.vue'),
    },
    { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
    { path: '/history', name: 'history', component: () => import('@/views/HistoryView.vue') },
    { path: '/live', name: 'live', component: () => import('@/views/LiveView.vue') },
    // 本地/NAS 片库：与「直播」同级，不混进源列表——首页只渲染当前一个源，
    // 做成源等于把片库藏进顶栏下拉里
    { path: '/library', name: 'library', component: () => import('@/views/LibraryView.vue') },
    // 添加片库单独成页：TV 只有 BACK 键，内联表单打开后没有退路
    { path: '/library/add', name: 'libraryAdd', component: () => import('@/views/LibraryAddView.vue') },
    // 离线缓存：已下到本机的剧集。断网时这是唯一能直接点开看的地方，
    // 所以必须是独立路由——设置页那份列表只能看和删，进不去播放
    { path: '/offline', name: 'offline', component: () => import('@/views/OfflineView.vue') },
    {
      path: '/favorites',
      name: 'favorites',
      component: () => import('@/views/FavoritesView.vue'),
    },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
    // AI 助手独立页：浮层在 TV 上只有 ~400px 对话区，方向键滚动太慢。
    // 同一份组件（AiPanel 的 inline 模式），独立路由便于顶栏直达与分享。
    { path: '/ai', name: 'ai', component: () => import('@/views/AiView.vue') },
    // 运行日志：排查"点了没反应"专用。不占顶栏主区域（它属于诊断工具），
    // 入口在设置页「数据与维护」；独立路由便于直接分享链接。
    { path: '/logs', name: 'logs', component: () => import('@/views/LogsView.vue') },
  ],
  /**
   * 滚动位置：后退恢复，前进回顶。
   *
   * <p><b>为什么不能一律回顶</b>（原来就是 `() => ({ top: 0 })`）：
   * TV 上从首页点海报进详情、再按返回，首页会跳回顶部 —— 用户刚看到的那一屏
   * 没了，还得重新按十几次方向键找回原来的位置。收藏/历史/片库同理。
   *
   * <p><b>为什么不用 Vue Router 自带的 savedPosition</b>：它只在浏览器
   * history.back/forward 时给出坐标，而 TV 壳的返回键走的是
   * `onBackPressed` → 页面 `router.back()`，多数情况下能拿到；
   * 但**TV 的内容区往往不是 window 在滚**（App.vue 的 main 是 flex 容器，
   * 真正滚动的是页面内部的 div）。window 的 scrollY 恒为 0，
   * savedPosition 永远是 {left:0,top:0}，等于没恢复。
   *
   * <p>所以两层一起做：
   *   1) 这里返回 savedPosition（覆盖"window 真的在滚"的 Web 形态）
   *   2) 页面自己记住内部滚动容器的位置（见 useReturnRestore）
   *
   * <p>另外要区分"后退"和"前进/新导航"：新导航必须回顶，
   * 否则从详情页点顶栏「首页」会停在半路。
   */
  scrollBehavior: (to, from, savedPosition) => {
    // 后退/前进：恢复原位置
    if (savedPosition) return savedPosition
    // 同路径不同 query（搜索页改关键词）：也回顶，否则结果从半截开始
    if (to.path === from.path) return { top: 0 }
    // 新导航：回顶
    return { top: 0 }
  },
})

export default router
