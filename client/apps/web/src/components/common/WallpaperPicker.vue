<script setup lang="ts">
import { computed, ref } from 'vue'
import { WALLPAPERS, getCustomWallpaper, setCustomWallpaper } from '@/stores/theme'
import { isLightWallpaper } from '@/stores/wallpapers'

/**
 * 背景图选择器：横向缩略图卡片 + 上传入口。
 *
 * 为什么不用 TileSelect：那一列只有文字，选背景图时看不到实际效果，
 * 用户得来回试点。这里直接给缩略图，「所见即所选」。
 *
 * ## 上传的实现
 *
 * 用户选的图会：
 *   1. 用 canvas 缩到最长边 1920 并转 WebP（质量 0.82）
 *   2. 存进 localStorage 的 `meow.wallpaper.custom`
 *   3. prefs 里只记 `wallpaper: 'custom'`
 *
 * 为什么不直接存原图：手机照片常 3-5MB，localStorage 上限一般 5MB，
 * 而且 meow.prefs 会进 WebDAV 备份，塞原图会让备份文件暴涨。
 * 单独一个 key 是为了让「恢复默认设置」不至于连用户上传的图一起清掉。
 */
const props = defineProps<{
  modelValue: string
  blur: number
  /**
   * 当前生效的明暗（来自 prefs.themeMode，system 时取实际算出的值）。
   *
   * 只用来**排序**，不过滤：用户可能就想给深色主题配一张亮图（故意要
   * "白纸黑字"的观感）。过滤掉会让"我明明看到过那张图"变成找不到。
   * 所以匹配当前主题的那组排前面并加标题，另一组收在后面。
   */
  mode?: 'light' | 'dark'
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

/**
 * 按明暗分组，匹配当前主题的那组排前面。
 *
 * 「无背景」和「我的图片」不进任何一组：前者是"关掉背景"，后者跟明暗无关，
 * 把它们塞进"深色/浅色"分组里反而让人以为它属于某一类。
 */
const groups = computed(() => {
  const matches: typeof WALLPAPERS = []
  const others: typeof WALLPAPERS = []
  for (const w of WALLPAPERS) {
    if (!w.value) continue
    const isLight = isLightWallpaper(w.value)
    const wanted = props.mode === 'light'
    ;(isLight === wanted ? matches : others).push(w)
  }
  const wantLight = props.mode === 'light'
  return [
    { key: 'match', title: wantLight ? '浅色系 · 配浅色主题' : '深色系 · 配深色主题', items: matches },
    { key: 'other', title: wantLight ? '深色系' : '浅色系', items: others },
  ].filter((g) => g.items.length)
})

/** 「无背景」单独取出来，永远排第一个 */
const noneItem = computed(() => WALLPAPERS.find((w) => !w.value))

/** 上传后的预览地址（'custom' 时用） */
const customSrc = ref(getCustomWallpaper())
const uploading = ref(false)
const errMsg = ref('')
const fileInput = ref<HTMLInputElement>()

function pick(v: string) {
  emit('update:modelValue', v)
}

function openPicker() {
  fileInput.value?.click()
}

/**
 * 把 File 压成可存的 data URL。
 * 最长边 1920、WebP 0.82：实测摄影类图片约 150-400KB。
 */
function compress(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX = 1920
      let { width, height } = img
      if (Math.max(width, height) > MAX) {
        const k = MAX / Math.max(width, height)
        width = Math.round(width * k)
        height = Math.round(height * k)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('浏览器不支持 canvas'))
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/webp', 0.82))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解析失败'))
    }
    img.src = url
  })
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许连续选同一个文件
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errMsg.value = '请选择图片文件'
    return
  }

  uploading.value = true
  errMsg.value = ''
  try {
    const dataUrl = await compress(file)
    // 估算体积：data URL 的 base64 部分 × 0.75
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
    if (bytes > 3.5 * 1024 * 1024) {
      errMsg.value = `压缩后仍有 ${(bytes / 1048576).toFixed(1)}MB，请换一张更小的`
      return
    }
    setCustomWallpaper(dataUrl)
    customSrc.value = dataUrl
    emit('update:modelValue', 'custom')
  } catch (e: any) {
    errMsg.value = e?.message || '处理失败'
  } finally {
    uploading.value = false
  }
}

function removeCustom() {
  setCustomWallpaper('')
  customSrc.value = ''
  if (props.modelValue === 'custom') emit('update:modelValue', '')
}

/**
 * 缩略图的预览效果：只反映「背景模糊」。
 *
 * ★ 不要在这里叠「壁纸可见度」蒙层（原来有，默认约 70% 黑）：
 *   深色壁纸会被压成一团黑，浅色壁纸也会发灰，选图时根本判断不了效果。
 *   可见度影响的是首页卡片底色，真正的差异切到首页就能看到。
 *
 * ★ 不要在缩略图上叠「示意卡片」之类的东西 —— 加过一版，
 *   缩略图只有 8.5rem 宽，塞进去只剩噪音；真正的卡片效果切一下就看到，
 *   不需要在小图上模拟。
 */
const previewStyle = computed(() => ({
  filter: props.blur > 0 ? `blur(${Math.min(props.blur, 6) * 0.6}px)` : undefined,
}))</script>

<template>
  <div>
    <!--
      第一行：无背景 + 我的图片（如果有）+ 上传入口。
      ★ 上传按钮原来单独占一行（在最底下），用户反馈"多占一行"。
        它和「无背景」都是"非预设图"的操作，放同一行语义也更顺。

      ★ 名称一律放在图片下方的独立一行，不压在图上：
        压图时得垫底部渐变（0.88 → 0.72 黑），整张图会被压暗；
        名称离开图片后，缩略图只保留图片本身，选图才看得清。
    -->
    <div class="flex flex-wrap gap-2.5">
      <!-- 无背景：永远第一个，不属于任何明暗组 -->
      <button
        v-if="noneItem"
        type="button"
        class="group flex w-[8.5rem] shrink-0 flex-col gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
        :title="noneItem.label"
        @click="pick(noneItem.value)"
      >
        <span
          class="relative block h-[4.78125rem] w-full overflow-hidden rounded-lg border transition"
          :class="
            modelValue === noneItem.value
              ? 'border-accent/60 ring-1 ring-accent/40'
              : 'border-line group-hover:border-line-hover'
          "
        >
          <span class="absolute inset-0 grid place-items-center bg-field text-ink-3">
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 3l18 18M4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z" />
            </svg>
          </span>
          <span
            v-if="modelValue === noneItem.value"
            class="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-on-accent"
          >
            <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
              <path d="m5 13 4 4L19 7" />
            </svg>
          </span>
        </span>
        <span
          class="block w-full truncate px-0.5 text-[11px] leading-4"
          :class="modelValue === noneItem.value ? 'text-ink' : 'text-ink-2'"
        >
          {{ noneItem.label }}
        </span>
      </button>

      <!-- 我的图片（上传过才出现） -->
      <div
        v-if="customSrc"
        class="group flex w-[8.5rem] shrink-0 flex-col gap-1.5 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent/60"
      >
        <div
          class="relative h-[4.78125rem] w-full overflow-hidden rounded-lg border transition"
          :class="
            modelValue === 'custom'
              ? 'border-accent/60 ring-1 ring-accent/40'
              : 'border-line group-hover:border-line-hover'
          "
        >
          <button type="button" class="block h-full w-full" title="我的图片" @click="pick('custom')">
            <img
              :src="customSrc"
              alt="我的图片"
              class="h-full w-full object-cover"
              :style="previewStyle"
            />
          </button>
          <!-- 深色壁纸在深色面板上靠这条内描边保持轮廓 -->
          <span class="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-white/15" />
          <span
            v-if="modelValue === 'custom'"
            class="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-on-accent"
          >
            <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
              <path d="m5 13 4 4L19 7" />
            </svg>
          </span>
          <button
            type="button"
            class="absolute left-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-[10px] text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
            title="删除我的图片"
            @click.stop="removeCustom"
          >
            ✕
          </button>
        </div>
        <button
          type="button"
          class="block w-full truncate px-0.5 text-left text-[11px] leading-4 transition hover:text-ink"
          :class="modelValue === 'custom' ? 'text-ink' : 'text-ink-2'"
          @click="pick('custom')"
        >
          我的图片
        </button>
      </div>

      <!-- 上传入口：高度=图片 4.78125rem + 间距 0.375rem + 名称行 1rem，和左侧卡片齐平 -->
      <button
        type="button"
        class="grid h-[6.15625rem] w-[8.5rem] shrink-0 place-items-center rounded-lg border border-dashed border-line-hover text-ink-3 transition hover:border-accent/50 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60 disabled:opacity-50"
        :disabled="uploading"
        title="从本机选择图片（自动压缩到 1920px 宽的 WebP）"
        @click="openPicker"
      >
        <span class="flex flex-col items-center gap-1 text-[11px]">
          <svg
            v-if="!uploading"
            class="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
          >
            <path d="M12 16V4m0 0L8 8m4-4 4 4" />
            <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
          <span
            v-else
            class="h-4 w-4 animate-spin rounded-full border-2 border-line-hover border-t-accent"
          />
          {{ uploading ? '处理中' : '上传图片' }}
        </span>
      </button>

      <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="onFile" />
    </div>

    <p v-if="errMsg" class="mt-2 w-full text-[11px] text-hot">{{ errMsg }}</p>

    <!-- 按明暗分组：匹配当前主题的排第一 -->
    <template v-for="g in groups" :key="g.key">
      <div class="mt-2.5 mb-1.5 flex items-center gap-2">
        <span class="text-[11px] text-ink-3">{{ g.title }}</span>
        <span class="h-px flex-1 bg-line" />
      </div>
      <div class="flex flex-wrap gap-2.5">
        <button
          v-for="w in g.items"
          :key="w.value || 'none'"
          type="button"
          class="group flex w-[8.5rem] shrink-0 flex-col gap-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60"
          :title="w.label"
          @click="pick(w.value)"
        >
          <span
            class="relative block h-[4.78125rem] w-full overflow-hidden rounded-lg border transition"
            :class="
              modelValue === w.value
                ? 'border-accent/60 ring-1 ring-accent/40'
                : 'border-line group-hover:border-line-hover'
            "
          >
            <template v-if="w.thumb">
              <img
                :src="w.thumb"
                :alt="w.label"
                class="h-full w-full object-cover transition group-hover:scale-105"
                :style="previewStyle"
                loading="lazy"
              />
              <!-- 深色壁纸在深色面板上靠这条内描边保持轮廓 -->
              <span class="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-white/15" />
            </template>
            <!-- 无背景：用斜纹示意 -->
            <span v-else class="absolute inset-0 grid place-items-center bg-field text-ink-3">
              <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M3 3l18 18M4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4z" />
              </svg>
            </span>

            <span
              v-if="modelValue === w.value"
              class="absolute right-1.5 top-1.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-on-accent"
            >
              <svg class="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                <path d="m5 13 4 4L19 7" />
              </svg>
            </span>
          </span>
          <span
            class="block w-full truncate px-0.5 text-[11px] leading-4"
            :class="modelValue === w.value ? 'text-ink' : 'text-ink-2'"
          >
            {{ w.label }}
          </span>
        </button>
      </div>
    </template>

    <p v-if="errMsg" class="w-full text-[11px] text-hot">{{ errMsg }}</p>
  </div>
</template>
