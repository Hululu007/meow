<script setup lang="ts">
/**
 * 添加 / 编辑片库：独立路由，而不是设置页里的内联表单。
 *
 * **为什么必须是路由**：TV 端只有 BACK 键，`tv-nav.js` 的焦点是几何最近邻。
 * 内联在设置长页里的话，用户打开表单后没有任何"退出去"的路径——
 * 影视仓那边也是把它做成弹框页（`请选择存盘类型`）而不是设置项内联。
 *
 * 添加与编辑共用这一页（`?edit=<id>` 进入编辑）：两者的字段、校验、测试连接
 * 完全相同，拆成两个组件只会让「改了一处忘了另一处」。编辑时跳过类型选择、
 * 直接进表单，密码框留空表示不修改。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CenterDialog from '@/components/common/CenterDialog.vue'
import { isDesktop } from '@/api'
import { fetchLibrary, saveLibrary, testLibrary, type LibraryInfo } from '@/api/library'

const route = useRoute()
const router = useRouter()

/** 存盘类型。本地目录与 Alist 本轮未实现，标为不可选而不是假装能用。 */
const TYPES = [
  { id: 'webdav', label: 'Webdav', hint: '群晖/威联通/Alist 自带的 WebDAV 接口' },
  { id: 'smb', label: 'SMB', hint: 'Windows 共享 / NAS 的 SMB 共享（smb://主机/共享名）' },
  { id: 'local', label: '本地目录', hint: '后端所在机器上的绝对路径' },
  {
    id: 'alist',
    label: 'Alist网页',
    disabled: true,
    // Alist 自带 WebDAV 接口，用 Webdav 类型填 http://主机:5244/dav 现在就能用。
    // 单独做一个"走 Alist JSON 接口"的类型没有额外收益，所以这里不实现，
    // 但提示要指对路——写"排到下版"会让人一直等一个不会来的功能。
    hint: '不需要单独的类型：Alist 自带 WebDAV，请选「Webdav」填 http://主机:5244/dav',
  },
]

const stage = ref<'pick' | 'form'>('pick')
const type = ref('webdav')
/** 编辑模式的库 id；空串 = 新增 */
const editId = ref('')
const form = ref<{
  name: string
  base: string
  root: string
  user: string
  pass: string
  domain: string
}>({
  name: '',
  base: '',
  root: '',
  user: '',
  pass: '',
  domain: '',
})
const busy = ref(false)
const msg = ref('')
const msgOk = ref(false)

const isEdit = computed(() => !!editId.value)

/** 地址框的占位示例：三种类型写法完全不同，给错了用户会照着填错 */
const basePlaceholder = computed(() => {
  if (type.value === 'smb') return 'smb://192.168.1.19/视频'
  if (type.value === 'local') return 'D:/影视  或  /mnt/media'
  return 'http://192.168.1.19:5005/'
})

/** 只有 SMB/WebDAV 需要账号；本地目录留空即可 */
const needsAuth = computed(() => type.value !== 'local')

// ------------------------------------------------- 「本地目录」的选目录
//
// 三种形态的"本地"含义不同，所以入口必须分开：
//   - PC：后端是应用内置 JVM，和用户同一台机器 → 系统文件夹选择器（路径可直接用）
//   - TV：后端是机内网关，同一台机器 → 内置目录浏览器（要真实路径，见下）
//   - Web/Docker：后端在容器里，本地路径是**容器内路径** → 只能手填

const onDesktop = isDesktop()

interface DirBridge {
  hasAllFiles?: () => boolean
  requestAllFiles?: () => boolean
  listDirs?: (path: string) => string
}

function tvDirBridge(): DirBridge | null {
  try {
    const b = (window as unknown as { meowTv?: DirBridge }).meowTv
    return b && typeof b.listDirs === 'function' ? b : null
  } catch {
    return null
  }
}
const canTvBrowse = !!tvDirBridge()

/**
 * TV 上是否已授予「所有文件访问权限」。
 *
 * 片库路径要交给后端（本机网关）用 java.io.File 读；SAF 给的是 content://
 * 树 URI，后端读不了，所以这里必须走"所有文件访问权限"拿真实路径。
 */
const tvAllFiles = ref(true)

function refreshAllFiles() {
  const b = tvDirBridge()
  tvAllFiles.value = b && typeof b.hasAllFiles === 'function' ? b.hasAllFiles() : true
}

function askAllFiles() {
  const b = tvDirBridge()
  if (!b || typeof b.requestAllFiles !== 'function') return
  b.requestAllFiles()
  // 权限页是异步返回的：回来后再查两次（用户可能在里面停留几秒）
  window.setTimeout(refreshAllFiles, 1200)
  window.setTimeout(refreshAllFiles, 4000)
}

/** PC：系统文件夹选择器（复用 Tauri dialog 插件，和「导入插件包」同一个入口） */
async function pickNativeDir() {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> }
    __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } }
  }
  const invoke = w.__TAURI_INTERNALS__?.invoke || w.__TAURI__?.core?.invoke
  if (!invoke) {
    msgOk.value = false
    msg.value = '这个环境没有系统文件选择器，请手动填路径'
    return
  }
  try {
    const r = (await invoke('plugin:dialog|open', {
      options: { directory: true, multiple: false, title: '选择片库目录' },
    })) as string | string[] | null
    const p = Array.isArray(r) ? r[0] : r
    if (p) {
      form.value.base = p
      msg.value = ''
    }
  } catch (e) {
    msgOk.value = false
    msg.value = e instanceof Error ? e.message : String(e)
  }
}

/** TV：内置目录浏览器状态 */
const pickerOpen = ref(false)
const pickerPath = ref('')
const pickerDirs = ref<Array<{ name: string; path: string }>>([])
/** 进入过的路径栈，用于「上一级」（比字符串截断可靠） */
const pickerStack = ref<string[]>([])

function loadDirs(path: string) {
  const b = tvDirBridge()
  if (!b || typeof b.listDirs !== 'function') return
  try {
    pickerDirs.value = JSON.parse(b.listDirs(path) || '[]') as Array<{ name: string; path: string }>
  } catch {
    pickerDirs.value = []
  }
  pickerPath.value = path
}

function openTvPicker() {
  refreshAllFiles()
  if (!tvAllFiles.value) {
    askAllFiles()
    return
  }
  pickerStack.value = []
  pickerOpen.value = true
  loadDirs('')
}

function enterDir(p: string) {
  pickerStack.value = [...pickerStack.value, pickerPath.value]
  loadDirs(p)
}

function upDir() {
  const st = [...pickerStack.value]
  const prev = st.pop()
  pickerStack.value = st
  loadDirs(prev || '')
}

function chooseDir() {
  if (!pickerPath.value) {
    msgOk.value = false
    msg.value = '先进入要作为片库的那个目录，再点「选中此目录」'
    return
  }
  form.value.base = pickerPath.value
  pickerOpen.value = false
  msg.value = ''
}

const canSave = computed(() => form.value.base.trim().length > 0)

function pick(id: string) {
  type.value = id
  stage.value = 'form'
}

async function test() {
  busy.value = true
  msg.value = ''
  try {
    const r = await testLibrary({
      id: 'probe',
      name: form.value.name,
      type: type.value,
      base: form.value.base,
      user: form.value.user,
      root: form.value.root,
      domain: form.value.domain,
      ...(form.value.pass ? { pass: form.value.pass } : {}),
    })
    msgOk.value = !!r.ok
    msg.value = r.ok ? `连接成功（根目录 ${r.entries ?? 0} 项）` : r.msg || '连接失败'
  } catch (e) {
    msgOk.value = false
    msg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function save() {
  if (!canSave.value) return
  busy.value = true
  msg.value = ''
  try {
    const cur = await fetchLibrary()
    const all = cur.libs || []
    // 编辑时保留原 id：id 变了后端会当成新增，旧条目还留在配置里
    const id = editId.value || 'lib' + Date.now().toString(36)
    const item: Partial<LibraryInfo> & { pass?: string } = {
      id,
      name: form.value.name || form.value.base,
      type: type.value,
      base: form.value.base,
      user: form.value.user,
      root: form.value.root,
      ...(form.value.domain ? { domain: form.value.domain } : {}),
    }
    // 密码留空 = 不改。后端只在本字段出现时覆盖，所以空串绝不能发出去。
    if (form.value.pass) item.pass = form.value.pass
    // 整表提交：编辑要把原条目替换掉，而不是再追加一条同 id 的
    const others = all.filter((x) => x.id !== id)
    await saveLibrary([...others, item])
    backToLibrary()
  } catch (e) {
    msgOk.value = false
    msg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

/**
 * 回片库页。
 *
 * <p>带上进来时的目录（`backLib` / `backPath`）—— 不带的话取消/保存会退回
 * 根层，用户以为"刷新了页面"（2026-11-05 用户报）。只有从根层进来时才不带。
 */
function backToLibrary() {
  const lib = String(route.query.backLib || '')
  const path = String(route.query.backPath || '')
  void router.replace({
    name: 'library',
    query: lib && path ? { lib, path } : undefined,
  })
}

function back() {
  // 编辑模式没有类型选择这一步，返回直接回片库页
  if (stage.value === 'form' && !isEdit.value) {
    stage.value = 'pick'
    return
  }
  backToLibrary()
}

/**
 * TV 返回键：与左上角「返回」按钮同一路径（2026-11-04）。
 *
 * <p>本页有 pick（选类型）/ form（填地址）两步，层级只存在 `stage` 这个 ref 里，
 * 路由历史没有这一层 —— 不注册钩子的话按返回会直接回片库，**跳过类型选择**，
 * 而页面上的「返回」按钮却能正确回到 pick。
 */
function handleTvBackHere(): boolean {
  if (stage.value === 'form' && !isEdit.value) {
    stage.value = 'pick'
    return true
  }
  return false
}

onMounted(async () => {
  ;(window as unknown as { __meowTvPageBack?: () => boolean }).__meowTvPageBack =
    handleTvBackHere
  // "所有文件访问权限"可能是在设置页里刚给的，进页面时先探一次
  refreshAllFiles()
  // App 的 watch(route.path) 早于本组件 onMounted，必须回头通知它重算接管者
  window.dispatchEvent(new Event('meow:tv-pageback'))
  // TV 的 BACK 键由壳翻译成 history.back()，这里保证有上一页可退
  if (window.history.length <= 1) backToLibrary()

  const id = String(route.query.edit || '')
  if (!id) return
  // 编辑：从后端取回该条（密码后端只回 hasPass，所以密码框必然为空）
  try {
    const cur = await fetchLibrary()
    const l = (cur.libs || []).find((x) => x.id === id)
    if (!l) {
      msgOk.value = false
      msg.value = '这个片库已经不在了，可能刚被删掉。'
      return
    }
    editId.value = l.id
    type.value = l.type || 'webdav'
    form.value = {
      name: l.name || '',
      base: l.base || '',
      root: l.root || '',
      user: l.user || '',
      pass: '',
      domain: l.domain || '',
    }
    stage.value = 'form'
  } catch (e) {
    msgOk.value = false
    msg.value = e instanceof Error ? e.message : String(e)
  }
})
onBeforeUnmount(() => {
  const w = window as unknown as { __meowTvPageBack?: () => boolean }
  if (w.__meowTvPageBack === handleTvBackHere) w.__meowTvPageBack = undefined
  window.dispatchEvent(new Event('meow:tv-pageback'))
})

</script>

<template>
  <div class="mx-auto w-full max-w-[40rem] px-4 py-5">
    <div class="mb-4 flex items-center gap-2">
      <button
        class="rounded-md bg-card px-3 py-1.5 text-xs transition hover:bg-card-hover"
        @click="back"
      >
        返回
      </button>
      <h1 class="text-lg font-medium">{{ isEdit ? '编辑片库' : '添加片库' }}</h1>
    </div>

    <CenterDialog
      v-if="stage === 'pick'"
      title="请选择存盘类型"
      :options="TYPES"
      @pick="pick"
      @close="back"
    />

    <div v-else class="space-y-3 rounded-xl border border-line bg-card p-4">
      <div class="text-xs text-ink-3">
        类型：<span class="text-ink-2">{{ type }}</span>
        <span v-if="isEdit" class="ml-2 text-ink-3">（编辑时不能改类型，换了类型请新建一个）</span>
      </div>

      <label class="block">
        <span class="text-xs text-ink-3">名称</span>
        <input
          v-model="form.name"
          placeholder="NAS 影视"
          class="mt-1 w-full rounded-md border border-line bg-field px-3 py-2 text-sm outline-none focus:border-accent/60"
        />
      </label>

      <label class="block">
        <span class="text-xs text-ink-3">地址</span>
        <input
          v-model="form.base"
          :placeholder="basePlaceholder"
          class="mt-1 w-full rounded-md border border-line bg-field px-3 py-2 font-mono text-sm outline-none focus:border-accent/60"
        />
      </label>

      <!-- 本地目录：PC 用系统文件夹选择器、TV 用内置目录浏览器 —— 这两端后端与
           用户同机，选出来的真实路径后端能直接读。Web/Docker 的后端在容器里，
           本地路径是**容器内路径**，只能手填，所以不给按钮。 -->
      <div v-if="type === 'local'" class="rounded-lg border border-line bg-field/40 px-3 py-2">
        <div class="flex flex-wrap items-center gap-2">
          <button
            v-if="onDesktop"
            class="rounded-md bg-card px-3 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink"
            @click="pickNativeDir"
          >
            选择文件夹…
          </button>
          <button
            v-if="canTvBrowse"
            class="rounded-md bg-card px-3 py-1.5 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink"
            @click="openTvPicker"
          >
            {{ tvAllFiles ? '浏览本机目录…' : '授予「所有文件访问权限」' }}
          </button>
          <span class="text-[length:var(--fs-mini)] text-ink-3">
            {{
              onDesktop || canTvBrowse
                ? '选完会自动填上面的地址；也可以手动粘路径'
                : '后端在容器/远端，这里要填它那台机器上的路径'
            }}
          </span>
        </div>
      </div>

      <label class="block">
        <span class="text-xs text-ink-3">根路径</span>
        <input
          v-model="form.root"
          placeholder="/视频（留空 = 地址根）"
          class="mt-1 w-full rounded-md border border-line bg-field px-3 py-2 font-mono text-sm outline-none focus:border-accent/60"
        />
      </label>

      <div v-if="needsAuth" class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="text-xs text-ink-3">用户名</span>
          <input
            v-model="form.user"
            class="mt-1 w-full rounded-md border border-line bg-field px-3 py-2 text-sm outline-none focus:border-accent/60"
          />
        </label>
        <label class="block">
          <span class="text-xs text-ink-3">密码</span>
          <input
            v-model="form.pass"
            type="password"
            :placeholder="isEdit ? '留空 = 不修改' : ''"
            class="mt-1 w-full rounded-md border border-line bg-field px-3 py-2 text-sm outline-none focus:border-accent/60"
          />
        </label>
      </div>

      <!-- 域只有 SMB 用得上：域账号填这里的 DOMAIN，用户名只写账号名 -->
      <label v-if="type === 'smb'" class="block">
        <span class="text-xs text-ink-3">域（可留空）</span>
        <input
          v-model="form.domain"
          placeholder="WORKGROUP"
          class="mt-1 w-full rounded-md border border-line bg-field px-3 py-2 text-sm outline-none focus:border-accent/60"
        />
      </label>

      <div class="flex items-center gap-2 pt-1">
        <button
          class="rounded-md bg-card px-4 py-2 text-sm transition hover:bg-card-hover disabled:opacity-50"
          :disabled="busy"
          @click="test"
        >
          测试连接
        </button>
        <button
          class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
          :disabled="busy || !canSave"
          @click="save"
        >
          保存
        </button>
      </div>

      <p v-if="msg" class="text-xs" :class="msgOk ? 'text-ok' : 'text-hot'">{{ msg }}</p>
      <p class="text-[11px] leading-relaxed text-ink-3">
        密码存在后端数据目录，不会显示回页面，也不会进 git。
      </p>
    </div>

    <!-- TV 内置目录浏览器：遥控器可达（按钮 + 「上一级」），不做成右侧抽屉。
         ★ 底色用 bg-elevated（实色），和 CenterDialog 一致：bg-card 在浅色主题
           只有 5.5% 不透明度，浮层底下的表单会透上来，看起来像"面板塌了一半"。
         z 也要和 CenterDialog 同档（z-[120]），否则会被导航/页头盖住。 -->
    <div
      v-if="pickerOpen"
      class="fixed inset-0 z-[120] grid place-items-center bg-black/55 px-5 py-8"
      @click.self="pickerOpen = false"
    >
      <div
        class="flex w-full max-w-[36rem] flex-col overflow-hidden rounded-xl border border-line bg-elevated shadow-2xl"
        style="max-height: 74vh"
      >
        <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <button
            data-tv-first
            class="rounded-md bg-field px-2.5 py-1 text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink"
            @click="upDir"
          >
            上一级
          </button>
          <div class="min-w-0 flex-1 truncate font-mono text-[length:var(--fs-mini)] text-ink-3">
            {{ pickerPath || '存储卷' }}
          </div>
          <button
            class="rounded-md bg-accent px-3 py-1 text-sm font-medium text-on-accent"
            @click="chooseDir"
          >
            选中此目录
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <button
            v-for="d in pickerDirs"
            :key="d.path"
            class="block min-h-9 w-full truncate rounded-md px-3 py-2 text-left text-sm text-ink-2 transition hover:bg-card-hover hover:text-ink"
            @click="enterDir(d.path)"
          >
            📁 {{ d.name }}
          </button>
          <p v-if="!pickerDirs.length" class="px-3 py-6 text-center text-xs text-ink-3">
            这个目录下没有子目录
          </p>
        </div>
        <div class="flex shrink-0 items-center justify-between border-t border-line px-3 py-2">
          <span class="text-[length:var(--fs-mini)] text-ink-3">
            共 {{ pickerDirs.length }} 项 · 进入目标目录后点右上「选中此目录」
          </span>
          <button class="rounded-md bg-field px-3 py-1 text-sm" @click="pickerOpen = false">
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>