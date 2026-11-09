<script setup lang="ts">
/**
 * /offline 路由：缓存列表现在是片库页的「我的缓存」页签，
 * 这里只做重定向，兼容旧书签、深链与「缓存完成后跳转」。
 *
 * 为什么不留一份独立渲染：同一件事两个入口，两个入口的布局还不一样
 * （一个是独立页、一个是页签），用户会以为是不同功能。
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
onMounted(() => {
  void router.replace({ name: 'library', query: { tab: 'cache' } })
})
</script>

<template>
  <div class="mx-auto w-full max-w-[64rem] px-4 py-5">
    <p class="text-sm text-ink-3">正在打开「我的缓存」…</p>
  </div>
</template>
