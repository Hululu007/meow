<script setup lang="ts">
const features = [
  {
    tag: '架构',
    title: '宿主与源分离',
    desc: '内容源以 jar 由第三方分发。项目只做一次宿主，Web、PC、TV 三端复用，仓库不附带任何站点配置。',
    icon: 'M3 6h7v12H3z M14 12h5 M16 9l3 3-3 3',
  },
  {
    tag: '前端',
    title: '三端同一份前端',
    desc: '一套 Vue 3 + TypeScript 模板，浏览器、Tauri 桌面壳、Android WebView 壳各自套壳，交互与状态保持一致。',
    icon: 'M12 3l8 4-8 4-8-4 8-4z M4 12l8 4 8-4 M4 17l8 4 8-4',
  },
  {
    tag: '播放',
    title: '播放链路完整',
    desc: 'HLS / DASH、解析式播放、自动换线、续播、片头尾跳过、选集连播、字幕、画中画与 DLNA 投屏。',
    icon: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M10 8.2l6 3.8-6 3.8V8.2z',
  },
  {
    tag: '弹幕',
    title: '弹幕多源降级',
    desc: '内置直连、聚合服务、自建 danmu_api 按顺序并发抢占，先到先用；屏蔽词、密度与透明度可调。',
    icon: 'M4 6h16 M4 12h11 M4 18h14',
  },
  {
    tag: '扩展',
    title: '直播与片库',
    desc: '站点聚合与 IPTV m3u；WebDAV / SMB / 本地片库，Range 直连与按需转 HLS，单集整季离线缓存。',
    icon: 'M4 18a14 14 0 0 1 0-12 M8 16a9 9 0 0 1 0-8 M12 14a4 4 0 0 1 0-4',
  },
  {
    tag: '插件',
    title: '插件按需下载',
    desc: '安装包只有壳。后端、drpy、弹幕、Node 运行时都是插件，校验 SHA256 后原子替换，失败自动回滚。',
    icon: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  },
]
</script>

<template>
  <div class="mw-features">
    <article v-for="f in features" :key="f.title" class="mw-feature">
      <div class="mw-feature-icon">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path :d="f.icon" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <span class="mw-feature-tag">{{ f.tag }}</span>
      <h3>{{ f.title }}</h3>
      <p>{{ f.desc }}</p>
    </article>
  </div>
</template>

<style scoped>
.mw-features {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.mw-feature {
  position: relative;
  padding: 26px 24px 28px;
  border: 1px solid var(--mw-line);
  border-radius: 16px;
  background: linear-gradient(180deg, var(--mw-panel) 0%, var(--mw-panel-flat) 100%);
  overflow: hidden;
  transition:
    border-color 0.3s ease,
    transform 0.3s ease,
    box-shadow 0.3s ease;
}

/* 顶部一道高光，hover 时点亮 */
.mw-feature::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12%;
  width: 76%;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--mw-cyan), transparent);
  opacity: 0.25;
  transition: opacity 0.3s ease;
}

.mw-feature:hover {
  border-color: var(--mw-line-strong);
  transform: translateY(-3px);
  box-shadow: 0 18px 44px -20px rgba(3, 218, 197, 0.35);
}

.mw-feature:hover::before {
  opacity: 0.9;
}

/* 鼠标跟随光斑：坐标由 HomePage 的 pointermove 写入 --mx/--my */
.mw-feature::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
  background: radial-gradient(
    240px circle at var(--mx, 50%) var(--my, 0%),
    var(--mw-spot),
    transparent 62%
  );
}

.mw-feature:hover::after {
  opacity: 1;
}

.mw-feature > * {
  position: relative;
  z-index: 1;
}

.mw-feature-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin-bottom: 18px;
  border: 1px solid var(--mw-line);
  border-radius: 11px;
  background: var(--mw-icon-bg);
  color: var(--mw-cyan);
}

.mw-feature-icon svg {
  width: 24px;
  height: 24px;
}

.mw-feature-tag {
  display: block;
  margin-bottom: 7px;
  color: var(--mw-cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.mw-feature h3 {
  margin: 0 0 9px;
  color: var(--mw-text);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.mw-feature p {
  margin: 0;
  color: var(--mw-text-2);
  font-size: 13.8px;
  line-height: 1.75;
}

@media (max-width: 1024px) {
  .mw-features {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .mw-features {
    grid-template-columns: 1fr;
  }
}
</style>
