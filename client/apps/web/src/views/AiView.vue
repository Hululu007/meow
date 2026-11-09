<script setup lang="ts">
/**
 * AI 助手独立页。
 *
 * 为什么需要独立页而不是只有右下角浮层：
 * TV 上浮层是 34rem × 74vh，扣掉标题栏和输入框，对话区实际约 400px 高。
 * 一轮稍长的回答就要来回滚，而遥控器滚动很慢（一个元素一个元素地走）。
 * 独立页占满整屏，也给卡片上的按钮留出了可以被方向键逐个访问的空间。
 *
 * 内容本身复用 AiPanel 的 inline 模式——消息列表 / 输入 / 编排逻辑只有一份。
 */
import AiPanel from '@/components/ai/AiPanel.vue'
</script>

<style scoped>
/*
 * 高度 = 视口 − 顶栏 − 底部标签栏。
 *
 * ★ 写两遍：`100dvh` 跟着地址栏/软键盘变化（Chrome 108+），老内核丢掉
 *   第二行退回 `100vh`（投影仪 Chrome 66 靠这条兜底）。
 *   只用 vh 时，移动浏览器把地址栏收起的空间也算进视口高度，页面会多出
 *   一截可滚动的空白（用户反馈"弹框太高，页面还能滚"就是这个）。
 * ★ 不能用父级 flex 链传递高度：App.vue 的根容器是 min-h-full，
 *   老内核上弹性高度传递不可靠（实测 AI 页塌成 167px）。
 */
.ai-page {
  height: calc(100vh - var(--header-h) - var(--tabbar-h, 0px));
  height: calc(100dvh - var(--header-h) - var(--tabbar-h, 0px));
}
</style>

<template>
  <!--
    高度 = 视口 − 顶栏 − 底部标签栏，两个高度都走变量
    （`--header-h`：tv 4.5rem / web 4rem / 手机 3.5rem+安全区；
     `--tabbar-h`：桌面与电视 0，手机 3.5rem+安全区）。

    ★ 不能用 `100dvh`：Chrome 108+ 才有，投影仪（Chrome 66）会把整条声明
      丢掉，容器退回内容高度 —— 实测独立页面板只有 167px 高，比浮层还小，
      正好和"做大一点"的目的相反。
    ★ 也不能靠父级 flex 链（min-h-full → flex-1）传递：App.vue 的根容器是
      `min-h-full`，在老内核上百分比/弹性高度传递不可靠，实测同样塌陷。
      显式 `calc(100vh - var(--header-h))` 是唯一在两端都稳的写法。
  -->
  <div class="ai-page mx-auto flex w-full max-w-[52rem] flex-col px-3 py-3 sm:px-4 sm:py-4">
    <AiPanel inline />
  </div>
</template>
