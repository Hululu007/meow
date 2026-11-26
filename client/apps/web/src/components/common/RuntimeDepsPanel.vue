<script setup lang="ts">
/**
 * fnOS「运行时」区块：只展示 + 引导，不负责安装。
 *
 * <p>为什么只做展示：`install_dep_apps` 是 manifest 静态声明，装依赖时应用中心
 * 会一并装；但用户可能**后补**依赖（先装应用、发现 JS/PY 源不可用、再去应用中心），
 * 也可能是命令行安装（依赖没被自动处理）。这一区块解决的就是"到底缺什么"。
 *
 * <p>★ 不在这里做自动安装：应用中心的安装需要网关权限（5666），
 * 而本页可能从 30010 直连进来；跨端口 POST 会被 CORS/网关拦掉。
 * 所以只给包名 + 应用中心链接，安装动作交给用户。
 *
 * <p>三项的缺失后果不同，文案必须分开写：
 *   - java 缺失 → 影视后端不启动（整站不可用）
 *   - node 缺失 → 弹幕与 .js 源不可用
 *   - python 缺失 → .py 源不可用
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { rescanFpkDeps, shellInfo, type FpkDepInfo, type FpkDeps } from '@/api/fpkUpgrade'
import { isIosShell, isTvShell } from '@/compat/shell'
import { tvPyRuntime } from '@/api/nativeBridge'
import { fetchPolicy, request } from '@/api'

const visible = ref(false)
const loading = ref(false)
const error = ref('')
const deps = ref<FpkDeps | null>(null)
/** 'fpk' = 飞牛（java/node/python 三件套）；'tv' = TV 壳的 Python 模块；
 *  'ios' = IPA（端内 CPython + drpy）；null = 不显示 */
const mode = ref<'fpk' | 'tv' | 'ios' | null>(null)
/** TV 的 Python 模块状态（py-runtime.json） */
const pyState = ref<Record<string, unknown> | null>(null)
/** iOS：运行时地址 + 宿主探测结果（/api/health） */
const iosInfo = ref<{ url: string; js: string; py: string } | null>(null)

const iosKind = computed(() => {
  const u = iosInfo.value?.url || ''
  if (!u) return '未配置'
  if (u.includes('127.0.0.1:19331')) return '端内 CPython + drpy'
  if (u.includes('127.0.0.1:19330')) return '端内 Node（仅 JS）'
  return '远端运行时'
})
const iosJsOk = computed(() => iosInfo.value?.js === 'closed')
const iosPy = computed(() => iosInfo.value?.py || 'unknown')

let disposed = false

interface Row {
  key: 'java' | 'node' | 'python'
  title: string
  /** 应用中心里的依赖包名（用户照着搜） */
  pkg: string
  /** 缺失时的后果 */
  impact: string
  /** 该运行时服务哪些源 */
  serves: string
}

const ROWS: Row[] = [
  {
    key: 'java',
    title: 'Java',
    pkg: 'java-21-openjdk',
    impact: '缺失时影视后端不启动，整个应用不可用',
    serves: '后端本体',
  },
  {
    key: 'node',
    title: 'Node.js',
    pkg: 'nodejs_v22',
    impact: '缺失时弹幕与 .js 源不可用',
    serves: '弹幕 · JS 源',
  },
  {
    key: 'python',
    title: 'Python',
    pkg: 'python312',
    impact: '缺失时 .py 源不可用',
    serves: 'Python 源',
  },
]

const missing = computed(() => ROWS.filter((r) => !deps.value?.[r.key]?.ok))

/** 应用中心入口。fpk 页面在 30010，应用中心在 5666；协议跟当前页一致最稳。 */
const appCenterUrl = computed(() => {
  try {
    return `https://${location.hostname}:5666/`
  } catch {
    return ''
  }
})

function info(key: Row['key']): FpkDepInfo | undefined {
  return deps.value?.[key]
}

function shortPath(p?: string | null): string {
  if (!p) return ''
  // 只留最后三段：/var/apps/java-21-openjdk/target/bin/java → java-21-openjdk/target/bin/java
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 4 ? p : `…/${parts.slice(-4).join('/')}`
}

function sourceLabel(s?: string | null): string {
  if (!s) return ''
  if (s.startsWith('env:')) return '环境变量'
  if (s.startsWith('dep:')) return '同卷依赖'
  if (s.startsWith('varapp:')) return '/var/apps'
  if (s === 'path') return 'PATH'
  return s
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    // iOS：端内运行时 + 宿主探测（policy 给地址，/api/health 给健康/能力）
    if (isIosShell() && !isTvShell()) {
      mode.value = 'ios'
      const [p, h] = await Promise.all([
        fetchPolicy().catch(() => ({ jsRuntime: '' } as { jsRuntime?: string })),
        request<{ jsRuntimeBreaker?: string; jsRuntimePy?: string }>('/api/health', {
          timeout: 8000,
        }).catch(() => null),
      ])
      iosInfo.value = {
        url: String(p.jsRuntime || ''),
        js: String(h?.jsRuntimeBreaker || 'unknown'),
        py: String(h?.jsRuntimePy || 'unknown'),
      }
      return
    }
    // TV 壳：不查 meowd，直接读桥里的 Python 模块状态
    if (isTvShell()) {
      mode.value = 'tv'
      pyState.value = tvPyRuntime()
      // 桥在 WebView 注入完成前可能还没有这个方法；没拿到就再等一拍
      if (!pyState.value) {
        await new Promise((r) => setTimeout(r, 600))
        pyState.value = tvPyRuntime()
      }
      return
    }
    /*
     * ★ 不要求 capability === 'fpk'：运行时状态只依赖 meowd 的 /api/_shell/info
     * （它由 meowd 自己答，不需要飞牛网关）。网关只在"安装更新"时才必需 ——
     * 那是 FpkUpgradePanel 的事，不该牵连到这里。
     * 判据放错位置的后果：用户直接访问 http://<NAS>:30010/ 时这个区块整块消失，
     * 而 deps 明明拿得到。
     */
    const info = await shellInfo(true)
    if (disposed) return
    if (!info || !info.deps) {
      mode.value = null
      return
    }
    mode.value = 'fpk'
    deps.value = info.deps
    visible.value = true
  } catch (e) {
    error.value = (e as Error)?.message || '探测失败'
  } finally {
    loading.value = false
  }
}


async function rescan(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    if (mode.value === 'ios') {
      await refresh()
      return
    }
    if (mode.value === 'tv') {
      pyState.value = tvPyRuntime()
      return
    }
    deps.value = await rescanFpkDeps()
  } catch (e) {
    error.value = (e as Error)?.message || '重新检测失败'
  } finally {
    loading.value = false
  }
}

function copyMissing(): void {
  const names = missing.value.map((r) => r.pkg).join(' ')
  void navigator.clipboard?.writeText(names)
}

onMounted(() => {
  void refresh()
})
onBeforeUnmount(() => {
  disposed = true
})
</script>

<template>
  <!-- ── iOS：端内运行时（drpy + CPython），状态与能力引导 ── -->
  <template v-if="mode === 'ios' && iosInfo">
    <div class="set-sub mt-3 border-t border-line pt-3" data-runtime-deps>
      <span class="font-medium text-ink-2">运行时</span>
      <span class="text-[length:var(--fs-mini)] text-ink-3">
        {{ iosKind }}
      </span>
      <span class="flex-1" />
      <button
        class="rounded-md bg-card px-2.5 py-1 text-[length:var(--fs-mini)] hover:bg-card-hover"
        :disabled="loading"
        @click="rescan()"
      >
        {{ loading ? '检测中…' : '重新检测' }}
      </button>
    </div>
    <div class="pb-3 text-[length:var(--fs-xs)]" data-runtime-deps>
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              :class="iosJsOk ? 'bg-ok' : 'bg-hot'" />
        <span class="font-medium text-ink">Node（drpy）</span>
        <span :class="iosJsOk ? 'text-ok' : 'text-hot'">
          {{ iosInfo.js === 'closed' ? '可用' : iosInfo.js === 'open' ? '不可用（熔断）' : '未知' }}
        </span>
        <span class="text-ink-3/70">· 弹幕 · .js 源</span>
      </div>
      <p class="ml-3.5 mt-0.5 text-[length:var(--fs-mini)] text-ink-3">
        端内 nodejs-mobile（V8 关闭 JIT）；地址
        <code class="select-all">{{ iosInfo.url || '未配置' }}</code>
      </p>

      <div class="mt-2 flex flex-wrap items-baseline gap-x-2">
        <span class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              :class="iosPy === 'yes' ? 'bg-ok' : iosPy === 'no' ? 'bg-hot' : 'bg-white/30'" />
        <span class="font-medium text-ink">CPython 3.12</span>
        <span :class="iosPy === 'yes' ? 'text-ok' : iosPy === 'no' ? 'text-hot' : 'text-ink-3'">
          {{ iosPy === 'yes' ? '可用' : iosPy === 'no' ? '不可用' : '未知（首次调用 .py 源后探测）' }}
        </span>
        <span class="text-ink-3/70">· .py 源</span>
      </div>
      <p class="ml-3.5 mt-0.5 text-[length:var(--fs-mini)] text-ink-3">
        端内裁剪版：含 requests/bs4 与 AES-ECB/CBC；<span class="text-hot">不含 lxml/pyquery</span>，
        复杂加解密模式也不含。
      </p>

      <div class="mt-2 rounded-md bg-white/5 px-2.5 py-2 text-[length:var(--fs-mini)] text-ink-3">
        需要 lxml/pyquery 或完整 pycryptodome 时：在「JS 运行时」填局域网 pyrt 地址
        （如 <code class="select-all">http://192.168.1.x:19331</code>）保存后回来重新检测；
        端内运行时会让位给远端，`.js/.py` 都走那台机器。
      </div>
    </div>
  </template>

  <!-- ── TV：Python 运行时模块 ── -->
  <template v-if="mode === 'tv' && pyState">
    <div class="set-sub mt-3 border-t border-line pt-3" data-runtime-deps>
      <span class="font-medium text-ink-2">运行时模块</span>
      <span class="text-[length:var(--fs-mini)] text-ink-3">
        <template v-if="pyState.running">Python 运行中 · 端口 {{ pyState.port }}</template>
        <template v-else-if="pyState.error">{{ pyState.error }}</template>
        <template v-else>Python 未运行</template>
      </span>
      <span class="flex-1" />
      <button
        class="rounded-md bg-card px-2.5 py-1 text-[length:var(--fs-mini)] hover:bg-card-hover"
        :disabled="loading"
        @click="rescan()"
      >
        {{ loading ? '检测中…' : '重新检测' }}
      </button>
    </div>
    <div class="pb-3 text-[length:var(--fs-xs)]">
      <p class="text-ink-3">
        Python 模块 v{{ pyState.version || '?' }}：
        <span :class="pyState.running ? 'text-ok' : 'text-hot'">
          {{ pyState.running ? '已就绪，.py 源可在本机执行' : '未就绪，.py 源需连远端 pyrt 或安装模块' }}
        </span>
      </p>
      <p class="mt-1 text-[length:var(--fs-mini)] text-ink-3/70">
        `.js` 由内置 QuickJS 执行；`.py` 由这个模块执行（没装则整类源不可用）。
      </p>
    </div>
  </template>

  <div v-if="mode === 'fpk'" class="set-sub mt-3 border-t border-line pt-3" data-runtime-deps>
    <span class="font-medium text-ink-2">运行时</span>
    <span class="text-[length:var(--fs-mini)] text-ink-3">
      <template v-if="loading">检测中…</template>
      <template v-else-if="missing.length">{{ missing.length }} 项未安装</template>
      <template v-else>全部就绪</template>
    </span>
    <span class="flex-1" />
    <button
      class="rounded-md bg-card px-2.5 py-1 text-[length:var(--fs-mini)] hover:bg-card-hover"
      :disabled="loading"
      @click="rescan()"
    >
      {{ loading ? '检测中…' : '重新检测' }}
    </button>
  </div>

  <div v-if="mode === 'fpk'" class="pb-3 text-[length:var(--fs-xs)]">
    <p v-if="error" class="text-hot">{{ error }}</p>

    <div v-for="row in ROWS" :key="row.key" class="mt-2 first:mt-0">
      <div class="flex flex-wrap items-baseline gap-x-2">
        <span
          class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          :class="info(row.key)?.ok ? 'bg-ok' : 'bg-hot'"
        />
        <span class="font-medium text-ink">{{ row.title }}</span>
        <span v-if="info(row.key)?.ok" class="text-ink-3">
          v{{ info(row.key)?.version || '?' }}
        </span>
        <span v-else class="text-hot">未安装</span>
        <span class="text-ink-3/70">· {{ row.serves }}</span>
      </div>

      <p v-if="info(row.key)?.ok" class="ml-3.5 mt-0.5 text-[length:var(--fs-mini)] text-ink-3">
        <code class="select-all">{{ shortPath(info(row.key)?.path) }}</code>
        <span v-if="sourceLabel(info(row.key)?.source)" class="ml-1 opacity-70">
          （{{ sourceLabel(info(row.key)?.source) }}）
        </span>
      </p>
      <p v-else class="ml-3.5 mt-0.5 text-[length:var(--fs-mini)] text-ink-3">
        {{ row.impact }}。到应用中心安装
        <code class="select-all text-accent">{{ row.pkg }}</code>
        后回来点「重新检测」。
      </p>
    </div>

    <div
      v-if="missing.length"
      class="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2"
    >
      <a
        v-if="appCenterUrl"
        :href="appCenterUrl"
        target="_blank"
        rel="noopener"
        class="rounded-md bg-accent px-2.5 py-1 text-[length:var(--fs-mini)] font-medium text-on-accent hover:bg-accent-dim"
      >
        打开应用中心
      </a>
      <button
        class="rounded-md bg-card px-2.5 py-1 text-[length:var(--fs-mini)] hover:bg-card-hover"
        @click="copyMissing()"
      >
        复制缺失的包名
      </button>
      <span class="text-[length:var(--fs-mini)] text-ink-3/70">
        装完不用重启应用，点「重新检测」即可
      </span>
    </div>
  </div>
</template>
