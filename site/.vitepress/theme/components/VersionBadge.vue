<script setup lang="ts">
// 应用版本在构建时由 config.mts 的 vite.define 注入
const version = __MEOW_VERSION__
</script>

<template>
  <span class="meow-version" :title="`源码版本 ${version}`">v{{ version }}</span>
</template>

<style scoped>
.meow-version {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  vertical-align: middle;
  letter-spacing: 0.02em;
}
</style>
