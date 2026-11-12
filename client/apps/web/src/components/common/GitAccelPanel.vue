<script setup lang="ts">
/**
 * 全局 GitHub 加速列表。
 *
 * <p>只负责"传输层"：哪个代理、什么顺序、哪些渠道启用。
 * 业务源（更新源/插件源/fpk 索引源）仍在各自区块，避免把
 * packages.json 与 fnpack.json 混成一个输入框。
 *
 * <p>保存时同步写 Prefs（Web/TV）和原生 `git-proxies.json`（PC 插件安装器用）。
 */
import { onMounted, reactive, ref } from 'vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import {
  enabledProxyPrefixes,
  normalizeGitAccel,
  normalizeProxyPrefix,
  testProxyPrefix,
  type GitAccelPrefs,
  type GitProxy,
} from '@/api/gitAccel'
import { getPrefs, savePrefs } from '@/stores/prefs'
import { getUpdateToken, setUpdateToken } from '@/api/appUpdate'

const props = withDefaults(defineProps<{ showToken?: boolean }>(), { showToken: true })

const accel = reactive<GitAccelPrefs>(normalizeGitAccel(getPrefs().gitAccel))
const tokenInput = ref(getUpdateToken())
const msg = ref('')
const testingId = ref('')
const testMsg = reactive<Record<string, string>>({})
const newName = ref('')
const newPrefix = ref('')
const editingId = ref('')
const editName = ref('')
const editPrefix = ref('')

const USE_LABELS: Array<{ key: keyof GitAccelPrefs['useFor']; label: string }> = [
  { key: 'appUpdate', label: '应用更新' },
  { key: 'pluginSource', label: '插件源' },
  { key: 'fpk', label: 'fpk 更新' },
  { key: 'configImport', label: '配置导入' },
]

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 同步给 PC 原生插件安装器（TV/Web 没有这个命令，忽略即可） */
function syncNative(): void {
  try {
    const inv = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__?.invoke
    if (typeof inv !== 'function') return
    const prefixes = enabledProxyPrefixes(accel, 'pluginSource')
    void inv('git_proxies_set', { proxies: prefixes }).catch(() => {})
  } catch {
    /* 非 PC 端 */
  }
}

function persist(showMsg = true): void {
  const next = normalizeGitAccel(clone(accel))
  Object.assign(accel, next)
  savePrefs({ gitAccel: next })
  syncNative()
  if (showMsg) {
    msg.value = '已保存'
    window.setTimeout(() => {
      if (msg.value === '已保存') msg.value = ''
    }, 1500)
  }
}

function saveToken(): void {
  setUpdateToken(tokenInput.value)
  msg.value = '令牌已保存'
  window.setTimeout(() => {
    if (msg.value === '令牌已保存') msg.value = ''
  }, 1500)
}

function addCustom(): void {
  const prefix = normalizeProxyPrefix(newPrefix.value)
  if (!prefix) {
    msg.value = '地址必须以 https:// 开头'
    return
  }
  if (accel.proxies.some((p) => p.prefix.toLowerCase() === prefix.toLowerCase())) {
    msg.value = '这个地址已经在列表里'
    return
  }
  accel.proxies.push({
    id: `custom-${Date.now()}`,
    name: newName.value.trim() || prefix,
    prefix,
    enabled: true,
    builtin: false,
  })
  newName.value = ''
  newPrefix.value = ''
  persist()
}

function startEdit(p: GitProxy): void {
  editingId.value = p.id
  editName.value = p.name
  editPrefix.value = p.prefix
}

function cancelEdit(): void {
  editingId.value = ''
}

function saveEdit(p: GitProxy): void {
  const prefix = normalizeProxyPrefix(editPrefix.value)
  if (!prefix) {
    msg.value = '地址必须以 https:// 开头'
    return
  }
  if (
    accel.proxies.some(
      (x) => x.id !== p.id && x.prefix.toLowerCase() === prefix.toLowerCase(),
    )
  ) {
    msg.value = '这个地址已经在列表里'
    return
  }
  p.name = editName.value.trim() || prefix
  p.prefix = prefix
  editingId.value = ''
  persist()
}

function removeProxy(p: GitProxy): void {
  if (p.builtin) return
  accel.proxies = accel.proxies.filter((x) => x.id !== p.id)
  persist()
}

function move(index: number, dir: -1 | 1): void {
  const j = index + dir
  if (j < 0 || j >= accel.proxies.length) return
  const list = accel.proxies.slice()
  const [item] = list.splice(index, 1)
  list.splice(j, 0, item)
  accel.proxies = list
  persist(false)
}

async function testProxy(p: GitProxy): Promise<void> {
  if (testingId.value) return
  testingId.value = p.id
  testMsg[p.id] = '测试中…'
  const r = await testProxyPrefix(p.prefix)
  testMsg[p.id] = r.ok ? `通过 ${r.ms}ms` : `失败${r.status ? ` HTTP ${r.status}` : ''}${r.error ? ` ${r.error}` : ''}`
  testingId.value = ''
}

function resetDefaults(): void {
  const def = normalizeGitAccel(undefined)
  Object.assign(accel, def)
  persist()
}

onMounted(() => {
  // 把已有配置推到原生（老用户升级后插件安装器也能用上）
  syncNative()
})
</script>

<template>
  <div class="mt-3 border-t border-line pt-3 text-[11px] text-ink-2" data-git-accel>
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-medium text-ink-2">GitHub 加速</span>
      <span class="text-[11px] text-ink-3">公开 GitHub 地址的备用线路</span>
      <label class="set-actions flex items-center gap-2 text-[11px] text-ink-2">
        <span>启用</span>
        <ToggleSwitch
          :model-value="accel.enabled"
          label="启用 GitHub 加速"
          @update:model-value="(v) => ((accel.enabled = v), persist())"
        />
      </label>
    </div>
    <p class="mt-1 text-[11px] leading-relaxed text-ink-3">
      只对公开地址生效（raw / release 资产 / 公开 API）。私有仓的 token 请求仍走直连，
      不经过任何代理。列表顺序就是尝试顺序。
    </p>

    <div v-if="props.showToken" class="mt-2 flex items-center gap-2">
      <span class="w-16 shrink-0 text-[11px] text-ink-3">访问令牌</span>
      <input
        v-model="tokenInput"
        type="password"
        class="min-w-0 flex-1 rounded-md bg-card px-2 py-1 font-mono text-[11px]"
        placeholder="私有仓才需要；公开源留空"
        spellcheck="false"
        autocomplete="off"
        @change="saveToken()"
      />
    </div>
    <p v-if="props.showToken" class="mt-1 text-[11px] text-ink-3">
      应用更新 / 插件源 / 运行时模块 / fpk 私有镜像共用这一份令牌，只发给 GitHub 域名。
    </p>

    <div class="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
      <span class="text-ink-3">用于：</span>
      <label v-for="u in USE_LABELS" :key="u.key" class="flex items-center gap-1 text-ink-2">
        <input v-model="accel.useFor[u.key]" type="checkbox" @change="persist()" />
        {{ u.label }}
      </label>
      <label class="flex items-center gap-1 text-ink-2">
        <input v-model="accel.directFirst" type="checkbox" @change="persist()" />
        先试直连
      </label>
    </div>

    <div
      v-for="(p, i) in accel.proxies"
      :key="p.id"
      class="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-field px-2.5 py-1.5"
    >
      <input v-model="p.enabled" type="checkbox" :disabled="!accel.enabled" @change="persist()" />
      <template v-if="editingId === p.id">
        <input v-model="editName" class="w-24 rounded-md border border-line bg-card-sunken px-2 py-0.5 text-[11px]" placeholder="名称" />
        <input
          v-model="editPrefix"
          class="min-w-0 flex-1 rounded-md border border-line bg-card-sunken px-2 py-0.5 font-mono text-[11px]"
          placeholder="https://example.com/ 或 https://example.com/{url}"
        />
        <button class="set-btn set-btn--primary" @click="saveEdit(p)">
          保存
        </button>
        <button class="set-btn set-btn--ghost" @click="cancelEdit()">取消</button>
      </template>
      <template v-else>
        <span class="w-24 shrink-0 truncate text-[11px] text-ink-2" :title="p.name">{{ p.name }}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" :title="p.prefix">
          {{ p.prefix }}
        </span>
        <span v-if="p.note" class="text-[10px] text-ink-3">{{ p.note }}</span>
        <button
          class="set-btn"
          :disabled="!!testingId"
          @click="testProxy(p)"
        >
          {{ testingId === p.id ? '测试中…' : '测试' }}
        </button>
        <span v-if="testMsg[p.id]" class="text-[10px] text-ink-3">{{ testMsg[p.id] }}</span>
        <button v-if="!p.builtin" class="set-btn set-btn--ghost" @click="startEdit(p)">
          编辑
        </button>
        <button
          v-if="!p.builtin"
          class="set-btn set-btn--ghost set-btn--danger"
          @click="removeProxy(p)"
        >
          删除
        </button>
        <button
          class="set-btn set-btn--ghost set-btn--icon"
          :disabled="i === 0"
          @click="move(i, -1)"
        >
          ↑
        </button>
        <button
          class="set-btn set-btn--ghost set-btn--icon"
          :disabled="i === accel.proxies.length - 1"
          @click="move(i, 1)"
        >
          ↓
        </button>
      </template>
    </div>

    <div class="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-field px-2.5 py-1.5">
      <input
        v-model="newName"
        class="w-28 rounded-md border border-line bg-card-sunken px-2 py-1 text-[11px]"
        placeholder="名称（可选）"
      />
      <input
        v-model="newPrefix"
        class="min-w-0 flex-1 rounded-md border border-line bg-card-sunken px-2 py-1 font-mono text-[11px]"
        placeholder="https://example.com/ 或 https://example.com/{url}"
      />
      <button class="set-btn set-btn--primary" @click="addCustom()">
        添加自定义
      </button>
      <button class="set-btn" @click="resetDefaults()">
        恢复默认
      </button>
      <span v-if="msg" class="text-[11px] text-accent">{{ msg }}</span>
    </div>
  </div>
</template>
