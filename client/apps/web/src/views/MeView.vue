<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import HistoryView from './HistoryView.vue'
import FavoritesView from './FavoritesView.vue'
import MeTabs from '@/components/common/MeTabs.vue'

/**
 * 「我的」：历史 + 收藏 + 片库（片库是入口页签）为一个一级入口
 * （2026-11-12 用户口径）。
 *
 * <p><b>为什么不是两张跳转卡片</b>：手机底栏加「我的」的目的就是少一次点击。
 * 做成卡片再点一次等于「…菜单 → 历史」换个地方，白加一格。
 * 所以历史/收藏用分段控件直接内嵌两个视图（`embedded`），点一下就到。
 *
 * <p><b>片库为什么是路由不是内嵌</b>：LibraryView 的目录层级写在 URL query
 * 里并会整体覆盖 `router.replace({query})`，内嵌会把「我的」的 `?tab=` 抹掉
 * （翻两层目录页签就跳回历史）。所以片库保持独立路由，页签只做入口；
 * 片库页顶部也渲染同一条页签栏（MeTabs），三个分区在哪都可见。
 *
 * <p><b>为什么只挂一个</b>：两个视图各自有回源补封面、收藏更新检查、
 * TV 菜单注册、滚动恢复等副作用，同时挂着会互相抢（tvMenu 后注册的覆盖前面的，
 * useReturnRestore 两套 key 同时保存）。`v-if` 切换 = 只留当前分区在跑。
 *
 * <p><b>为什么分区写进 query</b>：从「我的」点进详情再返回，组件会重新挂载；
 * 不写 query 就会弹回「历史」，用户刚才在收藏里翻的位置就丢了。
 * 用 `replace` 而不是 `push`：切分区不该在返回栈里多一层。
 */
type Tab = 'history' | 'favorites'

const route = useRoute()

const tabFromQuery = (v: unknown): Tab => (v === 'favorites' ? 'favorites' : 'history')
const tab = ref<Tab>(tabFromQuery(route.query.tab))

watch(
  () => route.query.tab,
  (v) => {
    const next = tabFromQuery(v)
    if (next !== tab.value) tab.value = next
  },
)

// 进页面先同步一次（深链 / 从详情返回都走这里）
onMounted(() => {
  tab.value = tabFromQuery(route.query.tab)
})
</script>

<template>
  <div class="mx-auto max-w-[1600px] px-6 py-6 max-sm:px-3 max-sm:py-4">
    <!-- 分段控件：44px 高，拇指区；片库页签的导航语义见 MeTabs 组件注释 -->
    <MeTabs :active="tab" />

    <HistoryView v-if="tab === 'history'" embedded />
    <FavoritesView v-else embedded />
  </div>
</template>
