<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { VodItem } from '@/api/types'
import PosterImage from './PosterImage.vue'
import { posterBadges } from '@/utils/remarks'

const props = defineProps<{ item: VodItem; site: string }>()
const emit = defineEmits<{ (e: 'open', item: VodItem): void }>()
const router = useRouter()

/** 评分（右上）与集数（左下）分开：豆瓣剧集两者都有时同时显示 */
const badges = computed(() => posterBadges(props.item))

function open() {
  emit('open', props.item)
  /*
   * name 必须带上：有些源（实测豆瓣）的 `/detail` 会返回空 list，
   * 详情页拿不到数据时靠这个片名转去搜索页（见 DetailView.load）。
   * 不带的话用户只能对着空白页按返回。
   */
  router.push({
    name: 'detail',
    params: { site: props.site, id: props.item.vod_id },
    query: props.item.vod_name ? { name: props.item.vod_name } : undefined,
  })
}
</script>

<template>
  <!--
    按钮自己必须带 rounded-lg（2026-11-04 用户报「海报聚焦边框要有弧度」）：
    tv-nav 的焦点环是 button 上的 box-shadow，会跟随该元素的 border-radius；
    原来圆角只加在内层 div 上，按钮是直角的，于是环也是直角 ——
    历史页那套（外层就带 rounded-lg）才是对的。
  -->
  <button class="poster-card group block w-full rounded-lg text-left" @click="open">
    <div class="relative aspect-[2/3] overflow-hidden rounded-lg bg-elevated">
      <PosterImage
        :src="item.vod_pic"
        :alt="item.vod_name"
        img-class="transition duration-300 group-hover:brightness-110"
      />

      <!--
        备注角标：评分（右上）+ 集数/备注（左下），样式在 tokens.css 的 .poster-badge。
        两者都有时同时显示，例如「8.1」+「30集全」。
      -->
      <span v-if="badges.remark" class="poster-badge font-medium">{{ badges.remark }}</span>
      <span v-if="badges.score" class="poster-badge poster-badge--score font-medium">
        {{ badges.score }}
      </span>

      <!-- hover 播放按钮 -->
      <div
        class="absolute inset-0 grid place-items-center bg-field opacity-0 transition group-hover:opacity-100"
      >
        <span class="grid h-12 w-12 place-items-center rounded-full bg-accent/90 text-on-accent shadow-lg">
          <svg class="ml-0.5 h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </div>

      <!-- 底部渐变 -->
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 to-transparent"
      />
    </div>

    <div class="mt-2 px-0.5">
      <div class="poster-title truncate font-medium text-ink group-hover:text-accent">
        {{ item.vod_name }}
      </div>
      <div class="mt-0.5 truncate text-[11px] text-ink-3">
        {{ [item.vod_year, item.vod_area].filter(Boolean).join(' · ') || '　' }}
      </div>
    </div>
  </button>
</template>
