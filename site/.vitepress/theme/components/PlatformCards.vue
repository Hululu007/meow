<script setup lang="ts">
import { withBase } from 'vitepress'

const platforms = [
  {
    key: 'web',
    kicker: 'WEB · DOCKER',
    title: '四容器，一条命令',
    desc: 'nginx 前端、JVM 后端、drpy 运行时与弹幕服务各自成容器，按需组合。',
    points: ['amd64 + arm64 双架构', 'apiserver 默认只绑本机', 'drpy 决定 .js 源可不可用'],
    code: 'docker compose up -d',
    href: withBase('/guide/web-docker.html'),
    action: '部署说明',
  },
  {
    key: 'pc',
    kicker: 'PC · WINDOWS',
    title: '壳与插件分离',
    desc: '安装包约 6 MB，后端与运行时按需从插件源拉取，校验后原子替换。',
    points: ['首次打开提示「后端未连接」是设计', '端口 9979 起自动协商', '插件失败自动回滚'],
    code: 'meow-setup-x.y.z.exe',
    href: withBase('/guide/pc.html'),
    action: '安装与插件',
  },
  {
    key: 'tv',
    kicker: 'TV · ANDROID',
    title: '遥控器优先',
    desc: '端内网关 + DexClassLoader，电视不依赖电脑也能直接跑 dex 形态的源。',
    points: ['41 条端内路由', '扫码推送后端与配置地址', '运行时模块按 ABI 匹配'],
    code: 'meow-TV-x.y.z.apk',
    href: withBase('/guide/tv.html'),
    action: '安装与扫码',
  },
]
</script>

<template>
  <div class="mw-platforms">
    <article v-for="p in platforms" :key="p.key" class="mw-platform" :class="`is-${p.key}`">
      <div class="mw-chrome" aria-hidden="true">
        <span class="mw-dots"><i></i><i></i><i></i></span>
        <em>{{ p.kicker }}</em>
      </div>

      <div class="mw-platform-body">
        <h3>{{ p.title }}</h3>
        <p>{{ p.desc }}</p>
        <ul>
          <li v-for="point in p.points" :key="point">{{ point }}</li>
        </ul>
        <code>{{ p.code }}</code>
        <a :href="p.href">{{ p.action }}<span aria-hidden="true">→</span></a>
      </div>
    </article>
  </div>
</template>

<style scoped>
.mw-platforms {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.mw-platform {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--mw-line);
  border-radius: 16px;
  background: var(--mw-panel-flat);
  overflow: hidden;
  transition:
    border-color 0.3s ease,
    transform 0.3s ease,
    box-shadow 0.3s ease;
}

.mw-platform:hover {
  border-color: var(--mw-line-strong);
  transform: translateY(-3px);
  box-shadow: 0 20px 50px -24px rgba(3, 218, 197, 0.35);
}

.mw-platform::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
  background: radial-gradient(
    260px circle at var(--mx, 50%) var(--my, 0%),
    var(--mw-spot),
    transparent 60%
  );
}

.mw-platform:hover::after {
  opacity: 1;
}

.mw-platform > * {
  position: relative;
  z-index: 1;
}

.mw-chrome {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--mw-line);
  background: var(--mw-chrome-bg);
}

.mw-dots {
  display: inline-flex;
  gap: 5px;
}

.mw-dots i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mw-line);
}

.mw-platform:hover .mw-dots i:nth-child(1) {
  background: #ff6b6b;
}

.mw-platform:hover .mw-dots i:nth-child(2) {
  background: #ffd166;
}

.mw-platform:hover .mw-dots i:nth-child(3) {
  background: var(--mw-cyan);
}

.mw-chrome em {
  color: var(--mw-text-3);
  font-size: 10.5px;
  font-style: normal;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.mw-platform-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 22px;
}

.mw-platform h3 {
  margin: 0 0 8px;
  color: var(--mw-text);
  font-size: 17px;
  font-weight: 700;
}

.mw-platform p {
  margin: 0 0 16px;
  color: var(--mw-text-2);
  font-size: 13.5px;
  line-height: 1.7;
}

.mw-platform ul {
  margin: 0 0 18px;
  padding: 0;
  list-style: none;
}

.mw-platform li {
  position: relative;
  margin: 0 0 7px;
  padding-left: 16px;
  color: var(--mw-text-2);
  font-size: 12.8px;
  line-height: 1.6;
}

.mw-platform li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--mw-cyan);
  opacity: 0.7;
}

.mw-platform code {
  display: block;
  margin-top: auto;
  padding: 10px 12px;
  border: 1px solid var(--mw-line);
  border-radius: 9px;
  background: var(--mw-code-bg);
  color: var(--mw-text);
  font-size: 12px;
  white-space: nowrap;
  overflow-x: auto;
}

.mw-platform a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  color: var(--mw-cyan);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}

.mw-platform a span {
  transition: transform 0.2s ease;
}

.mw-platform a:hover span {
  transform: translateX(3px);
}

@media (max-width: 1024px) {
  .mw-platforms {
    grid-template-columns: 1fr;
  }
}
</style>
