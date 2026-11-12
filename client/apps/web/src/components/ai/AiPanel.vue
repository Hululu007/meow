<script setup lang="ts">
/**
 * AI 对话面板：悬浮按钮 + 半屏面板。
 *
 * 设计见 docs/47 §三。几条硬约束（都来自实测）：
 *
 * 1. **主入口不是这里**，是播放错误页（§2.7）。这个按钮解决的是
 *    "没有现成错误页，但用户有话想问"——所以它必须比错误页更轻。
 * 2. **播放页隐藏 FAB**：那里已有四块浮层（选集/线路/弹幕/更多）在抢位，
 *    再放一个只会互相遮挡。Ctrl+K 仍然可用。
 * 3. **z-index 必须是 60**：高于顶栏 z-30 与播放器面板 z-40，低于伪全屏
 *    z-[100] 和居中弹窗 z-[120]。
 * 4. **"播放"必须留一次点击**：全屏与自动播放都要用户激活；而且 AI 猜错
 *    时补救成本为零（看到片名不对，不点就是了）。
 * 5. **第三方字符串一律纯文本**：片名/源名来自站点，禁止 v-html（§3.5）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  meowCacheStart,
  meowDiagnose,
  meowLogs,
  meowPlay,
  meowSearch,
  type CachePlan,
  type SearchHit,
} from '@/ai/tools'
import {
  COMMANDS,
  completeCommand,
  matchCommands,
  parseCommand,
  parseLogsArg,
  toolLabel,
  type CommandSpec,
  type ParsedCommand,
} from '@/ai/commands'
import { CAUSE_LABEL } from '@/ai/diagnose'
import { llmConfig, llmReady } from '@/ai/llm'
import { MAX_ROUNDS, orchestrate } from '@/ai/orchestrate'
import { classifyIntent, extractTitle } from '@/ai/intent'
import PosterImage from '@/components/common/PosterImage.vue'
import { startBatchCache } from '@/api/library'
import { useAppStore } from '@/stores/app'

const props = defineProps<{
  /** 伪全屏时一并隐藏（直播页有伪全屏，z-50 低于本组件） */
  hidden?: boolean
  /**
   * 内联模式：作为**页面主体**渲染（AI 助手独立页），而不是右下角浮层。
   *
   * 为什么需要：TV 上这个面板只有 34rem 宽、74vh 高，对话区实际只剩
   * ~400px，一轮长回答就要来回滚，而遥控器滚动又慢。独立页占满整屏，
   * 按钮也放得开（TV 上要靠方向键一个个走）。
   */
  inline?: boolean
}>()

const route = useRoute()
const router = useRouter()
const store = useAppStore()

const open = ref(false)
const q = ref('')
const busy = ref(false)
/** 过程提示：搜索跨多个源要几秒，没有进度就是"点了没反应" */
const step = ref('')
const errMsg = ref('')
/** 当前这轮命中的影片（只属于最后一条 AI 消息） */
const hits = ref<SearchHit[]>([])
/** 编排过程中的工具调用轨迹（一行一个工具名） */
const trace = ref<string[]>([])
const input = ref<HTMLInputElement>()

// ---------------------------------------------------------------- 斜杠命令
//
// 输入 `/` 弹出候选（见 ai/commands.ts）。交互对齐主流 AI 工具：
// 上下键移动、Enter/Tab 补全、Esc 关掉；无参数命令选中即执行。
//
// ★ 命令不替代自然语言：解析失败（不是命令/命令名不认识）一律回落原路径，
//   intent 分类与多轮编排的行为完全不变。

/** 当前候选列表（`/` 开头且还没开始填参数时非空） */
const cmdList = ref<CommandSpec[]>([])
/** 高亮项 */
const cmdIndex = ref(0)
const cmdOpen = computed(() => cmdList.value.length > 0)

/**
 * 输入框内容变化 → 重算候选。
 *
 * ★ 取 `e.target.value` 而不是 `q.value`：`v-model` 在原生 input 上是
 *   运行时指令（mounted 时才 addEventListener），而 `@input` 是编译期 props，
 *   **props 先触发** —— 此时 `q.value` 还是上一轮的值，用它过滤会慢一个字符。
 */
function onInput(e?: Event) {
  const target = e?.target as HTMLInputElement | undefined
  const value = target && typeof target.value === 'string' ? target.value : q.value
  cmdList.value = matchCommands(value)
  cmdIndex.value = 0
}

/**
 * 选中候选：补全文本，把光标放回参数位。
 *
 * 无参数命令（`/诊断`）直接提交 —— 用户打出 `/诊断` 或从列表里点它，
 * 想要的就是"执行"，再让他按一次回车是多出来的一步。
 */
async function pickCommand(spec: CommandSpec) {
  q.value = completeCommand(spec)
  cmdList.value = []
  await nextTick()
  // 同样走 tv-nav：列表 DOM 消失会触发它的 scope-closed 焦点恢复，
  // 不钉住的话焦点刚给输入框就被搬回别处
  focusViaTvNav(input.value, true)
  if (!spec.argHint) void submit()
}

/** 候选列表容器（点 `/` 后把焦点交给首项，遥控器方向键才能走） */
const cmdListEl = ref<HTMLElement>()

/**
 * 把焦点交给 tv-nav 状态机（TV），或退回原生 focus()（桌面浏览器）。
 *
 * ★ 为什么不能只调 focus()：tv-nav 对 OK 键只 `tgt.click()`，**不转移 DOM 焦点**，
 *   而且方向键从它内部记录的位置出发 —— programmatic focus() 之后它的焦点框
 *   仍画在旧元素上、下一次按键也从旧位置找（2026-11-11 实测：列表打开后
 *   焦点框留在 `/` 按钮，按「上」从按钮几何出发进了列表**尾部**）。
 *   `__meowTvFocus(el, pin)` 会更新它的状态机并画框；pin 置位防 initialFocus 抢走。
 */
function focusViaTvNav(el: HTMLElement | null | undefined, pin: boolean): void {
  if (!el) return
  const w = window as unknown as { __meowTvFocus?: (t: HTMLElement | string, pin?: boolean) => boolean }
  if (typeof w.__meowTvFocus === 'function') w.__meowTvFocus(el, pin)
  else el.focus()
}

/** `/` 按钮：插入斜杠并展开候选（TV 遥控器打不出 `/`，这是唯一可达入口） */
async function openCommands() {
  q.value = '/'
  onInput()
  await nextTick()
  // 焦点给列表首项，**不是**输入框：输入框带 `data-tv-native-input`，
  // 上下键会被原生框吞掉（光标/IME 行为），列表就永远选不动。
  focusViaTvNav(cmdListEl.value?.querySelector<HTMLButtonElement>('button'), true)
}

/**
 * 输入框内的键盘：**只在候选打开时接管**上下/Enter/Tab/Esc。
 *
 * ★ 不能把这段并进 document 级 onKeydown：那里处理 Ctrl+K / Esc，
 *   而候选列表的上下键只在输入框有焦点时该生效。
 */
function onInputKeydown(e: KeyboardEvent) {
  if (!cmdOpen.value) return
  const n = cmdList.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    cmdIndex.value = (cmdIndex.value + 1) % n
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    cmdIndex.value = (cmdIndex.value - 1 + n) % n
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    // 只关列表，不能让 document 上的 Esc 顺手把整个面板也关掉
    e.stopPropagation()
    cmdList.value = []
    return
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    const cur = cmdList.value[cmdIndex.value]
    if (!cur) return
    e.preventDefault()
    // 已经完全打出无参数命令 → Enter 是"执行"而不是"补全"
    if (e.key === 'Enter' && !cur.argHint && q.value.trim() === `/${cur.name}`) {
      cmdList.value = []
      void submit()
      return
    }
    void pickCommand(cur)
  }
}

/*
 * 对话状态放在模块级单例（stores/aiChat），**不是组件内 ref**。
 *
 * 踩过（2026-11-03 用户反馈「面板点全屏后历史会话丢了」）：浮层是
 * App.vue 里的一个 AiPanel 实例、独立页是 AiView.vue 里的另一个实例，
 * 组件内 ref 各自一份 —— 点「全屏」只是路由跳转，新实例从空对话开始。
 * 提到模块级之后两个界面共享同一份 msgs，视觉上就是同一个会话换了个壳。
 */
import type { ChatMsg } from '@/stores/aiChat'
import {
  aiMsgs as msgs,
  aiCacheBusy as cacheBusy,
  aiCacheDone as cacheDone,
  pushAiMsg,
  patchAiMsg,
  clearAiMsgs,
} from '@/stores/aiChat'

const listEl = ref<HTMLElement>()

function pushMsg(m: Omit<import('@/stores/aiChat').ChatMsg, 'id'>): number {
  return pushAiMsg(m)
}

function patchMsg(id: number, patch: Partial<import('@/stores/aiChat').ChatMsg>) {
  patchAiMsg(id, patch)
}


/** 滚到底：新消息追加后必须能看见，否则等于没显示 */
async function scrollToBottom() {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// ---------------------------------------------------------------- 缓存确认
//
// 模型只提议、用户点确认才下载（写操作不由 AI 自主决定，见 tools.ts）。
// 计划里的直链在提议时已经解析好了，这里直接入队，不再重新解析一遍。

async function confirmCache(m: ChatMsg) {
  const plan = m.cachePlan
  if (!plan || cacheBusy.value !== null) return
  cacheBusy.value = m.id
  try {
    const r = await startBatchCache({
      site: plan.site,
      vodId: plan.vodId,
      items: plan.items,
    })
    if (!r.ok) {
      cacheDone.value = { ...cacheDone.value, [m.id]: r.msg || '开始下载失败' }
      return
    }
    const skipped = (r.skipped || []).length
    cacheDone.value = {
      ...cacheDone.value,
      [m.id]: `已开始下载 ${r.count} 集${skipped ? `（${skipped} 集跳过）` : ''}。可以在「片库 → 我的缓存」看进度。`,
    }
    // 计划已执行，卡片收掉，避免重复点
    patchMsg(m.id, { cachePlan: undefined })
  } catch (e) {
    cacheDone.value = {
      ...cacheDone.value,
      [m.id]: e instanceof Error ? e.message : String(e),
    }
  } finally {
    cacheBusy.value = null
  }
}

/** 用户不要了：把卡片收掉即可，什么都没下 */
function dismissCache(m: ChatMsg) {
  patchMsg(m.id, { cachePlan: undefined })
}

/** 喂给模型的历史：只取成功完成的 AI 回答，失败/规则路径的不算 */
function historyForModel(): Array<{ role: 'user' | 'assistant'; content: string }> {
  // 轮数统一由 llmConfig 提供（它负责读 prefs 与兜底默认值），这里不重复解析
  const rounds = Math.max(0, Math.min(10, llmConfig().historyRounds))
  if (!rounds) return []
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of msgs.value) {
    // 只带"有实质回答"的轮次：失败轮和纯卡片轮带进去会污染上下文
    if (m.role === 'user') out.push({ role: 'user', content: m.text })
    else if (m.text) out.push({ role: 'assistant', content: m.text })
  }
  // 按"轮"截断：每轮 2 条，取最近 N 轮
  return out.slice(-(rounds * 2))
}

/** 上一轮 AI 消息里带过的影片（= 已确认过的片） */
function lastConfirmedHits(): SearchHit[] {
  for (let i = msgs.value.length - 1; i >= 0; i--) {
    const m = msgs.value[i]
    if (m.role === 'ai' && m.hits?.length) return m.hits
  }
  return []
}

/**
 * 已等待秒数。
 *
 * 为什么要有：模型单次超时提到 25 秒后，「正在分析…」可能静止十几秒。
 * 没有数字用户会以为卡死；有秒数至少知道还在跑。
 */
const elapsedSec = ref(0)
let elapsedTimer: number | undefined

function startElapsed() {
  stopElapsed()
  const t0 = Date.now()
  elapsedSec.value = 0
  elapsedTimer = window.setInterval(() => {
    elapsedSec.value = Math.floor((Date.now() - t0) / 1000)
  }, 1000)
}

function stopElapsed() {
  if (elapsedTimer !== undefined) {
    clearInterval(elapsedTimer)
    elapsedTimer = undefined
  }
  elapsedSec.value = 0
}

/** 播放页不显示（有错误页集成 + 四块浮层）；直播页同为满屏播放器，也不显示 */
const isPlay = computed(() => route.name === 'play')
const isLive = computed(() => route.name === 'live')
const visible = computed(() => !props.hidden && !isPlay.value && !isLive.value)

async function show() {
  open.value = true
  await nextTick()
  input.value?.focus()
}

function hide() {
  // 独立页没有"收起"概念：这里必须早退，否则点「详情」跳走后
  // 回到 /ai 会看到一个被 hide() 关掉、什么都点不出来的空壳。
  if (props.inline) return
  open.value = false
  // 浮层带 data-tv-scope，关掉时把焦点还给打开它的按钮（悬空会让遥控器失灵一次）
  const w = window as unknown as { __meowTvScopeClosed?: () => boolean }
  if (typeof w.__meowTvScopeClosed === 'function') w.__meowTvScopeClosed()
  errMsg.value = ''
  step.value = ''
  trace.value = []
  // 关掉面板时把候选收掉：否则重新打开会看到上次遗留的列表 + 输入框里的 "/"
  cmdList.value = []
}

/** 清空对话：浮层和独立页都要有，否则长会话只能靠刷新页面 */
function clearChat() {
  clearAiMsgs()
  hits.value = []
  trace.value = []
  errMsg.value = ''
  step.value = ''
}

function onKeydown(e: KeyboardEvent) {
  // 独立页里 Esc/Ctrl+K 不该有任何作用：它已经是页面主体，
  // "收起来"没有落点，误按只会让人以为页面挂了。
  if (props.inline) return
  // Ctrl/Cmd+K：通用搜索约定。不用单键——播放器已占 f/d/Esc。
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    if (open.value) hide()
    else void show()
    return
  }
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    hide()
  }
}

/**
 * 规则路径：把已解析的播放意图串行执行完。
 *
 * 全程不碰模型，所以是确定性的：搜索 → 取第一条能播的来源 → meowPlay（自带换线）。
 * 返回 true 表示已给出结果（无论成败），调用方不该再走模型；
 * 返回 false 表示"没找到片"，交给模型再试（它可能能联想到别名）。
 *
 * ★ 只在**唯一片名**时自动选定来源。真正要防的是「庆余年」vs「庆余年 第二季」
 *   这类同名片 —— 猜错片的代价比多点一次大得多（§3.6）。
 *
 * ★ 判据用「不同片名数」而不是结果条数（2026-11-11 实测改）。
 *   `SearchHit` 的粒度是「源 + 片名 + id」：同一部片在 6 个源里就是 6 条**同名**结果。
 *   原来按条数判，`/播放 庆余年 第3集` 会报"找到 6 部"并列出 6 张一模一样的卡片，
 *   点哪张都到同一个详情页 —— 命令的确定性反而被这层假选择抵消了。
 */
async function runPlayIntent(intent: { title: string; episode?: string }, msgId: number): Promise<boolean> {
  step.value = `正在搜索「${intent.title}」…`
  const s = await meowSearch(intent.title, { limit: 6 })
  if (!s.ok || !s.data?.length) return false // 交给模型

  // 精确同名优先，其次包含
  const exact = s.data.filter((h) => h.name === intent.title || h.name.replace(/\s/g, '') === intent.title.replace(/\s/g, ''))
  const pool = exact.length ? exact : s.data

  const withSrc = pool.filter((h) => h.sources?.length)
  // 不同片名才算"多部"（同名多源是同一部片）
  const editions = new Set(pool.map((h) => h.name.replace(/\s/g, '')))
  if (editions.size > 1 || !withSrc.length) {
    step.value = ''
    hits.value = pool
    patchMsg(msgId, {
      text:
        editions.size > 1
          ? `找到 ${editions.size} 个不同版本，把片名写全再试（例如「${pool[0]?.name || intent.title}」）。`
          : '没找到可播放的来源。',
      hits: pool,
    })
    return true
  }

  const hit = withSrc[0]
  /*
   * 把同名多源的 sources 合并到一张卡片上（6 条同名结果各自只有 1 个源）。
   * 卡片本来就支持多源 chips（`sourceCount(h) > 1`），合并后用户能直接换源，
   * 而不是看着 6 张一模一样的卡片。
   */
  const merged: SearchHit = { ...hit, sources: pool.flatMap((h) => h.sources || []) }
  hits.value = [merged]

  step.value = `正在取「${hit.name}」第 ${intent.episode || 1} 集…`
  const p = await meowPlay({
    site: hit.sources[0].site,
    vod_id: hit.sources[0].vod_id,
    episode: intent.episode,
  })
  step.value = ''

  if (p.ok && p.data) {
    patchMsg(msgId, {
      text: `已取到《${hit.name}》${p.data.episode} 的可播地址，线路「${p.data.line}」。点「详情」进去播放。`,
      hits: [merged],
      trace: ['搜索', '取播放地址'],
    })
  } else {
    patchMsg(msgId, {
      text: '',
      hits: [merged],
      error: `没取到可播地址：${p.error || '未知原因'}`,
    })
  }
  return true
}

/**
 * 执行一条斜杠命令。
 *
 * 每条命令都是**已有工具的薄组合**（tools.ts 是唯一真源），区别只在于
 * 跳过意图分类与模型编排 —— 所以确定性、零 token、没配模型也能跑。
 *
 * 三条纪律沿用编排层的：
 *   · 写操作（缓存）只准备计划，必须用户点确认；
 *   · 多部同名片一律列卡片让用户选，不猜（猜错片的代价比多点一次大）；
 *   · 失败必须给可操作的下一步，不能只报"失败"。
 */
async function runCommand(cmd: ParsedCommand, msgId: number): Promise<void> {
  const { spec, arg } = cmd

  // ---------------------------------------------------------------- 搜索
  if (spec.name === '搜索') {
    if (!arg) {
      patchMsg(msgId, { text: '', error: '用法：/搜索 片名（例如 /搜索 庆余年）' })
      return
    }
    step.value = `正在搜索「${arg}」…`
    const r = await meowSearch(arg, { limit: 6 })
    step.value = ''
    if (r.ok && r.data?.length) {
      hits.value = r.data
      patchMsg(msgId, {
        text: `「${arg}」命中 ${r.data.length} 部。点「详情」进去看，或 /播放 ${arg} 直接取地址。`,
        hits: r.data,
        trace: ['搜索'],
      })
    } else {
      patchMsg(msgId, {
        text: '',
        error: r.error || `没搜到「${arg}」。换个写法试试，或在「源」里看看哪些源降级了。`,
        trace: ['搜索'],
      })
    }
    return
  }

  // ---------------------------------------------------------------- 播放
  if (spec.name === '播放') {
    // 不带片名 → 用上一轮确认过的那部（和「那就放它吧」同一语义）
    if (!arg) {
      const pick = lastConfirmedHits().find((h) => h.sources?.length)
      if (!pick) {
        patchMsg(msgId, { text: '要播哪部？写成「/播放 片名 第N集」，或先 /搜索 一下。' })
        return
      }
      step.value = `正在取「${pick.name}」…`
      const p = await meowPlay({
        site: pick.sources[0].site,
        vod_id: pick.sources[0].vod_id,
      })
      step.value = ''
      patchMsg(msgId, {
        text:
          p.ok && p.data
            ? `已取到《${pick.name}》${p.data.episode} 的可播地址，线路「${p.data.line}」。点「详情」进去播放。`
            : '',
        hits: lastConfirmedHits(),
        error: p.ok ? undefined : `没取到可播地址：${p.error || '未知原因'}`,
        trace: ['取播放地址'],
      })
      return
    }
    const t = extractTitle(arg)
    if (!t) {
      patchMsg(msgId, {
        text: '',
        error: `「${arg}」不像片名。写法：/播放 片名 第N集（集数可省略）`,
      })
      return
    }
    const done = await runPlayIntent({ title: t.title, episode: t.episode }, msgId)
    // runPlayIntent 返回 false = 规则路径没搜到片；命令语义下不能静默落到模型，
    // 因为用户明确指定了命令，这里必须给结论
    if (!done) {
      patchMsg(msgId, {
        text: '',
        error: `没搜到《${t.title}》。先 /搜索 ${t.title} 看看有没有，或换个写法。`,
        trace: ['搜索'],
      })
    }
    return
  }

  // ---------------------------------------------------------------- 缓存
  if (spec.name === '缓存') {
    let site = ''
    let vodId = ''
    let episode: string | undefined

    if (arg) {
      const t = extractTitle(arg)
      if (!t) {
        patchMsg(msgId, { text: '', error: `「${arg}」不像片名。写法：/缓存 片名 第N集` })
        return
      }
      episode = t.episode
      step.value = `正在查「${t.title}」…`
      const s = await meowSearch(t.title, { limit: 6 })
      step.value = ''
      if (!s.ok || !s.data?.length) {
        patchMsg(msgId, { text: '', error: s.error || `没搜到《${t.title}》。`, trace: ['搜索'] })
        return
      }
      const exact = s.data.filter(
        (h) => h.name === t.title || h.name.replace(/\s/g, '') === t.title.replace(/\s/g, ''),
      )
      const pool = exact.length ? exact : s.data
      hits.value = pool
      const withSrc = pool.filter((h) => h.sources?.length)
      // 判据同 runPlayIntent：不同片名才算"多部"，同名多源是同一部片（取第一个源即可）。
      // 猜错版次就得白下一整季，所以真的多版本时仍然停下来让用户写全片名。
      const editions = new Set(pool.map((h) => h.name.replace(/\s/g, '')))
      if (editions.size > 1 || !withSrc.length) {
        patchMsg(msgId, {
          text:
            editions.size > 1
              ? `找到 ${editions.size} 个不同版本，把片名写全再试（例如 /缓存 ${pool[0]?.name || t.title}）。`
              : '这些结果都没有可用的播放源，无法缓存。',
          hits: pool,
          trace: ['搜索'],
        })
        return
      }
      site = withSrc[0].sources[0].site
      vodId = withSrc[0].sources[0].vod_id
    } else {
      // 没带片名：用上一轮唯一确认过的那部
      const confirmed = lastConfirmedHits()
      const pick = confirmed.find((h) => h.sources?.length)
      if (!pick) {
        patchMsg(msgId, { text: '要缓存哪部？写成「/缓存 片名」，或先在搜索结果里选一部。' })
        return
      }
      hits.value = confirmed
      site = pick.sources[0].site
      vodId = pick.sources[0].vod_id
    }

    step.value = '正在解析可下载直链…'
    const plan = await meowCacheStart({
      site,
      vod_id: vodId,
      ...(episode ? { episodes: [episode] } : {}),
    })
    step.value = ''
    if (plan.ok && plan.data) {
      patchMsg(msgId, {
        // 只提议、不下载：真正的入队由用户点确认卡触发（见 confirmCache）
        text: `《${plan.data.name}》共 ${plan.data.items.length} 集${plan.data.skipped ? `（${plan.data.skipped} 集拿不到直链已跳过）` : ''}，确认后开始下载。`,
        cachePlan: plan.data,
        trace: ['缓存'],
      })
    } else {
      patchMsg(msgId, {
        text: '',
        error: plan.error || '解析失败：这条线路拿不到可下载的直链。',
        trace: ['缓存'],
      })
    }
    return
  }

  // ---------------------------------------------------------------- 诊断
  if (spec.name === '诊断') {
    step.value = '正在收集本地证据…'
    const r = await meowDiagnose()
    step.value = ''
    if (!r.ok || !r.data) {
      patchMsg(msgId, { text: '', error: r.error || '诊断失败：收集不到播放器状态。' })
      return
    }
    const d = r.data
    const conf: Record<string, string> = { high: '高', medium: '中', low: '低' }
    // 没命中必须说"没命中"，不能说"未知问题"——两者上报价值完全不同（见 diagnose.ts）。
    // 命中时拼 code 与建议；没命中时 suggestion.text 本身就是结论，不要再套一层前缀
    // （否则会出现「没发现已知故障特征。未发现已知故障特征」）。
    const text = d.cause
      ? `${CAUSE_LABEL[d.cause.code] || d.cause.code}（把握${conf[d.cause.confidence] || ''}）：${d.suggestion.text}`
      : d.suggestion.text
    patchMsg(msgId, { text, trace: ['诊断'] })
    return
  }

  // ---------------------------------------------------------------- 日志
  if (spec.name === '日志') {
    const args = parseLogsArg(arg)
    step.value = '正在读后端日志…'
    const r = await meowLogs(args)
    step.value = ''
    if (!r.ok || !r.data) {
      patchMsg(msgId, { text: '', error: r.error || '读不到日志。', trace: ['日志'] })
      return
    }
    const { items, matched, scanned, availableTags } = r.data
    if (!items.length) {
      patchMsg(msgId, {
        text: `没有匹配的日志（扫描 ${scanned} 条）。可用模块：${availableTags?.join('、') || '无'}。`,
        trace: ['日志'],
      })
      return
    }
    // 只贴最近几条：完整列表在「运行日志」页，聊天区贴 500 行没人看得下去
    const lines = items
      .slice(-5)
      .map((e) => `[${e.level}] ${e.tag ? `${e.tag} · ` : ''}${e.text.slice(0, 100)}`)
    patchMsg(msgId, {
      text: `${items.length} 条（匹配 ${matched} / 扫描 ${scanned}）\n${lines.join('\n')}`,
      trace: ['日志'],
    })
    return
  }
}

async function submit() {
  const text = q.value.trim().slice(0, 100)
  if (!text || busy.value) return
  // 立刻清空输入框：用户能马上接着问下一句，也让"已发送"有可见反馈。
  // 放在 busy 之后是因为上面的早退分支不该动输入框（空提交要保留原文）。
  q.value = ''
  cmdList.value = []
  busy.value = true
  startElapsed()
  errMsg.value = ''
  hits.value = []
  trace.value = []

  // 用户消息立刻上屏 —— 这是"看得见自己发了什么"的关键：
  // 不能等回答出来才一起显示，否则等待期间面板里只有过程提示。
  pushMsg({ role: 'user', text })
  // AI 消息先占位，拿到结果再回填，这样滚动位置和顺序都稳定
  const aiId = pushMsg({ role: 'ai', text: '' })
  await scrollToBottom()

  /*
   * 斜杠命令：唯一一条"用户直接指定动作"的路径。
   *
   * ★ 放在意图分类之前、且解析失败就原样往下走 —— 不是命令的输入
   *   行为必须和以前完全一致（intent 正则 + 多轮编排）。
   * ★ 命令走规则层，所以没配模型也能用（原来是"仅本地判断"时只能搜索）。
   */
  const cmd = parseCommand(text)
  if (cmd) {
    try {
      await runCommand(cmd, aiId)
    } catch (e) {
      patchMsg(aiId, { text: '', error: e instanceof Error ? e.message : String(e) })
    } finally {
      busy.value = false
      stopElapsed()
      step.value = ''
    }
    await scrollToBottom()
    return
  }

  /**
   * 意图分类。
   *
   * ★ 分工原则（和 ZCode 选技能一样）：**判断交给模型，正则只做零成本的确定项**。
   *
   *   正则擅长的是"这句话百分之百是某个意图"——「播放庆余年第一集」里的
   *   动词+集数结构、「那就放它吧」这种纯应答。这类命中就不必花 3–4 轮模型往返。
   *   正则不擅长的（「换个源」「庆余年好看吗」「还有别的吗」）全交给模型，
   *   模型的判断依据是每个工具的 desc —— 所以真正的触发条件写在
   *   orchestrate.ts 的工具描述里，而不是这里的正则。
   *
   *   之前把大量语义硬编码成正则，是把模型的活抢过来做，越做越歪。
   */
  const hasConfirmed = lastConfirmedHits().length > 0
  const intent = classifyIntent(text, { hasConfirmed })

  try {
    // ① confirm：纯应答 + 上一轮确认过片 → 直接播，不走模型。
    //    这是最高频也最确定的一类，实测走模型时会被拿去当关键词搜。
    if (intent.kind === 'confirm') {
      const confirmed = lastConfirmedHits()
      const pick = confirmed.find((h) => h.sources?.length)
      if (pick) {
        step.value = `正在取「${pick.name}」…`
        const p = await meowPlay({
          site: pick.sources[0].site,
          vod_id: pick.sources[0].vod_id,
        })
        step.value = ''
        patchMsg(aiId, {
          text:
            p.ok && p.data
              ? `已取到《${pick.name}》${p.data.episode} 的可播地址，线路「${p.data.line}」。点「详情」进去播放。`
              : '',
          hits: confirmed,
          error: p.ok ? undefined : `没取到可播地址：${p.error || '未知原因'}`,
          trace: ['meow_play'],
        })
        await scrollToBottom()
        return
      }
      patchMsg(aiId, { text: '你想看哪部？说下片名我去搜。' })
      await scrollToBottom()
      return
    }

    // ② play：动词 + 片名 + 集数都齐全 → 规则直通，不耗模型。
    //    「播放庆余年第二季第一集」这种句子结构明确，正则拆得比模型准且快 5 倍。
    if (intent.kind === 'play' && intent.title) {
      const done = await runPlayIntent(
        { title: intent.title, episode: intent.episode },
        aiId,
      )
      if (done) {
        await scrollToBottom()
        return
      }
      // 落到这里说明规则路径没找到片，继续往下走模型（AI 可能知道别名）
    }

    // ③ 有模型 → 走多轮编排（自己决定调哪个工具）
    if (llmReady()) {
      const r = await orchestrate(text, {
        onProgress: (t) => (step.value = t),
        history: historyForModel(),
      })
      // 工具调用轨迹：让用户看到"查了什么"，也是排查 AI 乱调的凭据。
      // ★ 映射成中文动作（「搜索」而不是 meow_search）：命令列表用的也是这套叫法，
      //   界面上不能同时存在两套名字。
      trace.value = r.calls.map((c) => `${toolLabel(c.tool)}${c.ok ? '' : '（失败）'}`)
      // ★ 卡片必须用**模型实际搜的关键词**回填，不能用用户原话重新搜。
      //
      //   踩过：原来这里写 meowSearch(text)，text 是用户原话。
      //   多轮对话里第二句常说"那就放它吧"——拿它当关键词搜索，
      //   会把「扶你青云反成仇，那就放你尘埃」这种无关片当成结果贴到卡片上。
      //   模型的 args.keyword 才是它真正查的东西（可能来自上一轮上下文）。
      /*
       * 模型请求过缓存 → 取最后一份计划交给用户确认。
       *
       * 计划里是已解析好的直链（meow_cache_start 只解析不下载），
       * 用户点确认后直接 startBatchCache，不再重新解析一遍。
       */
      const planCalls = r.calls.filter(
        (c) => c.tool === 'meow_cache_start' && c.ok && (c.data as CachePlan | undefined)?.kind === 'cache-plan',
      )
      const plan = planCalls.length
        ? (planCalls[planCalls.length - 1].data as CachePlan)
        : undefined

      const searchCalls = r.calls.filter((c) => c.tool === 'meow_search' && c.ok)
      const lastSearch = searchCalls[searchCalls.length - 1]
      /*
       * 卡片直接用模型那次搜索的返回，**不再重搜一遍**（2026-11-02 改）。
       *
       * 原来这里 `meowSearch(kw, { limit: 6 })` 又跑了一次完整聚合搜索：
       * 跨 28 源实测 4–25 秒，全花在用户已经拿到结果之后，还会让
       * "卡片出来了但回复还没出"的顺序颠倒。`calls[].data` 就是那次搜索的
       * 原始 SearchHit[]，截 6 条即可，省掉整轮往返。
       */
      if (lastSearch?.data) {
        const list = lastSearch.data as SearchHit[]
        if (Array.isArray(list) && list.length) hits.value = list.slice(0, 6)
      }
      if (r.answer) {
        patchMsg(aiId, { text: r.answer, hits: hits.value, trace: trace.value, cachePlan: plan })
      } else {
        // 编排没给出结论时，别让面板空着。
        // ★ 三种 stopReason 必须分开说：原来只判 timeout，max_rounds 落进同一句
        //   "分析超时了"，会把"AI 试了 8 轮没搞定"误导成"网络慢"。
        //   error 里带着失败原因（哪一层超时 / 模型报了什么），三种都要带上——
        //   踩过：timeout 分支刻意不带原因，用户只能反复问"为什么超时"。
        const why = r.error ? `（${r.error}）` : ''
        const err =
          r.stopReason === 'timeout'
            ? `分析超时了${why}。可以再发一次，或看「运行日志」页。`
            : r.stopReason === 'loop'
              ? `AI 反复尝试同一步，先停下来了${why}。换个说法试试。`
              : r.stopReason === 'max_rounds'
                ? `试了 ${MAX_ROUNDS} 轮还没搞定${why}。可以换个说法，或看「运行日志」页。`
                : ''
        patchMsg(aiId, { text: '', hits: hits.value, trace: trace.value, error: err, cachePlan: plan })
      }
      await scrollToBottom()
      return
    }

    // 没配置模型 → 只做本地搜索（规则层，秒级）
    step.value = '正在搜索各源…'
    const r = await meowSearch(text, { limit: 6 })
    if (r.ok && r.data && r.data.length) {
      hits.value = r.data
      step.value = ''
      patchMsg(aiId, { text: `没有启用模型，这里是本地搜索结果（${r.data.length} 部）。`, hits: r.data })
      await scrollToBottom()
      return
    }
    patchMsg(aiId, {
      text: '',
      error: '没有搜到匹配的影片。可以换个关键词，或在设置里启用 AI 助手来问更复杂的问题。',
    })
    await scrollToBottom()
  } catch (e) {
    patchMsg(aiId, { text: '', error: e instanceof Error ? e.message : String(e) })
    await scrollToBottom()
  } finally {
    busy.value = false
    stopElapsed()
    step.value = ''
  }
}

/**
 * 打开某部片的详情页。
 *
 * ★ 这一步必须由用户点（§3.6）：全屏与自动播放都要用户激活。
 * 同时它也是"AI 猜错了"的补救点——看到片名不对，不点就是了。
 */
function play(hit: SearchHit, src: { site: string; vod_id: string }) {
  void router.push({
    name: 'detail',
    params: { site: src.site, id: src.vod_id },
    // 同 PosterCard：拿不到详情时详情页要靠这个片名转去搜索页
    query: hit.name ? { name: hit.name } : undefined,
  })
  hide()
}

function sourceCount(hit: SearchHit): number {
  return hit.sources?.length || 0
}

/**
 * 源 key → 中文名（「AppRJ」→「潮流」）。
 *
 * <p>用户看不懂内部 key（2026-11-03 反馈「搜出来的列表合适位置带上源名称」）。
 * 名称只在 `/api/sites` 里，卡片又只有 site key，所以查 store 的站点表；
 * 查不到（源被删/配置换了）就退回 key 本身，绝不能显示空白。
 */
const siteNameMap = computed(() => {
  const m = new Map<string, string>()
  for (const s of store.sites) m.set(s.key, s.name || s.key)
  return m
})

function siteName(key: string): string {
  return siteNameMap.value.get(key) || key
}

/**
 * 这条 AI 消息相关的跳转入口。
 *
 * 为什么要有：AI 的回答经常是"去运行日志看看"或"在设置里启用模型"。
 * 桌面上用户还能自己找，电视上要退回顶栏再一层层钻，基本等于没有。
 * 所以把回答里出现的关键词变成可点的入口——按关键词从固定表里挑，
 * 不做语义判断（判断错了多一个按钮，比少一个好用）。
 *
 * 只在**没有影片卡片**时才给：有卡片时用户的下一步是点卡片，
 * 再加一排跳转会把主操作稀释掉。
 */
interface Jump {
  to: string
  label: string
}

const JUMP_TABLE: Array<{ keys: string[]; to: string; label: string }> = [
  { keys: ['日志', '报错', '错误', '失败', '超时', '诊断'], to: '/logs', label: '运行日志' },
  { keys: ['设置', '模型', '启用', '没有配置', '未配置', 'API'], to: '/settings', label: '设置' },
  { keys: ['片库', 'NAS', '本地'], to: '/library', label: '片库' },
  { keys: ['历史', '继续看', '上次'], to: '/history', label: '历史' },
  { keys: ['收藏'], to: '/favorites', label: '收藏' },
]

/*
 * ★ 不做缓存。
 *   曾经用 WeakMap 缓存结果，结果占位消息（text 还是空串）先算了一次并存下
 *   `[]`，之后 patchMsg 填入答案仍然返回旧值——跳转按钮永远不出现。
 *   表只有 5 条、都是字符串 includes，重算的代价可以忽略。
 */
function jumpsFor(m: ChatMsg): Jump[] {
  if (m.hits?.length) return []
  const text = `${m.text || ''} ${m.error || ''}`
  const out: Jump[] = []
  for (const j of JUMP_TABLE) {
    if (j.keys.some((k) => text.includes(k)) && !out.some((o) => o.to === j.to)) {
      out.push({ to: j.to, label: j.label })
    }
  }
  return out
}

function go(to: string) {
  void router.push(to)
  // 浮层模式下跳走要收起，否则回来还压着半个屏幕；
  // 独立页模式下 hide() 本身是空操作，不会把页面关掉。
  hide()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  /*
   * 暴露全局开关，供遥控器「菜单键」调用。
   *
   * 用户需求（2026-10-30）：「分析菜单按键绑定效果。是否能够绑定AI助手弹框弹出」。
   *
   * 为什么要这个钩子而不是让 tvMenu 直接改状态：`open` 是本组件内部的 ref，
   * 别的模块读不到。而菜单键的语义是"当前上下文能做什么"——
   * 在没有任何卡片动作可用时（首页分类条、设置页空白处），
   * 打开发 AI 助手是最有用的兜底，见 tvMenu.ts 的 fallback。
   *
   * 只在浮层模式暴露：独立页（/ai）本身就是 AI，再"打开"没有意义。
   */
  if (!props.inline) {
    const w = window as unknown as {
      __meowAiOpen?: () => boolean
      __meowAiClose?: () => void
      __meowAiIsOpen?: () => boolean
    }
    w.__meowAiOpen = () => {
      if (!visible.value) return false
      void show()
      return true
    }
    w.__meowAiClose = () => hide()
    w.__meowAiIsOpen = () => open.value
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (!props.inline) {
    const w = window as unknown as { __meowAiOpen?: unknown; __meowAiClose?: unknown; __meowAiIsOpen?: unknown }
    delete w.__meowAiOpen
    delete w.__meowAiClose
    delete w.__meowAiIsOpen
  }
  // 计时器每秒触发一次 ref 更新；组件没了还留着会对着已卸载的组件刷渲染
  stopElapsed()
})
</script>

<template>
  <!--
    「浮层」与「独立页」共用同一棵 DOM：只是外层类名与容器不同。
    这样消息列表 / 输入表单 / 编排逻辑只有一份，不会两边行为漂移。
  -->
  <template v-if="props.inline || visible">
    <!-- 悬浮按钮：收起态只有图标，不占版面。独立页里没有收起态，不出按钮 -->
    <button
      v-if="!props.inline && !open"
      class="ai-fab fixed bottom-6 right-6 z-[60] grid place-items-center rounded-full bg-accent text-on-accent shadow-xl transition hover:scale-105"
      :title="'AI 助手（Ctrl+K）'"
      aria-label="打开 AI 助手"
      @click="show"
    >
      <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z" />
        <path d="M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z" />
      </svg>
    </button>

    <!-- 面板：浮层模式半屏、独立页模式占满父容器 -->
    <div
      v-else
      :class="
        props.inline
          ? 'ai-inline flex h-full w-full flex-col overflow-hidden rounded-xl border border-line bg-elevated'
          : 'ai-panel fixed bottom-6 right-6 z-[60] flex flex-col overflow-hidden rounded-xl border border-line bg-elevated shadow-2xl'
      "
      :role="props.inline ? 'region' : 'dialog'"
      :data-tv-scope="props.inline ? undefined : ''"
      aria-label="AI 助手"
    >
      <div class="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span class="text-[13px] font-medium text-ink">AI 助手</span>
        <span
          class="rounded px-1.5 py-0.5 text-[10px]"
          :class="llmReady() ? 'bg-ok/15 text-ok' : 'bg-field text-ink-3'"
        >
          {{ llmReady() ? '已启用模型' : '仅本地判断' }}
        </span>
        <span class="flex-1" />
        <!--
          清空对话：只在聊过之后出现，免得空面板上多一个无效按钮。
          TV 上按钮越多方向键走得越远，所以位置固定在右上角第一格。
        -->
        <button
          v-if="msgs.length"
          class="rounded px-1.5 py-0.5 text-[11px] text-ink-3 transition hover:bg-card-hover hover:text-ink"
          title="清空对话"
          @click="clearChat"
        >
          清空
        </button>
        <!--
          浮层 → 独立页。TV 上面板只有 ~34rem×74vh，对话区实际约 400px，
          长回答要反复滚；独立页占满整屏。放在这里是因为用户"觉得挤"的
          那一刻正是盯着这个面板的时候。
        -->
        <RouterLink
          v-if="!props.inline"
          to="/ai"
          class="rounded px-1.5 py-0.5 text-[11px] text-accent transition hover:bg-card-hover"
          title="在独立页面打开（更大）"
          @click="hide"
        >
          全屏
        </RouterLink>
        <RouterLink
          v-else
          to="/settings"
          class="rounded px-1.5 py-0.5 text-[11px] text-ink-3 transition hover:bg-card-hover hover:text-ink"
          title="AI 相关设置"
        >
          设置
        </RouterLink>
        <button
          v-if="!props.inline"
          class="rounded px-1.5 py-0.5 text-[11px] text-ink-3 transition hover:bg-card-hover hover:text-ink"
          title="关闭（Esc）"
          @click="hide"
        >
          关闭
        </button>
      </div>

      <!--
        会话列表：只在**没有可聚焦元素**时才该当滚动停靠点。
        ★ 2026-11-04 审计：原来无条件标 data-tv-scroll + tabindex，
          而消息里的建议按钮/操作按钮都在这个容器内 —— 容器矩形包住它们，
          几何上 primary=0，上下键会先落到容器（左竖条）再按才进消息。
          现在不标；空态/纯文本时 tv-nav 的 autoScrollAnchor 会自动补上。
      -->
      <div
        ref="listEl"
        class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-3 outline-none"
      >
        <!-- 空态引导 -->
        <p v-if="!msgs.length" class="text-[12px] leading-relaxed text-ink-3">
          可以问：找部片（如「庆余年」）、为什么播不了、这部有没有第二季。
          <br />
          打 <span class="text-accent">/</span> 用命令（不用模型也能跑，见 {{ COMMANDS.length }} 条命令）。
        </p>

        <!-- 对话记录：自己的原话 + AI 的回复都要留痕 -->
        <template v-for="m in msgs" :key="m.id">
          <!-- 用户 -->
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div
              class="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-accent/15 px-2.5 py-1.5 text-[12px] leading-relaxed text-ink"
            >
              {{ m.text }}
            </div>
          </div>

          <!-- AI -->
          <div v-else class="flex justify-start">
            <div class="min-w-0 max-w-[92%] space-y-1.5">
              <!-- 工具轨迹：让用户看到查了什么，也是排查乱调的凭据 -->
              <div v-if="m.trace?.length" class="text-[10px] leading-relaxed text-ink-3/70">
                已查：{{ m.trace.join(' → ') }}
              </div>

              <div
                v-if="m.text"
                class="whitespace-pre-wrap rounded-lg rounded-tl-sm bg-card px-2.5 py-1.5 text-[12px] leading-relaxed text-ink-2"
              >
                {{ m.text }}
              </div>

              <p v-if="m.error" class="text-[12px] leading-relaxed text-hot">{{ m.error }}</p>

              <!--
                跳转按钮：AI 说"去哪里看/去哪里改"的时候必须给得着。
                电视上退回顶栏再一层层找，等于让用户放弃。
                只显示与这条消息相关的入口，不堆成按钮墙。
              -->
              <div v-if="jumpsFor(m).length" class="flex flex-wrap gap-1.5">
                <button
                  v-for="j in jumpsFor(m)"
                  :key="j.to"
                  class="rounded bg-card px-2 py-0.5 text-[11px] text-ink-3 transition hover:bg-card-hover hover:text-ink"
                  @click="go(j.to)"
                >
                  {{ j.label }}
                </button>
              </div>

              <!--
                缓存确认卡：AI 提议缓存这部片时出现。
                模型只提议（不下载），用户点「开始下载」才真的入队——
                下载要花流量和磁盘，这个决定不能由模型替用户做。
              -->
              <div
                v-if="m.cachePlan"
                class="rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-2"
              >
                <div class="flex items-center gap-2">
                  <div class="h-14 w-10 shrink-0 overflow-hidden rounded bg-elevated">
                    <PosterImage :src="m.cachePlan.poster" :alt="m.cachePlan.name" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] text-ink">{{ m.cachePlan.name }}</div>
                    <div class="mt-0.5 truncate text-[11px] text-ink-3">
                      共 {{ m.cachePlan.items.length }} 集 · 线路 {{ m.cachePlan.line }}
                      <template v-if="m.cachePlan.skipped">
                        · {{ m.cachePlan.skipped }} 集拿不到直链
                      </template>
                    </div>
                  </div>
                </div>
                <div class="mt-2 flex items-center gap-2">
                  <button
                    class="rounded bg-accent px-3 py-1 text-[11px] font-semibold text-on-accent transition hover:bg-accent-dim disabled:opacity-50"
                    :disabled="cacheBusy !== null"
                    @click="confirmCache(m)"
                  >
                    {{ cacheBusy === m.id ? '提交中…' : '开始下载' }}
                  </button>
                  <button
                    class="rounded px-2 py-1 text-[11px] text-ink-3 transition hover:bg-card-hover hover:text-ink"
                    :disabled="cacheBusy !== null"
                    @click="dismissCache(m)"
                  >
                    不用了
                  </button>
                  <span class="text-[10px] text-ink-3">下完断网也能看</span>
                </div>
              </div>
              <p v-if="cacheDone[m.id]" class="text-[11px] leading-relaxed text-ok">
                {{ cacheDone[m.id] }}
              </p>

              <!-- 影片卡片：只属于这一轮 -->
              <div v-if="m.hits?.length" class="space-y-2">
                <div
                  v-for="(h, i) in m.hits"
                  :key="`${m.id}-${h.name}-${i}`"
                  class="rounded-lg border border-line bg-card px-2.5 py-2"
                >
                  <div class="flex items-center gap-2">
                    <!-- 海报：与首页/详情页同一个组件，走同样的代理与占位逻辑 -->
                    <div class="h-14 w-10 shrink-0 overflow-hidden rounded bg-elevated">
                      <PosterImage :src="h.pic" :alt="h.name" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-[13px] text-ink">{{ h.name }}</div>
                      <!--
                        源名放这里（2026-11-03 用户要求）：卡片的第二行原本只有
                        "第24集 · 1 个来源"，用户看不出是哪家给的。
                        多源时优先显示第一个源的**中文名**，并标出总数——
                        要逐个挑源用下面的 chips（那里也是中文名）。
                      -->
                      <div class="mt-0.5 truncate text-[11px] text-ink-3">
                        <template v-if="sourceCount(h) === 1">
                          {{ siteName(h.sources[0]?.site || '') }} ·
                          {{ h.remarks || '可播放' }}
                        </template>
                        <template v-else>
                          {{ siteName(h.sources[0]?.site || '') }} 等
                          {{ sourceCount(h) }} 个源 ·
                          {{ h.remarks || '可播放' }}
                        </template>
                      </div>
                    </div>
                    <button
                      class="shrink-0 rounded bg-accent/15 px-2.5 py-1 text-[11px] text-accent transition hover:bg-accent/25"
                      @click="h.sources?.[0] && play(h, h.sources[0])"
                    >
                      ▶ 详情
                    </button>
                  </div>
                  <!-- 来源行：源名（中文）+ 各自可播 -->
                  <div v-if="sourceCount(h) > 1" class="mt-1.5 flex flex-wrap gap-1">
                    <button
                      v-for="s in h.sources.slice(0, 6)"
                      :key="s.site + s.vod_id"
                      class="rounded bg-field px-1.5 py-0.5 text-[10px] text-ink-3 transition hover:bg-card-hover hover:text-ink"
                      :title="`在 ${siteName(s.site)} 打开`"
                      @click="play(h, s)"
                    >
                      {{ siteName(s.site) }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 占位：AI 消息已建但还没有任何内容（正在跑工具/等模型） -->
              <div
                v-if="!m.text && !m.error && !m.hits?.length"
                class="text-[12px] leading-relaxed text-ink-3"
              >
                {{ step || '思考中…' }}<span v-if="elapsedSec > 0" class="ml-1 text-ink-3/60">（{{ elapsedSec }}s）</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <form
        class="relative flex items-center gap-2 border-t border-line px-3 py-2.5"
        @submit.prevent="submit"
      >
        <!--
          命令候选：输入 `/` 时向上展开（下方是面板底边，向下没有空间）。

          ★ 用 absolute 而不是占位：否则列表一出现就把消息区顶上去，
            用户正在读的那行会跳走。
          ★ 首项标 data-tv-first：打开后焦点直接落在列表里，遥控器方向键可达。
        -->
        <div
          v-if="cmdOpen"
          ref="cmdListEl"
          class="ai-cmd-list absolute inset-x-0 bottom-full mb-1 overflow-hidden rounded-lg border border-line bg-elevated shadow-xl"
          role="listbox"
          aria-label="可用命令"
        >
          <div class="px-2.5 py-1.5 text-[10px] text-ink-3">
            命令 · ↑↓ 选择，Enter 填充，Esc 关闭
          </div>
          <button
            v-for="(c, i) in cmdList"
            :key="c.name"
            type="button"
            role="option"
            :aria-selected="i === cmdIndex"
            :data-tv-first="i === 0 ? '' : undefined"
            class="ai-cmd-item flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left transition"
            :class="i === cmdIndex ? 'bg-card-hover' : ''"
            @mouseenter="cmdIndex = i"
            @click="pickCommand(c)"
          >
            <span class="shrink-0 text-[12px] font-semibold text-accent">/{{ c.name }}</span>
            <span v-if="c.argHint" class="shrink-0 text-[11px] text-ink-3">{{ c.argHint }}</span>
            <span class="min-w-0 flex-1 truncate text-[11px] text-ink-3">{{ c.desc }}</span>
          </button>
          <div class="border-t border-line px-2.5 py-1.5 text-[10px] text-ink-3">
            {{ cmdList[cmdIndex]?.example || '' }}
          </div>
        </div>

        <!--
          `/` 入口：桌面是可发现性（不用记语法），TV 是唯一可达路径
          （遥控器打不出斜杠）。不标 data-tv-first —— 输入框才是进页面的落点。
        -->
        <button
          type="button"
          class="ai-cmd-btn shrink-0 rounded-md border border-line bg-field px-2 py-1.5 text-[12px] font-semibold text-ink-3 transition hover:border-accent/50 hover:text-accent"
          title="命令（也可以用键盘打 /）"
          aria-label="打开命令列表"
          :disabled="busy"
          @click="openCommands"
        >
          /
        </button>

        <input
          ref="input"
          v-model="q"
          maxlength="100"
          data-tv-first
          data-tv-native-input
          placeholder="说一句话，或打 / 用命令"
          class="min-w-0 flex-1 rounded-md border border-line bg-field px-2.5 py-1.5 text-[13px] text-ink outline-none transition focus:border-accent"
          :disabled="busy"
          @input="onInput"
          @keydown="onInputKeydown"
        />
        <button
          type="submit"
          class="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent disabled:opacity-50"
          :disabled="busy || !q.trim()"
        >
          {{ busy ? '…' : '发送' }}
        </button>
      </form>
    </div>
  </template>
</template>

<style scoped>
.ai-fab {
  width: 3.5rem;
  height: 3.5rem;
}
.ai-panel {
  /* ★ 不用 min()：Chrome 66（投影仪）不支持，整条宽度声明会被丢弃 → 面板宽度失控。
     width + max-width 等价且是老特性。 */
  width: 26rem;
  max-width: calc(100vw - 3rem);
  /*
   * ★ 要给一个初始高度，不能只写 max-height。
   *
   * 用户反馈「AI助手面板能不能初始高一点」（2026-10-30 截图）：
   * 只有 max-height 时，面板高度由内容决定 —— 刚打开只有一句提示
   * 加一个输入框，压成 170px 左右的一条，对话区几乎看不见，
   * 用户会以为"这面板就这么小"。
   *
   * 用 `height` 而不是 `min-height`：对话区是 flex 子项，
   * `min-height` 在 flex 布局里会被内容撑破或压不下去，`height` 才稳定。
   * 32rem = 512px，配合下面的 max-height 保证窄屏不会超出。
   */
  height: 32rem;
  max-height: 70vh;
}
/*
 * 手机：浮层改成底部抽屉。
 *
 * 390px 视口下原来的 342×512 浮层四边都悬空，聊天内容只剩 400px 高，
 * 键盘弹出时输入框还在屏幕外。改成贴底满宽 + 盖住大半个屏，输入框
 * 始终在拇指区。
 *
 * `86vh` 与 `86dvh` 写两遍：dvh 会跟键盘/地址栏收缩（Chrome 108+），
 * 老内核丢掉 dvh 那条、退回 vh —— 不会像 `height:100dvh` 那样整条失效。
 */
@media (max-width: 639px) {
  .ai-panel {
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    height: 86vh;
    max-height: 86vh;
    height: 86dvh;
    max-height: 86dvh;
    border-radius: 1rem 1rem 0 0;
    padding-bottom: env(safe-area-inset-bottom);
  }
}

/* 电视是 10-foot UI：按钮与面板都要放大一档 */
html[data-tv='1'] .ai-fab {
  width: 4.5rem;
  height: 4.5rem;
}
/*
 * 命令列表：列表项本身就是遥控器落点，行高必须够（默认 1.5rem 的点击区
 * 在 10-foot 距离上太难瞄）。`/` 按钮同理放大，它是 TV 上唯一入口。
 */
html[data-tv='1'] .ai-cmd-item {
  padding-top: 0.5rem;
  padding-bottom: 0.5rem;
}
html[data-tv='1'] .ai-cmd-btn {
  padding-left: 0.75rem;
  padding-right: 0.75rem;
}
/* 候选最多 5 条，但字体被系统放大时也要能滚，不能顶穿面板 */
.ai-cmd-list {
  max-height: 60vh;
  overflow-y: auto;
}
html[data-tv='1'] .ai-panel {
  width: 34rem;
  max-width: calc(100vw - 4rem);
  /* TV 视口 640，74vh = 474px；给足高度让对话区一打开就能看几轮 */
  height: 74vh;
  max-height: 74vh;
}
</style>
