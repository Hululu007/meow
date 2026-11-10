<script setup lang="ts">
// 纯静态 SVG，无运行时依赖
</script>

<template>
  <svg class="kw-diagram" viewBox="0 0 660 420" role="img" aria-label="Web、PC、TV 三端通过同一个宿主加载第三方源包">
    <defs>
      <filter id="kw-glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="7" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <linearGradient id="kw-core-fill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="rgba(3,218,197,0.16)" />
        <stop offset="100%" stop-color="rgba(124,92,255,0.10)" />
      </linearGradient>
    </defs>

    <!-- 连接线：三端 → 宿主 → 源包 -->
    <g class="kw-wires" fill="none" stroke-linecap="round">
      <path class="kw-wire" d="M174 78 C 210 78, 212 210, 250 210" />
      <path class="kw-wire" d="M174 220 C 200 220, 222 220, 250 220" />
      <path class="kw-wire" d="M174 362 C 210 362, 212 230, 250 230" />
      <path class="kw-wire kw-wire-out" d="M430 220 C 464 220, 472 220, 508 220" />
    </g>

    <!-- 三端 -->
    <g class="kw-node">
      <rect x="16" y="40" width="158" height="76" rx="12" />
      <text x="95" y="72" class="kw-node-title" text-anchor="middle">Web</text>
      <text x="95" y="94" class="kw-node-sub" text-anchor="middle">Docker 四容器</text>
    </g>
    <g class="kw-node">
      <rect x="16" y="182" width="158" height="76" rx="12" />
      <text x="95" y="214" class="kw-node-title" text-anchor="middle">PC</text>
      <text x="95" y="236" class="kw-node-sub" text-anchor="middle">Tauri 桌面壳</text>
    </g>
    <g class="kw-node">
      <rect x="16" y="324" width="158" height="76" rx="12" />
      <text x="95" y="356" class="kw-node-title" text-anchor="middle">TV</text>
      <text x="95" y="378" class="kw-node-sub" text-anchor="middle">端内网关</text>
    </g>

    <!-- 宿主核心 -->
    <g class="kw-core" filter="url(#kw-glow)">
      <rect x="250" y="130" width="180" height="180" rx="20" />
      <text x="340" y="176" class="kw-core-title" text-anchor="middle">JVM 宿主</text>
      <text x="340" y="204" class="kw-core-sub" text-anchor="middle">classpath · DexClassLoader</text>
      <line x1="276" y1="222" x2="404" y2="222" class="kw-core-line" />
      <text x="340" y="252" class="kw-core-sub" text-anchor="middle">同一份 spider jar</text>
      <text x="340" y="276" class="kw-core-sub" text-anchor="middle">同一套配置语义</text>
    </g>

    <!-- 源包 -->
    <g class="kw-node kw-node-source">
      <rect x="508" y="175" width="144" height="90" rx="12" />
      <text x="580" y="208" class="kw-node-title" text-anchor="middle">源包</text>
      <text x="580" y="230" class="kw-node-sub" text-anchor="middle">config.json</text>
      <text x="580" y="249" class="kw-node-sub" text-anchor="middle">+ spider jar</text>
    </g>

  </svg>
</template>

<style scoped>
.kw-diagram {
  width: 100%;
  height: auto;
  overflow: visible;
}

.kw-node rect {
  fill: var(--mw-panel);
  stroke: var(--mw-line);
  stroke-width: 1;
}

.kw-node-title {
  fill: var(--mw-text);
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.kw-node-sub {
  fill: var(--mw-text-2);
  font-size: 13px;
}

.kw-node-source rect {
  stroke: var(--mw-line-strong);
}

.kw-core rect {
  fill: url(#kw-core-fill);
  stroke: var(--mw-cyan);
  stroke-width: 1.4;
}

.kw-core-title {
  fill: var(--mw-text);
  font-size: 22px;
  font-weight: 800;
}

.kw-core-sub {
  fill: var(--mw-text-2);
  font-size: 12.5px;
}

.kw-core-line {
  stroke: var(--mw-line);
  stroke-width: 1;
}

.kw-wire {
  stroke: var(--mw-cyan);
  stroke-width: 1.6;
  stroke-dasharray: 7 9;
  opacity: 0.55;
  animation: kw-flow 1.6s linear infinite;
}

.kw-wire-out {
  stroke: var(--mw-violet);
  opacity: 0.6;
}

.kw-caption {
  fill: var(--mw-text-3);
  font-size: 12.5px;
  letter-spacing: 0.04em;
}

@keyframes kw-flow {
  to {
    stroke-dashoffset: -16;
  }
}

@media (prefers-reduced-motion: reduce) {
  .kw-wire {
    animation: none;
  }
}
</style>
