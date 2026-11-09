<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 手机底部标签栏（< 640px，透明玻璃 + 中间 AI 凸起）。
 *
 * <p><b>为什么要有</b>：手机顶栏只放得下 logo + 站点胶囊 + 搜索 + 「…」，
 * 首页/设置都被折进菜单里，点两次才到。底部三个一级入口（首页 / AI / 设置）
 * 是手机上最常用的三个去处，常驻在拇指区比藏菜单里合理。
 *
 * <p><b>为什么中间是凸起的圆形</b>：AI 是"发起动作"而不是"浏览分类"，
 * 视觉上要跳出来（用户口径「异型的向上顶出的那种」）。三段等宽 +
 * 中间 orb 绝对定位向上顶出，不改变另外两项的点击区。
 *
 * <p><b>为什么 AI 用标签而不是只留悬浮球</b>：悬浮球和小屏内容抢右下角
 * （历史/收藏的最后一行总被压住）。对话状态在 `stores/aiChat.ts` 是模块级
 * 单例，浮层 → 独立页不会丢上下文，所以手机上改成整页 AI 更合适。
 *
 * <p>PC / TV 不渲染任何东西：`display:none` 从 640px 起生效，
 * 隐藏元素也不会被遥控器聚焦（docs/27 R16 的断点约定）。
 */
const route = useRoute()

/** 首页标签覆盖所有"浏览类"页面：只有 AI / 设置 两个一级页不算 */
const homeActive = computed(() => {
  const n = String(route.name || '')
  return n !== 'ai' && n !== 'settings'
})
const aiActive = computed(() => route.name === 'ai')
const setActive = computed(() => route.name === 'settings')
</script>

<template>
  <nav class="mobile-tabbar" aria-label="主导航">
    <RouterLink to="/" class="mtb-item" :class="{ 'is-on': homeActive }" aria-label="首页">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5.5 9.5V21h13V9.5" />
        <path d="M9.5 21v-6h5v6" />
      </svg>
      <span>首页</span>
    </RouterLink>

    <RouterLink
      to="/ai"
      class="mtb-item mtb-item--ai"
      :class="{ 'is-on': aiActive }"
      aria-label="AI 助手"
    >
      <!-- 凸起的玻璃球：主题色渐变 + 上沿高光 + 外阴影 -->
      <span class="mtb-orb">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" />
          <path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z" />
        </svg>
      </span>
      <span class="mtb-ai-label">AI</span>
    </RouterLink>

    <RouterLink to="/settings" class="mtb-item" :class="{ 'is-on': setActive }" aria-label="设置">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .33 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.33 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.86a1.7 1.7 0 0 0-.33-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.33H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.33 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
      </svg>
      <span>设置</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
/*
 * 透明玻璃 + 悬浮胶囊（用户口径：不要贴底、要透明玻璃）。
 *
 * ★ 底色用 `--color-card`（深色下 5.5% 白、浅色下 6% 黑），**不写死颜色**：
 *   换肤/明暗都跟着走。真正把内容"糊掉"的是 backdrop-filter，不是底色 ——
 *   底色只负责压一层很薄的纱。
 * ★ 不用 color-mix：切主题时会保留上一次算出的值（docs/27 §5.1）。
 */
.mobile-tabbar {
  display: none;
  position: fixed;
  left: 0.75rem;
  right: 0.75rem;
  /* 离底 12px + 安全区：全面屏不压手势条 */
  bottom: calc(0.75rem + env(safe-area-inset-bottom));
  z-index: 40;
  height: 3.5rem;
  border-radius: 1.5rem;
  background: var(--color-card);
  border: 1px solid var(--color-line);
  box-shadow:
    0 14px 34px -18px rgba(0, 0, 0, 0.75),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
}
@media (max-width: 639px) {
  .mobile-tabbar {
    display: flex;
    align-items: stretch;
  }
}
.mtb-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 0.6875rem; /* 11px：小屏上 10px 偏小（实机看着"矮小"） */
  line-height: 1;
  color: var(--color-ink-2);
  -webkit-tap-highlight-color: transparent;
  transition: color 0.15s ease;
}
.mtb-item svg {
  width: 1.5rem;
  height: 1.5rem;
}
.mtb-item.is-on span {
  font-weight: 500;
}
.mtb-item.is-on {
  color: var(--color-accent);
}
.mtb-item:active {
  opacity: 0.65;
}

/* ── 中间：向上顶出的 AI 球 ──────────────────────────────────
 * orb 直径 3.5rem（56px），top=-1.375rem 让它顶出栏顶 22px。
 * 它绝对定位、不占布局：左右两项仍是等宽 1/3，点首页/设置不会误触 AI。
 * 标签固定在栏底（orb 覆盖不到的位置）。
 */
.mtb-item--ai {
  position: relative;
  justify-content: flex-end;
  padding-bottom: 0.375rem;
}
.mtb-orb {
  position: absolute;
  left: 50%;
  top: -1.5rem;
  transform: translateX(-50%);
  width: 3.75rem;
  height: 3.75rem;
  border-radius: 999px;
  display: grid;
  place-items: center;
  color: var(--color-on-accent);
  background: linear-gradient(150deg, var(--color-accent), var(--color-accent-dim));
  /* 头部高光：玻璃球上沿一圈亮边 + 底部轻微内阴影做体积 */
  box-shadow:
    0 10px 22px -8px rgba(0, 0, 0, 0.55),
    inset 0 1px 1px rgba(255, 255, 255, 0.55),
    inset 0 -6px 14px rgba(0, 0, 0, 0.12);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}
.mtb-orb svg {
  width: 1.625rem;
  height: 1.625rem;
}
/* 选中：球微微抬起 + 外圈高光 */
.mtb-item--ai.is-on .mtb-orb {
  transform: translateX(-50%) translateY(-2px);
  box-shadow:
    0 14px 26px -8px rgba(0, 0, 0, 0.6),
    0 0 0 4px rgba(255, 255, 255, 0.08),
    inset 0 1px 1px rgba(255, 255, 255, 0.6);
}
.mtb-item--ai:active .mtb-orb {
  transform: translateX(-50%) scale(0.96);
}
.mtb-ai-label {
  font-size: 0.6875rem;
  line-height: 1;
}
.mtb-item--ai.is-on .mtb-ai-label {
  color: var(--color-accent);
}
</style>
