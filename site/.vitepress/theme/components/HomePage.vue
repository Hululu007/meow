<script setup lang="ts">
import { withBase } from 'vitepress'
import FeatureGrid from './FeatureGrid.vue'
import HeroSection from './HeroSection.vue'
import PlatformCards from './PlatformCards.vue'
import RevealOnScroll from './RevealOnScroll.vue'

const stats = [
  { value: '0', label: '内置内容源' },
  { value: '3', label: '端形态' },
  { value: '4', label: 'Docker 容器' },
  { value: '41', label: 'TV 端内路由' },
]

/** 把指针位置写进卡片的 CSS 变量，光斑才能跟随鼠标 */
function onSpotlight(e: PointerEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.('.mw-feature, .mw-platform')
  if (!(el instanceof HTMLElement)) return
  const rect = el.getBoundingClientRect()
  el.style.setProperty('--mx', `${e.clientX - rect.left}px`)
  el.style.setProperty('--my', `${e.clientY - rect.top}px`)
}

const sourcePack = withBase('/guide/source-pack.html')
const downloads = withBase('/reference/downloads.html')
const limits = withBase('/reference/limits.html')
const license = withBase('/reference/license.html')
</script>

<template>
  <div class="mw-home" @pointermove="onSpotlight">
    <HeroSection />

    <div class="mw-stats">
      <div v-for="s in stats" :key="s.label" class="mw-stat">
        <b>{{ s.value }}</b>
        <span>{{ s.label }}</span>
      </div>
    </div>

    <section class="mw-section">
      <header class="mw-section-head">
        <div class="mw-sec-meta"><span class="mw-sec-index">01</span><span class="mw-eyebrow">CAPABILITIES</span></div>
        <h2>一个后端，把三端该做的事都做了</h2>
        <p>
          搜索、详情、播放地址解析、弹幕聚合、代理与转码都收敛在同一套宿主里。
          客户端只负责呈现与交互。
        </p>
      </header>
      <RevealOnScroll>
        <FeatureGrid />
      </RevealOnScroll>
    </section>

    <section class="mw-section mw-section-alt">
      <header class="mw-section-head">
        <div class="mw-sec-meta"><span class="mw-sec-index">02</span><span class="mw-eyebrow">PLATFORMS</span></div>
        <h2>三种形态，按你的设备选</h2>
        <p>同一份配置语义，不同的加载器与外壳。也可以只跑后端，把电视和手机当播放器。</p>
      </header>
      <RevealOnScroll :delay="80">
        <PlatformCards />
      </RevealOnScroll>
    </section>

    <section class="mw-section">
      <RevealOnScroll>
        <div class="mw-boundary">
          <div class="mw-boundary-copy">
            <div class="mw-sec-meta"><span class="mw-sec-index">03</span><span class="mw-eyebrow">BOUNDARY</span></div>
            <h2>装完是空壳</h2>
            <p>
              仓库与公开 Release 都不含源包。没有 spider jar 与站点配置，
              搜索和播放都是空的——这不是安装失败。
            </p>
            <a class="mw-inline-link" :href="sourcePack">
              源包怎么导入
              <span aria-hidden="true">→</span>
            </a>
          </div>

          <ul class="mw-boundary-list">
            <li>
              <span class="mw-mark is-no">✕</span>
              <div>
                <b>不提供任何内容源</b>
                <em>没有 spider jar、站点配置或第三方令牌</em>
              </div>
            </li>
            <li>
              <span class="mw-mark is-no">✕</span>
              <div>
                <b>不提供影视内容</b>
                <em>影片、直播与弹幕都来自你导入的源</em>
              </div>
            </li>
            <li>
              <span class="mw-mark is-no">✕</span>
              <div>
                <b>不允许商业使用</b>
                <em>自定义非商业许可，属于 source-available</em>
              </div>
            </li>
          </ul>
        </div>
      </RevealOnScroll>
    </section>

    <section class="mw-section mw-cta">
      <div class="mw-cta-glow" aria-hidden="true"></div>
      <RevealOnScroll>
        <div class="mw-sec-meta"><span class="mw-sec-index">04</span><span class="mw-eyebrow">GET STARTED</span></div>
        <h2>五分钟起一个能用的后端</h2>
        <p>四条命令，加上你自己的源包。</p>
        <div class="mw-cta-actions">
          <a class="mw-btn mw-btn-primary" :href="withBase('/guide/quick-start.html')">快速开始</a>
          <a class="mw-btn mw-btn-ghost" :href="downloads">下载客户端</a>
        </div>
        <div class="mw-cta-meta">
          <a :href="limits">已知限制</a>
          <span aria-hidden="true">·</span>
          <a :href="license">许可与免责</a>
          <span aria-hidden="true">·</span>
          <a href="https://github.com/upchr/meow/releases" target="_blank" rel="noreferrer">Releases ↗</a>
        </div>
      </RevealOnScroll>
    </section>
  </div>
</template>

<style scoped>
.mw-home {
  overflow: clip;
}

.mw-stats {
  margin-top: 6px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 32px;
}

.mw-stat {
  padding: 26px 10px 28px;
  border-left: 1px solid var(--mw-line);
  text-align: center;
}

.mw-stat:first-child {
  border-left: 0;
}

.mw-stat b {
  display: block;
  color: var(--mw-text);
  font-size: clamp(26px, 2.6vw, 34px);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  background: linear-gradient(180deg, var(--mw-text) 30%, var(--mw-text-2) 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.mw-stat span {
  display: block;
  margin-top: 7px;
  color: var(--mw-text-3);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
}

.mw-section {
  position: relative;
  max-width: 1200px;
  margin: 0 auto;
  padding: 76px 32px;
}

.mw-section-alt::before {
  content: '';
  position: absolute;
  inset: 0 -50vw;
  z-index: -1;
  background: var(--mw-section-alt-bg);
  border-top: 1px solid var(--mw-line);
  border-bottom: 1px solid var(--mw-line);
}

.mw-section-head {
  max-width: 720px;
  margin-bottom: 44px;
}

.mw-sec-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.mw-sec-index {
  padding: 1px 7px;
  border: 1px solid var(--mw-line);
  border-radius: 5px;
  color: var(--mw-text-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  font-weight: 600;
}

.mw-eyebrow {
  display: inline-block;
  margin-bottom: 0;
  color: var(--mw-cyan);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.mw-section-head h2,
.mw-boundary h2,
.mw-cta h2 {
  margin: 0;
  color: var(--mw-text);
  font-size: clamp(26px, 3.2vw, 38px);
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.025em;
}

.mw-section-head p,
.mw-cta p {
  margin: 16px 0 0;
  color: var(--mw-text-2);
  font-size: 15.5px;
  line-height: 1.8;
}

/* ── 边界面板 ───────────────────────────── */
.mw-boundary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 40px;
  padding: 40px;
  border: 1px solid var(--mw-line);
  border-radius: 20px;
  background:
    radial-gradient(120% 120% at 0% 0%, rgba(255, 107, 107, 0.07), transparent 55%),
    var(--mw-panel-flat);
}

.mw-boundary-copy p {
  margin: 14px 0 0;
  color: var(--mw-text-2);
  font-size: 14.5px;
  line-height: 1.8;
}

.mw-inline-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 20px;
  color: var(--mw-cyan);
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
}

.mw-inline-link span {
  transition: transform 0.2s ease;
}

.mw-inline-link:hover span {
  transform: translateX(3px);
}

.mw-boundary-list {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.mw-boundary-list li {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.mw-mark {
  display: grid;
  place-items: center;
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  font-size: 13px;
}

.mw-mark.is-no {
  border: 1px solid rgba(255, 107, 107, 0.35);
  background: rgba(255, 107, 107, 0.1);
  color: #ff8a8a;
}

.mw-boundary-list b {
  display: block;
  color: var(--mw-text);
  font-size: 14.5px;
  font-weight: 650;
}

.mw-boundary-list em {
  display: block;
  margin-top: 3px;
  color: var(--mw-text-2);
  font-size: 13px;
  font-style: normal;
  line-height: 1.6;
}

/* ── CTA ───────────────────────────────── */
.mw-cta {
  padding-top: 64px;
  padding-bottom: 110px;
  text-align: center;
}

.mw-cta-glow {
  position: absolute;
  left: 50%;
  top: 42%;
  z-index: -1;
  width: min(760px, 92vw);
  height: 320px;
  transform: translate(-50%, -50%);
  background: radial-gradient(ellipse at center, var(--mw-glow-a), transparent 68%);
  pointer-events: none;
}

.mw-cta .mw-sec-meta {
  justify-content: center;
}

.mw-cta p {
  margin-top: 14px;
}

.mw-cta-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.mw-cta-meta {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 26px;
  color: var(--mw-text-3);
  font-size: 12.5px;
}

.mw-cta-meta a {
  color: var(--mw-text-2);
  text-decoration: none;
}

.mw-cta-meta a:hover {
  color: var(--mw-cyan);
}

/* 复用 Hero 的按钮样式：scoped 下用 :deep 取不到，这里重复定义一份 */
.mw-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 46px;
  padding: 0 24px;
  border-radius: 11px;
  font-size: 14.5px;
  font-weight: 650;
  text-decoration: none;
  transition:
    transform 0.2s ease,
    box-shadow 0.25s ease,
    border-color 0.25s ease,
    background 0.25s ease;
}

.mw-btn:hover {
  transform: translateY(-1px);
}

.mw-btn-primary {
  color: #04120f;
  background: linear-gradient(135deg, #5cf5e4, var(--mw-cyan) 55%, #00b9a8);
  box-shadow:
    0 0 0 1px rgba(3, 218, 197, 0.5),
    0 10px 34px -8px rgba(3, 218, 197, 0.55);
}

.mw-btn-primary:hover {
  box-shadow:
    0 0 0 1px rgba(3, 218, 197, 0.7),
    0 14px 42px -8px rgba(3, 218, 197, 0.7);
}

.mw-btn-ghost {
  color: var(--mw-text);
  border: 1px solid var(--mw-line);
  background: var(--mw-panel);
}

.mw-btn-ghost:hover {
  border-color: var(--mw-line-strong);
  background: var(--mw-panel-hover);
}

@media (max-width: 900px) {
  .mw-boundary {
    grid-template-columns: 1fr;
    gap: 28px;
    padding: 30px 24px;
  }
}

@media (max-width: 720px) {
  .mw-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 0 22px;
  }

  .mw-stat:nth-child(3) {
    border-left: 0;
  }

  .mw-stat:nth-child(n + 3) {
    border-top: 1px solid var(--mw-line);
  }
}

@media (max-width: 640px) {
  .mw-section {
    padding: 64px 22px;
  }

  .mw-section-head {
    margin-bottom: 32px;
  }
}
</style>
