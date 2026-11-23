<script setup lang="ts">
import { withBase } from 'vitepress'

/**
 * 指南「能力范围」卡片。
 *
 * 原来是一张 9 行纯文本表：没有链接、每格一长串顿号，扫读成本高。
 * 这里换成和首页同风格的能力卡：模块 + 一句话 + 关键词 + 去哪看。
 * 本页目录仍由 markdown 的 `##` 生成，组件内的标题不用 heading 标签，避免污染 outline。
 */
const items = [
  {
    title: '浏览与搜索',
    desc: '首页推荐、分类分页与跨源聚合搜索，带进度与结果缓存。',
    tags: ['继续观看', '分类分页', '聚合搜索', '详情页', '搜索历史', '收藏 / 追剧'],
    to: '/guide/vod-live.html',
    more: '怎么找片',
  },
  {
    title: '播放',
    desc: '常见格式直接播；播不动自动换线，编码不支持时自动转码。',
    tags: ['续播', '0.5–3x', '片头尾跳过', '选集连播', '字幕 / 画中画', 'DLNA 投屏', '卡顿自愈'],
    to: '/guide/playback.html',
    more: '播放器操作',
  },
  {
    title: '弹幕',
    desc: '多源自动选，可手动搜、可调样式、可离线缓存。',
    tags: ['多源', '手动搜索', '屏蔽词', '密度 / 字号 / 透明度', '显示区域', '片尾预取', '离线缓存'],
    to: '/guide/playback.html#弹幕从哪来',
    more: '弹幕怎么调',
  },
  {
    title: '直播',
    desc: '站点直播表 + IPTV 列表；换台遇到坏台会自己跳。',
    tags: ['IPTV m3u / txt', '换台', '坏台自动跳', '线路切换'],
    to: '/guide/vod-live.html',
    more: '直播怎么用',
  },
  {
    title: '片库与缓存',
    desc: 'NAS、网盘、本机目录都能加；按需转码，海报自动补。',
    tags: ['WebDAV / SMB / 本地', '按需转码', '海报刮削', '单集 / 整季', '断点续传', '离线优先'],
    to: '/guide/library.html',
    more: '加自己的片库',
  },
  {
    title: '跨端状态',
    desc: '收藏、进度、历史在端之间同步；WebDAV 做快照备份。',
    tags: ['收藏 / 进度', '历史', '观看统计 / 偏好', 'WebDAV 同步'],
    to: '/guide/backup.html',
    more: '同步与备份',
  },
  {
    title: '源与配置',
    desc: '一份配置管多仓；站点可停用、可体检。',
    tags: ['多仓导入', '自动备份', '站点健康', '批量管理', '安全 DNS', 'JS 源'],
    to: '/guide/source-pack.html',
    more: '导入源包',
  },
  {
    title: '设置与 AI',
    desc: '外观、网络、弹幕、播放、存储都在设置里；AI 不配模型也能做本地诊断。',
    tags: ['设置分区', 'AI 诊断', '不花 token 也能用'],
    to: '/guide/ai.html',
    more: 'AI 怎么用',
  },
]
</script>

<template>
  <div class="cap-grid">
    <a v-for="(item, i) in items" :key="item.title" class="cap-card" :href="withBase(item.to)">
      <span class="cap-head">
        <span class="cap-index">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="cap-title">{{ item.title }}</span>
      </span>
      <span class="cap-desc">{{ item.desc }}</span>
      <span class="cap-tags">
        <span v-for="tag in item.tags" :key="tag" class="cap-tag">{{ tag }}</span>
      </span>
      <span class="cap-more">{{ item.more }} →</span>
    </a>
  </div>
</template>

<style scoped>
.cap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(272px, 1fr));
  gap: 12px;
  margin: 18px 0 10px;
}

.cap-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 16px 14px;
  border: 1px solid var(--mw-line);
  border-radius: 12px;
  background: var(--mw-panel-flat);
  text-decoration: none;
  transition:
    border-color 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.cap-card:hover {
  border-color: var(--mw-cyan);
  transform: translateY(-2px);
  box-shadow: 0 10px 30px -18px rgba(3, 218, 197, 0.55);
}

/* 条目为奇数时，最后一张铺满整行，避免末尾留半个空位 */
.cap-card:last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.cap-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.cap-index {
  color: var(--mw-cyan);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  font-variant-numeric: tabular-nums;
}

.cap-title {
  color: var(--mw-text);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.cap-desc {
  color: var(--mw-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.cap-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cap-tag {
  padding: 2px 8px;
  border: 1px solid var(--mw-line);
  border-radius: 999px;
  color: var(--mw-text-3);
  font-size: 11px;
  line-height: 1.7;
  white-space: nowrap;
}

.cap-more {
  margin-top: auto;
  padding-top: 4px;
  color: var(--mw-cyan);
  font-size: 12px;
  font-weight: 600;
  opacity: 0.9;
}

@media (max-width: 640px) {
  .cap-grid {
    grid-template-columns: 1fr;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cap-card,
  .cap-card:hover {
    transition: none;
    transform: none;
  }
}
</style>
