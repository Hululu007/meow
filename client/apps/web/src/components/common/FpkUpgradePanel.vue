<script setup lang="ts">
/**
 * fnOS fpk「应用更新」区块（只升到最新版本）。
 *
 * <p>只在被 fnOS 应用中心托管时出现：判据是 meowd 的 `/api/_shell/info` 能通
 * **且** `/app-center/v1/app/installed` 能通（后者只有 5666 网关入口有）。
 * 直接访问 `http://<NAS>:30010/` 时这里什么也不渲染，不会给 Web 用户
 * 一个永远灰着的按钮。
 *
 * <p>流程与失败原因都在 `api/fpkUpgrade.ts`，这里只画状态。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  detectFpkShell,
  fetchIndexes,
  fpkIndexUrl,
  humanReason,
  pickLatestFromIndexes,
  runFpkUpgrade,
  setFpkIndexUrl,
  waitForRestart,
  type FpkLatest,
  type FpkProgress,
  type FpkShellInfo,
  type InstalledApp,
} from '@/api/fpkUpgrade'

const visible = ref(false)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const current = ref('')
const target = ref<FpkLatest | null>(null)
const upToDate = ref(false)
const progress = ref<FpkProgress | null>(null)
const done = ref(false)
const restartNote = ref('')
const indexUrl = ref(fpkIndexUrl())
const indexInput = ref('')
const indexHost = computed(() => {
  try {
    return new URL(indexUrl.value, location.href).host
  } catch {
    return indexUrl.value
  }
})

let info: FpkShellInfo | null = null
let installed: InstalledApp | null = null
let disposed = false

onMounted(() => {
  void refresh()
})
onBeforeUnmount(() => {
  disposed = true
})

const noteLines = computed(() => {
  const lines = target.value?.notes || []
  return lines.slice(0, 4)
})
const moreNotes = computed(() => Math.max(0, (target.value?.notes?.length || 0) - 4))

function fmtSize(n: number): string {
  if (!n || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function fmtDate(s?: string): string {
  if (!s) return ''
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/** 探测是不是 fpk 入口，并顺带查一次新版本 */
async function refresh(): Promise<void> {
  if (busy.value) return
  loading.value = true
  error.value = ''
  upToDate.value = false
  done.value = false
  restartNote.value = ''
  progress.value = null
  try {
    const det = await detectFpkShell()
    if (disposed) return
    if (!det) {
      visible.value = false
      return
    }
    visible.value = true
    indexUrl.value = fpkIndexUrl()
    info = det.info
    installed = det.installed
    // 应用中心的已安装版本更权威（升级后重启期间 meowd 报的还是旧值）。
    current.value = det.installed?.version || det.info.version
    const indexes = await fetchIndexes(undefined, current.value)
    const picked = pickLatestFromIndexes(indexes, det.info, current.value)
    if (disposed) return
    if (!picked) {
      target.value = null
      upToDate.value = true
      return
    }
    if ('noPackage' in picked) {
      error.value = `新版本 v${picked.version} 没有当前架构（${det.info.arch || 'x86'}）的安装包`
      return
    }
    target.value = picked.latest
  } catch (e) {
    error.value = humanReason(e)
  } finally {
    if (!disposed) loading.value = false
  }
}

/** 保存索引地址并重新检查（空值 = 恢复默认） */
function saveIndex(): void {
  setFpkIndexUrl(indexInput.value)
  indexInput.value = ''
  void refresh()
}

function resetIndex(): void {
  indexInput.value = ''
  setFpkIndexUrl('')
  void refresh()
}

async function start(): Promise<void> {
  if (busy.value || !target.value || !info) return
  busy.value = true
  error.value = ''
  done.value = false
  restartNote.value = ''
  progress.value = {
    phase: 'downloading',
    percent: 0,
    text: '准备下载…',
  }
  try {
    await runFpkUpgrade(target.value, installed, info, (p) => {
      progress.value = p
    })
    done.value = true
    restartNote.value = '正在等待服务重启…'
    const ok = await waitForRestart()
    if (disposed) return
    if (ok) {
      restartNote.value = '服务已恢复，正在刷新页面…'
      setTimeout(() => location.reload(), 800)
    } else {
      restartNote.value = '升级任务已完成，但服务在 90 秒内没有恢复。请手动刷新页面，或到应用中心查看状态。'
      busy.value = false
    }
  } catch (e) {
    error.value = humanReason(e)
    progress.value = null
    busy.value = false
  }
}
</script>

<template>
  <div v-if="visible" class="set-sub mt-3 border-t border-line pt-3" data-fpk-upgrade>
    <span class="font-medium text-ink-2">fnOS 应用更新</span>
    <span class="text-[length:var(--fs-mini)] text-ink-3">
      当前 v{{ current || '…' }}
      <template v-if="upToDate">· 已是最新版本</template>
      <template v-else-if="target">· 发现 v{{ target.version }}</template>
    </span>
    <span class="flex-1" />
    <button
      v-if="!busy"
      class="rounded-md bg-card px-2.5 py-1 text-[length:var(--fs-mini)] hover:bg-card-hover"
      :disabled="loading"
      @click="refresh()"
    >
      {{ loading ? '检查中…' : '检查更新' }}
    </button>
  </div>

  <div v-if="visible" class="pb-3 text-[length:var(--fs-xs)]">
    <p v-if="error" class="text-hot">{{ error }}</p>

    <template v-else-if="target && !busy && !done">
      <p class="text-ink">
        发现新版本
        <span class="font-medium text-accent">v{{ target.version }}</span>
        <span v-if="target.pkg.size" class="ml-2 text-ink-3">{{ fmtSize(target.pkg.size) }}</span>
        <span v-if="fmtDate(target.release.updated_at)" class="ml-2 text-ink-3">
          {{ fmtDate(target.release.updated_at) }} 发布
        </span>
      </p>
      <ul v-if="noteLines.length" class="mt-1 space-y-0.5 text-ink-3">
        <li v-for="(line, i) in noteLines" :key="i">{{ line }}</li>
        <li v-if="moreNotes" class="text-ink-3/70">… 还有 {{ moreNotes }} 条</li>
      </ul>
      <p class="mt-1 text-ink-3">升级会重启服务，页面会短暂断开，属正常现象。</p>
      <div class="mt-2 flex items-center gap-2">
        <button
          class="rounded-md bg-accent px-3 py-1.5 text-[length:var(--fs-xs)] font-medium text-on-accent hover:bg-accent-dim"
          @click="start()"
        >
          立即更新
        </button>
      </div>
    </template>

    <template v-else-if="busy">
      <p class="text-ink">{{ progress?.text || '正在升级…' }}</p>
      <div class="mt-2 h-1 w-full overflow-hidden rounded bg-card">
        <div
          class="h-full bg-accent transition-all"
          :style="{ width: `${progress?.percent || 0}%` }"
        />
      </div>
      <p class="mt-1 text-ink-3">
        升级会重启服务；中途页面断开是正常现象，刷新后会回到新版本。
      </p>
      <p v-if="restartNote" class="mt-1 text-ink-3">{{ restartNote }}</p>
    </template>

    <template v-else-if="done">
      <p class="text-ok">已升级到 v{{ target?.version || current }}</p>
      <p v-if="restartNote" class="mt-1 text-ink-3">{{ restartNote }}</p>
    </template>

    <template v-else-if="upToDate">
      <p class="text-ink-3">已是最新版本</p>
    </template>

    <p v-else-if="loading" class="text-ink-3">正在检查新版本…</p>
  </div>

  <!-- 索引源：默认走 jsDelivr(gcore)，私有源/内网镜像可在这里改（存 localStorage） -->
  <div v-if="visible" class="pb-3 text-[length:var(--fs-mini)] text-ink-3">
    <details>
      <summary class="cursor-pointer select-none">更新索引源（{{ indexHost }}）</summary>
      <div class="mt-1.5 flex items-center gap-2">
        <input
          v-model="indexInput"
          :placeholder="indexUrl"
          class="min-w-0 flex-1 rounded-md border border-line bg-card px-2 py-1 text-ink outline-none"
          spellcheck="false"
        />
        <button class="rounded-md bg-card px-2 py-1 hover:bg-card-hover" @click="saveIndex()">
          保存
        </button>
        <button class="rounded-md bg-card px-2 py-1 hover:bg-card-hover" @click="resetIndex()">
          恢复默认
        </button>
      </div>
      <p class="mt-1 text-ink-3/70">
        留空即用主仓镜像 → FnDepot 兜底；手填只用自己的，不回退。可填 owner/repo、GitHub 仓库地址或完整 URL。
      </p>
    </details>
  </div>
</template>
