<script setup lang="ts">
import { withBase } from 'vitepress'

const links = [
  { to: withBase('/guide/quick-start.html'), label: '快速开始', desc: '五分钟起一个后端' },
  { to: withBase('/guide/source-pack.html'), label: '导入源包', desc: '装完是空壳，先看这页' },
  { to: withBase('/reference/downloads.html'), label: '下载与版本', desc: '各端安装包与校验' },
  { to: withBase('/dev/'), label: '开发文档', desc: '架构、契约与部署' },
]
</script>

<template>
  <div class="mw-404">
    <div class="mw-404-grid" aria-hidden="true"></div>
    <div class="mw-404-glow" aria-hidden="true"></div>

    <div class="mw-404-inner">
      <p class="mw-404-code" aria-hidden="true">404</p>
      <h1>页面不存在</h1>
      <p class="mw-404-desc">
        链接可能已经失效，或者这一页被合并到了别处。下面几个入口大概率能找到你要的。
      </p>

      <div class="mw-404-links">
        <a v-for="l in links" :key="l.to" :href="l.to">
          <b>{{ l.label }}</b>
          <span>{{ l.desc }}</span>
        </a>
      </div>

      <a class="mw-404-home" :href="withBase('/')">回到首页 →</a>
    </div>
  </div>
</template>

<style scoped>
.mw-404 {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 66vh;
  padding: 72px 24px;
  overflow: hidden;
}

.mw-404-grid,
.mw-404-glow {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.mw-404-grid {
  background-image:
    linear-gradient(var(--mw-grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--mw-grid-line) 1px, transparent 1px);
  background-size: 52px 52px;
  mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 20%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 40%, #000 20%, transparent 78%);
}

.mw-404-glow {
  background: radial-gradient(50% 40% at 50% 25%, var(--mw-glow-a), transparent 70%);
}

.mw-404-inner {
  position: relative;
  max-width: 720px;
  text-align: center;
}

.mw-404-code {
  margin: 0;
  font-size: clamp(72px, 12vw, 132px);
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.04em;
  background: linear-gradient(180deg, var(--mw-text) 20%, var(--mw-cyan) 120%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  opacity: 0.9;
}

.mw-404 h1 {
  margin: 12px 0 0;
  color: var(--mw-text);
  font-size: clamp(22px, 3vw, 30px);
  font-weight: 750;
  letter-spacing: -0.02em;
}

.mw-404-desc {
  max-width: 460px;
  margin: 14px auto 0;
  color: var(--mw-text-2);
  font-size: 14.5px;
  line-height: 1.8;
}

.mw-404-links {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 34px 0 0;
  text-align: left;
}

.mw-404-links a {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 14px 16px;
  border: 1px solid var(--mw-line);
  border-radius: 12px;
  background: var(--mw-panel-flat);
  text-decoration: none;
  transition:
    border-color 0.25s ease,
    transform 0.2s ease;
}

.mw-404-links a:hover {
  border-color: var(--mw-line-strong);
  transform: translateY(-2px);
}

.mw-404-links b {
  color: var(--mw-text);
  font-size: 14px;
  font-weight: 650;
}

.mw-404-links span {
  color: var(--mw-text-3);
  font-size: 12px;
}

.mw-404-home {
  display: inline-block;
  margin-top: 28px;
  color: var(--mw-cyan);
  font-size: 13.5px;
  font-weight: 650;
  text-decoration: none;
}

.mw-404-home:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .mw-404-links {
    grid-template-columns: 1fr;
  }
}
</style>
