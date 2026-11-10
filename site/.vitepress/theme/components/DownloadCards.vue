<script setup lang="ts">
import { withBase } from 'vitepress'

const releases = 'https://github.com/upchr/meow/releases'

const cards = [
  {
    tag: 'Web',
    title: 'Docker 四容器',
    desc: 'nginx 前端 + JVM 后端 + drpy + 弹幕服务，一条 compose 起全套。',
    code: 'docker compose up -d',
    link: withBase('/guide/web-docker.html'),
    linkText: '部署说明',
    extra: releases,
    extraText: '镜像地址',
  },
  {
    tag: 'PC',
    title: 'Windows 桌面端',
    desc: 'Tauri 壳 + 按需下载的插件。安装包不含后端，首次打开会提示连接。',
    code: 'meow-setup-x.y.z.exe',
    link: withBase('/guide/pc.html'),
    linkText: '安装与插件',
    extra: releases,
    extraText: '下载安装包',
  },
  {
    tag: 'TV',
    title: 'Android TV / 投影仪',
    desc: '遥控器导航、端内网关、DexClassLoader 直接跑 dex 形态的源。',
    code: 'meow-TV-x.y.z.apk',
    link: withBase('/guide/tv.html'),
    linkText: '安装与扫码',
    extra: releases,
    extraText: '下载 APK',
  },
  {
    tag: 'NAS',
    title: '飞牛 fnOS',
    desc: '原生 fpk 套件，x86 / arm 双架构，应用中心内直接升级。',
    code: 'meow_x.y.z_x86.fpk',
    link: withBase('/guide/fnos.html'),
    linkText: '套件说明',
    extra: releases,
    extraText: '下载 fpk',
  },
]
</script>

<template>
  <div class="meow-download-grid">
    <article v-for="c in cards" :key="c.tag" class="meow-download-card">
      <span class="meow-download-tag">{{ c.tag }}</span>
      <h3>{{ c.title }}</h3>
      <p>{{ c.desc }}</p>
      <code class="meow-download-code">{{ c.code }}</code>
      <div class="meow-download-links">
        <a :href="c.link">{{ c.linkText }} →</a>
        <a :href="c.extra" target="_blank" rel="noreferrer">{{ c.extraText }} ↗</a>
      </div>
    </article>
  </div>
</template>

<style scoped>
.meow-download-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin: 32px 0;
}

.meow-download-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  transition:
    border-color 0.25s,
    transform 0.25s;
}

.meow-download-card:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.meow-download-tag {
  align-self: flex-start;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.meow-download-card h3 {
  margin: 4px 0 0;
  font-size: 17px;
  line-height: 1.4;
}

.meow-download-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 14px;
  line-height: 1.6;
}

.meow-download-code {
  display: block;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  color: var(--vp-c-text-1);
  font-size: 12px;
  overflow-x: auto;
  white-space: nowrap;
}

.meow-download-links {
  display: flex;
  gap: 14px;
  margin-top: auto;
  padding-top: 4px;
  font-size: 13px;
  font-weight: 600;
}

.meow-download-links a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.meow-download-links a:hover {
  text-decoration: underline;
}
</style>
