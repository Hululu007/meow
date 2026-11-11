# AI 助手：语义工具、诊断解释与对话入口

**一句话结论**：AI 是**客户端能力**——工具、规则、意图分类、编排、模型调用全在前端
（三端同一份 bundle），后端保持"哑"的 REST，只在纯 Web 环境提供一个可选的模型转发
（`/api/llm/relay`，默认关闭）。

两个入口决策：

- **★ 主入口是现有错误页**：播放失败时结论直接显示在错误文案下方，用户不用学新交互；
  悬浮按钮 / AI 独立页只是"没有错误页"时的对话入口。
- **★ 规则先行**：诊断归因零 LLM 依赖、100ms 出结论、断网也能跑；LLM 只负责解释与追问。
  对话里那句「▶ 播放」必须由用户点——它同时解决全屏激活与自动播放两个平台限制。

> 文中的 `文件:行号` 是核对时位置，重构会漂移；定位代码请按符号名 grep。

| 关注点 | 代码 |
|---|---|
| 11 个语义工具（唯一真源） | `client/apps/web/src/ai/tools.ts` |
| 多轮编排 + 给模型的工具 schema | `client/apps/web/src/ai/orchestrate.ts` / `summarize.ts` |
| OpenAI 兼容调用、token/超时策略 | `client/apps/web/src/ai/llm.ts` |
| 诊断规则库（10 条）与输出契约 | `client/apps/web/src/ai/diagnose.ts` |
| 意图分类（规则直通层） | `client/apps/web/src/ai/intent.ts` |
| 外部 MCP 工具桥 | `client/apps/web/src/ai/bridge.ts` |
| 斜杠命令 | `client/apps/web/src/ai/commands.ts` |
| 提示词 | `client/apps/web/src/ai/prompt.ts` / `llm.ts` |
| 面板与独立页 | `client/apps/web/src/components/ai/AiPanel.vue` / `views/AiView.vue` |
| 模型转发（纯 Web 兜底，默认关） | `server/host/src/shared/routes/LlmRelay.java` |
| 外部 MCP 壳侧 | PC `client/apps/desktop/src-tauri/src/mcp.rs`、TV `client/apps/tv/app/src/main/java/com/meow/tv/DebugServer.java` |

AI 的行为约束由测试钉住（`tests/ai-orchestrate.test.ts` 断言常量取值与文档一致、
工具清单完整性、`ai-diagnose.test.ts` / `ai-intent.test.ts` / `ai-llm-retry.test.ts` /
`ai-logs-tool.test.ts` / `ai-model-timeout.test.ts` / `ai-commands.test.ts` /
`ai-panel-and-menu.test.ts`）——改任何常量、工具集、提示词结构，跑这组测试就知道漏了哪。

---

## 一、意图路由的三层分工

**AI 对话时怎么决定调哪个工具：模型看描述选**（和 ZCode 选技能同一机制），
我们的"技能"就是 `meow_*` 工具。三层分工，判断权各归其位：

| 层 | 负责 | 在哪 |
|---|---|---|
| ① 工具描述 | 模型决定调哪个工具（**主路径**）。每段 desc 写清「什么时候用」**和「什么时候不要用」** | `orchestrate.ts` 的 `TOOLS[].desc` |
| ② 规则分类器 | 只做零成本的确定项：动词+集数、纯应答词这类有明确结构的句子 | `intent.ts` 的 `classifyIntent()` |
| ③ 代码兜底 | 拦住误判后果：`keyword` 无实义时直接拒绝，不让它返回无关片 | `tools.ts` 的 `meowSearch` |

`classifyIntent` 返回 11 种意图（`intent.ts:32-53`）：`play / search / confirm /
followup / diagnose / sources / live / danmaku / cache / library / chat`。
面板先走规则直通（`play` 结构完整就不耗模型；`confirm`/`followup` 复用上一轮结果），
`chat` 交给编排，LLM 未配置时除搜索外全部不可达——这正是斜杠命令存在的理由（4.4）。

**为什么不全部交给正则**（走过的弯路）：把语义硬编码成正则是在替模型做它擅长的事。
弱模型会犯错，解法是**把工具描述写准 + 代码兜底**，不是把判断权收回到正则；
正则只处理"百分之百确定"的结构。

---

## 二、语义工具

### 2.1 清单（11 个）

落点在前端：`tools.ts` 存实现（**唯一真源**），`orchestrate.ts` 的 `TOOLS` 存给模型的
schema，`bridge.ts` 的 `TOOL_IMPL` 暴露给外部 MCP。**后端不参与工具层。**

| 工具 | 包装端点 | 说明 |
|---|---|---|
| `meow_state` | `/api/health` + `/api/sites` + `/api/health/state` + `/api/logs` 概况 | AI 的"眼睛"，任何操作前先调。只给 `logCounts`/`logTags`，正文让模型自己调 `meow_logs` |
| `meow_logs` | `GET /api/logs`，筛选在前端做 | 级别/模块/关键词/时间窗**全由模型决定**（见 2.3） |
| `meow_diagnose` | `__playerDebug` + `__meowDiag` + `/api/logs` + 当前路由 | 一次拼出"为什么播不了"的因果链（第三章） |
| `meow_search` | `POST /api/search` | 最常用入口，返回结构化结果 |
| `meow_play` | `/api/{site}/detail` → `/api/{site}/play` → 返回地址 | 见 2.5 的现状与差距 |
| `meow_sources` | `/api/sites` + `/api/health/state` | 源健康清单（可用/降级/停用 + 最近错误） |
| `meow_cache` | `/api/cache/grouped` | 查缓存。读 grouped（一剧一条）而不是平铺 list——平铺会吐 24 行"第1/2/3集"噪音 |
| `meow_cache_start` | `/api/{site}/detail` → 逐集 `/api/play` 解析直链 | **只解析、不下载**，返回 `CachePlan` 交 UI 弹确认卡（2.6） |
| `meow_library` | `/api/library` | 片库浏览；TV 读 U 盘时唯一入口 |
| `meow_danmaku` | `/api/proxy/danmaku/search` | 弹幕源诊断 |
| `meow_live` | `/api/live` | 按 `groups[].channels` 统计（顶层没有 `channels` 字段，读错会永远"0 个频道"且与"上游全挂"无法区分）；`failed == tried` 说明上游当天全挂，不是应用问题 |

**规模 11 个**（3 必用 + 5 常用 + 3 体验）。再多会稀释选择——模型在 20 个相近工具里
挑，准确率明显下降。两次破例：`meow_cache_start` 触发词明确（"帮我缓存/下载下来"）
且描述与 `meow_cache` 互斥；`meow_logs` 补 `meow_state` 的信息缺口（原来那条"最近
日志"全被 `GET /api/...` 噪音占据，真 error 早被挤出窗口）。

**明确不做成工具**：`/api/proxy/stream`（媒体流会灌爆上下文）、
`/api/config/import`（破坏性）、`POST /api/policy`（能改坏关键配置）、
`/api/transcode`（分钟级长任务，AI 等不起）。

### 2.2 三个注册表必须同步

`tools.ts` 的 `TOOL_DEFS`、`orchestrate.ts` 的 `TOOLS`、`bridge.ts` 的 `TOOL_IMPL`
三处各自独立成表，**漏一处该端就看不见这个工具**——实测漏过 3 个（模型根本看不见
`meow_danmaku`/`meow_live`/`meow_cache`，用户问"为什么没弹幕"它只能瞎猜）。
现在由测试逐名断言三处一致，漏一个就红。

### 2.3 schema 直接引用契约，参数越少越好

不为工具另写一套参数说明——入参出参引 [API 契约](./api-contract.md)，
工具层只做"最少必要参数"收敛，其余由前端 api 层补默认值
（`meow_search` 必填 `keyword`；`meow_play` 必填 `site`+`vod_id`；
`meow_logs` 的 `minLevel` 默认 info、`limit` 默认 50 上限 500；其余工具零必填）。
模型填 5 个参数的错误率明显高于填 2 个。

**`meow_logs` 的筛选为什么交给模型**：正常时日志全是 info req 噪音，真出事时
warn/error 才有信息——两种状态的正确采样完全不同，写死哪条都是猜。所以描述里写
"拿不准就先不带条件取 50 条看 level 分布，再按需收窄"，`meow_state` 的 `logTags`
就是候选清单。三端各自的注册表都有这个工具，`ai-logs-tool.test.ts` 逐个断言。

### 2.4 请求形态：站点分派只能用 POST

★ `/api/{site}/{action}` 的全部动作必须 POST——分派层读 body、完全不看 query。
写成 GET **不报错**：返回 200 和一个空壳 list（`vod_name=null`、播放表空），工具层
走到 `parseLines('')` 得 0 条线路，报"该片没有播放源"；而手动点播放走 POST 完全
正常——表现为"AI 坏了但应用没坏"，极难归因。显式路由（`/api/health`、`/api/live`、
`/api/proxy/danmaku/search`）是 GET + query，不受影响。

### 2.5 `meow_play`：现状与设计差距

**现状**（`tools.ts` 的 `meowPlay`）：detail → `parseLines` → 顺序试线路（指定线路
排最前）→ 每条 POST `/play` → 拿到 url 就返回 `{url, line, episode, tried}`，
全试完返回失败。集数匹配单独处理：**不能用 `includes('4')`**——源站集名
「第14集」会先命中，用户要第 4 集播的是第 14 集；且模型会把「第一集」原样传进来，
所以先做中文数字归一化再数字比较（`tools.ts` 的 `episodeNumber`）。

**与设计目标的差距（已知限制，改之前要知道）**：

- **线路尝试无封顶**：设计要求"最多 3 条 + 源健康排序 + 20s 起播看门狗 + 失败记录
  绑影片"，现实现是全量顺序尝试、无健康排序、无看门狗。好在每条只是一次 `/play`
  调用（毫秒级），最坏情况是"全坏时多几次请求"，不是分钟级卡死
- **没有复用播放页的换线**：`PlayView.vue` 已有 `addFailedLine`/`nextLineCandidate`
  （三条失败路径各自换线），但那是"页面内换线"，工具层是"取到 url 即返回"，
  两者语义不同，目前是两份独立逻辑。若要统一，先想清楚工具层不该有 20s 看门狗
  （起播验证是 UI 的事）

### 2.6 写操作的边界：`meow_cache_start` 只到"提议"

下载要花流量和磁盘，**不能由模型自主决定**。所以工具只做无副作用的那一半——
解析出每集的可下载 m3u8 直链（拿不到直链的集跳过），返回 `CachePlan`
（多少集、哪些直链、海报、剧名），面板弹确认卡，用户点「开始下载」才入队
（`AiPanel` 的 `confirmCache` → `startBatchCache`）。解析放在确认**之前**，
是为了让确认框能显示"共 12 集"这种可判断的信息。

编排层的 schema 描述同样声明了这一点（`ai-orchestrate.test.ts` 有
"写操作不由模型自主执行"与"meow_cache_start 只解析不下载"两条门禁）。

### 2.7 对外 MCP：10 个工具已打通

```
外部 AI 客户端 → PC mcp.rs / TV DebugServer → CDP evaluate / evaluateJavascript
                                             → window.__meowTool(name, args)
                                             → src/ai/tools.ts 真正实现
```

壳不重写业务逻辑，只转发到页面里的 `window.__meowTool`（`bridge.ts`），唯一真源留在
前端。PC 暴露 18 个 `pc_*`（UI 原语）+ **10 个 `meow_*`**；TV 13 个 `tv_*` + 10 个
`meow_*`（两处与 bridge 一一对应，`mcp.rs` 的 match 分支逐个列出工具名、
`DebugServer.java` 的 `mcpTools()` 逐个注册）。`meow_cache_start` 是写操作不进外部桥；
`meow_cache` 只暴露 `list`。

| | PC（`mcp.rs`） | TV（`DebugServer.java`） |
|---|---|---|
| 执行方式 | CDP `Runtime.evaluate` + `awaitPromise: true` | `evaluateJavascript` 同步回调，拿不到 Promise |
| 桥入口 | `await window.__meowTool(name,args)` | `__meowToolStart(id,…)` 投任务 → 循环 `__meowToolPoll(id)` |
| 超时 | CDP 侧决定 | 35s 总超时 / 300ms 轮询间隔 |

★ TV 必须用轮询：直接 `await window.__meowTool(...)` 只能拿到 pending Promise，
值永远回不来——两端唯一必须分叉的地方。★ PC 的表达式必须是 `async IIFE + await`
（顶层是 Promise），`awaitPromise` 只对顶层 Promise 生效。

**加工具时改五处**：`tools.ts`（实现）→ `bridge.ts`（TOOL_IMPL 一行）→
`orchestrate.ts`（TOOLS 条目）→ `mcp.rs`（tool_defs + match 分支）→
`DebugServer.java`（mcpTools，`callMeowTool` 已按前缀通配）。测试会断言
bridge 与 orchestrate 工具集一致，漏改一边就红。

**安全边界**：桥里只放只读工具；TV 侧保留 `X-Meow-Token` 鉴权；PC 侧 127.0.0.1
回环无鉴权（本机风险可接受）。

---

## 三、诊断：规则先行，LLM 可选

### 3.1 两段式

★ **不能让 LLM 做诊断，只能让它做补充解释**——整个方案最重要的决定。

```
用户点「诊断」/ AI 调 meow_diagnose / 错误页自动触发
   ↓
第一段：确定性归因（无 LLM，< 100ms）
   采集 __playerDebug + __meowDiag + /api/logs + 当前路由
   规则库匹配 → {cause, evidence[], suggestion}
   ↓
第二段（可选）：LLM 解释 / 追问
   结构化结论 + 脱敏证据 → 人话 / 回答追问
```

四条理由：**延迟**（规则 100ms vs LLM 1–3 秒，用户已等了 20 秒起播超时）、
**可靠性**（LLM 判错会"该换线的没换"，规则判错最多文案不准）、**成本**（规则零成本）、
**可审计**（cause code 是枚举，能统计哪种失败最多）。

**LLM 只在三件事上有增量**：多因并存时判断主因（规则只能平铺列出）；长尾
（规则不命中的未知错误串）；追问（"换个源会丢进度吗"）。这三条都不需要的话，
只做规则层收益损失不大——保留 LLM 是为了这三条，不是"为了智能而智能"。

### 3.2 规则库（判据按 hls.js 事件写，不按 `video.error.code`）

`video.error.code` 只有 4 个枚举，「占位图」和「编码不支持」都落在
`MEDIA_ERR_SRC_NOT_SUPPORTED(4)`，DOM 层面区分不开。可用判据是 hls.js 的
`data.details` + `data.response.code`（`VideoPlayer.vue` 的 collectDebug 已采集）。
`diagnose.ts` 的 `RULES` 现有 10 条：

| cause_code | 判据 | 建议动作 |
|---|---|---|
| `SOURCE_PLACEHOLDER` | `manifestParsingError` 且 HTTP 200（源把 HTML/图片当清单返回） | 换线路/换源 |
| `SOURCE_403_REFERER` | `manifestLoadError`/`fragLoadError` 且 code ∈ {401,403} | 补 Referer 重试，仍败换线路 |
| `HLS_RELATIVE_404` | `fragLoadError` 404 且分片与清单同主机 | 应用缺陷，报给我们 |
| `CODEC_UNSUPPORTED` | `bufferAddCodecError`/`bufferAppendError`，或无网络错误但 `video.error.code===4` | 转码或换源 |
| `NETWORK_TIMEOUT` | `manifestLoadTimeOut`/`fragLoadTimeOut`，或起播看门狗到期 `readyState<3` | 换线路 |
| `PARSE_REQUIRED` | `play.parse===1` 且未调解析，或 url 非 http | 前端漏调解析 |
| `SOURCE_EMPTY_LIST` | search/detail 返回空 list（健康度已计失败） | 源失效换源 |
| `DANMAKU_ONLY` | `readyState>=3` 但弹幕 0 条 | 不影响观看 |
| `CORS_BLOCKED` | 后端日志 `tag=cors` 出现 blocked origin | 后端 CORS 配置 |
| `WEBVIEW_TOO_OLD` | 样式探针 `getComputedStyle().display` 为空 | 设备内核过旧 |

优先级 `blocking`（播不了）> `degraded`（能播但体验差）> `info`；
一次命中多条全部列出，主因判断交给 LLM 或固定优先级。

**证据链的现状**：`collectSources` 读 `window.__playerDebug`（播放器状态与
`lastError`）与 `window.__meowDiag`（前端请求记录），加 `/api/logs`。早年"致命 hls
错误不回写、分片请求冲掉请求缓冲、日志只记 method+path"三个缺口**已修复**
（致命错误照写、代理路径已进日志过滤、流失败有 warn 记录），诊断规则现在能稳定
取到"分片 403/404"类证据。诊断用的缓冲与面向人的日志**过滤规则天然冲突**
（前者只留失败、后者要全量排除高频路径），所以不共用同一个判断函数。

### 3.3 输出契约

```json
{
  "ok": true,
  "cause":  { "code": "SOURCE_PLACEHOLDER", "confidence": "high", "severity": "blocking" },
  "evidence": [ { "kind": "hls", "detail": "manifestParsingError, HTTP 200" } ],
  "suggestion": { "action": "switch_line", "text": "…", "options": ["线路2"] },
  "explanation": "（可选，LLM 生成；未配置模型时为 null）"
}
```

枚举只有这几档：`confidence` high/medium/low（多规则同命中降一档）、
`severity` blocking/degraded/info、`evidence[].kind` hls/player/network/backend/style。
**没命中任何规则时返回 `cause: null`**——不要编一个 `UNKNOWN`：`cause: null` 让
上层能区分"没诊断出问题"（视频本来能播）和"诊断出未知问题"。`ok: false` 只用于
诊断本身失败（读不到 `__playerDebug` 等），此时带 `error`。

`explanation` 为 null 时前端**只显示 `suggestion.text`，UI 不做区分**——用户不该
看到"你没配模型所以只有半套功能"。

### 3.4 结论贴在错误页 + action 必须可执行

播放失败时用户看的是错误页，不是面板。`suggestion.text` 作为一行说明插在错误文案
下方、现有按钮组上方；建议动作对应的高亮按钮放到按钮组最前。现有四个按钮
（原生播放器 / 换线路 / 重试 / 返回）行为一律不改。

`suggestion.action` 是枚举且必须映射到前端已有函数：
`switch_line` / `switch_source` / `retry` / `refresh_danmaku` / `open_logs` /
`transcode`（**要确认**）/ `disable_source`（**要确认**）/ `none`。
未知 action 一律降级成 `none`，**不要猜**。

---

## 四、对话入口：面板、独立页与斜杠命令

### 4.1 两种形态，一份逻辑

| 形态 | 位置 | 定位 |
|---|---|---|
| 悬浮按钮 + 面板 | `fixed bottom-6 right-6 z-[60]` | 非播放页的轻量入口 |
| AI 独立页 `#/ai` | `views/AiView.vue`，复用 AiPanel 的 inline 模式 | 对话区满屏；TV 上浮层只有约 400px 高，遥控器滚动太慢 |

面板在**播放页隐藏**（错误页已覆盖诊断，且选集/线路/弹幕/更多四块浮层在抢位），
`Ctrl+K` 仍可用；直播页同为满屏播放器也不显示；全屏时隐藏（`App.vue` 传 `hidden`）。

z-index 层级（实测自现有代码）：背景 z-0 → 内容 z-10 → 顶栏 z-30 → 播放器浮层
z-40 → **AI 面板 z-[60]** → 伪全屏 z-[100] → 居中弹窗 z-[120]。不要用 `z-50`——
盖不住又贴太近，且 `z-40` 的面板是播放器主操作，被盖住会挡主功能。

键盘：`Ctrl/Cmd+K` 打开并聚焦输入框、`Esc` 关闭；播放器的按键处理已排除修饰键，
不会与 `f`/`d` 冲突。**不要用单键**。TV 不绑快捷键——按键全被 `tv-nav.js` 接管。

### 4.2 一次请求的路径

```
输入 → parseCommand 命中？ → 走斜杠命令（零模型）
     → classifyIntent：play 结构完整 → 规则直通（搜索+play，不耗模型）
     → llmReady() → orchestrate（多轮编排）
     → 否则 → 仅 meowSearch（没配模型时的保底）
```

面板显示工具调用轨迹（中文动作名）、等待秒数（模型超时 25 秒后"正在分析…"可能
静止十几秒）、以及**边出边显示的结果卡**。卡片回填**必须用编排结果里模型实际传的
`args.keyword` 对应的 `calls[].data`**，不能用用户原话重搜一遍——多轮里第二句常是
"那就放它吧"，拿它当关键词会搜出无关片；重搜一遍还要再花 4–25 秒。

### 4.3 结果卡片要"可执行"，不是"可阅读"

影片卡（海报+片名+来源数，点击展开）、来源行（源名·集数·健康，带「▶ 播放」）、
动作卡（建议动作直接执行，写操作仍要确认）。★ 片名、源名这些**来自第三方站点的
字符串必须当纯文本渲染，禁止 `v-html`**；送进模型时包在明确分隔里（如 `<<片名>>`）
防提示词注入。

### 4.4 斜杠命令：没配模型也能用的能力面

`commands.ts` 提供 5 个命令：`/搜索`、`/播放`、`/缓存`、`/诊断`、`/日志`
（各带英文别名与全角归一——中文输入法的 `／` U+FF0F 与全角空格必须归一，
否则"明明打了斜杠却没反应"）。设计要点：

- **命令名用中文、参数是人类语言**（"庆余年 第3集"），工具名是给模型看的实现语义
  （`meow_state` 用户手动调没有意义），所以不是把 11 个工具名搬上来
- `llmReady()` 为假时面板走不到编排，命令层是**没装模型的用户**用上诊断/日志的唯一
  路径——确定性、零 token、<1s
- 执行仍调 `tools.ts`，**不写第二套实现**（否则必然与工具/意图分类漂移）
- 工具名→中文动作的 `TOOL_LABEL` 是唯一一份人话命名，编排轨迹与命令回填共用；
  新增工具必须同步，`ai-commands.test.ts` 对照 `TOOL_DEFS` 做门禁

### 4.5 语音：用系统能力，不自己接麦克风

TV/手机的系统输入法本身带语音键，识别质量远好于自建；自建要 `RECORD_AUDIO` 权限
+ ASR 服务 + 费用，收益为负。现状是干净的：TV manifest 只有 `INTERNET` 权限，
前端零 `SpeechRecognition`/`getUserMedia`——**别破坏它**。"一句话播放"里的"一句话"
是用户对着输入法说，前端拿到的就是普通字符串。TV 的软键盘输入链路已打通
（`adjustResize` + 显式 focus），无需新代码。

### 4.6 为什么"播放"必须留一次点击

`requestFullscreen()` 要求**用户激活**（Chrome 窗口约 5 秒），从回车到播出要过
search → detail → play 三次网络往返，很容易超时；自动出声同样要手势。所以 UI 上
必须留这一次点击——它同时解决两个问题，且让"AI 猜错了"的补救成本为零（不点就是）。
兜底已存在：容器全屏被拒自动降级伪全屏（纯 CSS，不需要手势）。

| 端 | 真全屏 | 自动出声 | 结论 |
|---|---|---|---|
| TV | 不需要（原生播放页是全屏 Activity） | 无策略限制 | 全自动 |
| PC | WebView2 通常允许，仍受激活窗口限制 | 一般允许 | 大概率自动 |
| 手机浏览器 | 大概率落伪全屏 | 必须有手势 | 必须点一次 |

---

## 五、模型与编排

### 5.1 落点：客户端，不在后端

用户在哪台设备上说话，模型调用和编排就在哪台设备上发生；后端保持哑 REST，
不知道 AI 存在。四条理由：三端同一份前端，写一次全有；纯本地场景（只挂 U 盘
片库）也要能用；key 是用户配置不是服务配置（放后端等于每个用户必须自建后端才能
用 AI）；证据（`__playerDebug`/`__meowDiag`）在客户端，规则和编排挨着数据放。

```
src/ai/
├── tools.ts        11 个语义工具（包装 src/api/，唯一真源）
├── orchestrate.ts  多轮编排 + 工具 schema（常量见 5.4）
├── summarize.ts    工具结果摘要化（MAX_RESULT_CHARS=2048 兜底截断）
├── llm.ts          OpenAI 兼容调用 + token/超时/重试策略
├── diagnose.ts     诊断规则库 + 输出契约
├── intent.ts       意图分类（规则直通层）
├── prompt.ts       ORCH / DIAG 系统提示词 + PERSONA
├── bridge.ts       外部 MCP 工具桥（window.__meowTool）
└── commands.ts     斜杠命令（数据与解析，不写第二套实现）
```

全部 lazy import：AI 代码不进首屏 chunk，用户不开 AI 就不下载。

### 5.2 出站通道：壳代理为主，relay 兜底

浏览器 `fetch` 直连模型 API 会被 CORS 挡（厂商不返回 CORS 头，是它们的策略）。

| 环境 | 出站路径 |
|---|---|
| PC | 未配壳通道时走 relay；`llm_chat` Tauri command **未实现** |
| TV | 同上走 relay；`TvBridge` llm 方法**未实现** |
| 纯 Web | `/api/llm/relay`（`policy.json` 的 `llmRelay.enabled` **默认 false**，只转发不存 key、不参与编排）或本地 Ollama（`OLLAMA_ORIGINS` 放行跨域） |

relay 转发到**用户自己填的 baseUrl**；服务端校验很薄——只拒非 http(s) 与云元数据
地址（169.254.169.254），回环显式放行（Ollama 是明确场景）。它不是面向外部的开放
代理：端点受 policy 开关控制，且默认关闭。

relay 只做转发：响应原样回传上游 JSON，前端自己解 `choices[0]`。PC/TV 现状都是
"模型调用走 relay"——想摆脱这层依赖需要补壳侧命令，属未落地项。

**key 的安全水位**：★ 不要说"key 不进浏览器存储"——prefs 本身就是 localStorage
（`meow.prefs`），WebDAV 密码同样在那里（`meow.webdav`）。LLM key 与现有凭据是
**同一安全水位**，不是新增风险也没变好；要加固应整体迁移（PC 用 Tauri store、
TV 用 SharedPreferences），不要只给 LLM key 单独上一套。

### 5.3 配置：客户端 prefs，单一开关

字段**平铺**进 `Prefs`（不嵌套成 `llm:{...}`），同时加进 interface 与 DEFAULTS：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `llmEnabled` | `false` | 默认关闭 |
| `llmBaseUrl` / `llmApiKey` / `llmModel` | 空 | 不预填任何厂商——预填会让"没配过"看起来像"配好了但不通" |
| `llmTimeoutMs` | 8000 | 单次解释够用 |
| `llmMaxTokens` | **800** | 300 是"单句解释"的量，装不下编排一轮；老用户存的 300 由编排层下限兜住 |
| `llmHistoryRounds` | 5（0–10） | 历史轮数 |

两个踩过的坑：**迁移/判断必须读 `raw` 不能读合并后的对象**（合并过 DEFAULTS 后
`out.x` 恒有值，`if (out.x === undefined)` 变死代码）；**「启用」必须是唯一开关**——
曾出现设置页开关与后端 `llmRelay.enabled`（默认 false、界面上没地方改）双重开关，
用户打开开关仍报"后端没开模型中转"。现在前端开关一变就自动同步 policy
（`SettingsView` 的 `syncRelaySwitch`，失败不报错——PC/TV 根本用不到 relay 时
同步无意义），policy 字段保留给自建实例强制关闭。

**未配置时面板仍可用**：显示"仅本地判断"徽标，诊断结论照常输出（规则层不依赖
LLM），不要做成"没配 key 就禁用"。

### 5.4 编排常量（`orchestrate.ts`，测试钉住取值）

| 常量 | 值 | 为什么 |
|---|---|---|
| `MAX_ROUNDS` | 8 | 防死循环；正常任务 2–4 轮 |
| `ROUND_TIMEOUT_MS` | 25s | 模型单次调用。8s 是按纯对话估的，没算 function-calling 开销——推理模型首轮读 schema 就容易超，症状是"还在思考却报分析超时" |
| `MODEL_ABORT_MS` | 28s | **必须大于 ROUND_TIMEOUT**：abort 用偏好默认 8000ms 时内层先掐，外层 25s 形同虚设。abort 只在 fetch 卡死时兜底，让外层竞速的错误文案能指明哪一层 |
| `TOOL_TIMEOUT_MS` | 30s | 跨源搜索实测最慢 20s（单站 8s + 并发排队），留 3 倍余量；其余工具毫秒级 |
| `TOTAL_TIMEOUT_MS` | 90s | 必须 >「一次慢工具 + 一次模型往返 + 一次收尾」；正常跑不满，只为兜最坏情况 |
| `KEEP_ROUNDS` | 4 | 历史保留轮数（面板再按偏好 0–10 截断传给编排） |
| `MIN_ROUND_TOKENS` | 1200 | 偏好 maxTokens 太小时编排层的硬下限 |
| `MAX_RESULT_CHARS` | 2048 | 工具结果超长截断并标注 |

**历史只放"用户问 + 最终回答"，不放工具往返**——工具消息带着几十 KB 搜索结果，
塞进历史每轮 prompt 暴涨；上一轮结论已足够支撑追问。裁剪边界**不能写死
`slice(0, 2)`**：第 0 条是 system、后面是历史，必须按 `1 + history.length + 1` 算。

**工具结果必须经 `summarize.ts` 摘要化再喂模型**：搜索前 5 部 × 每部前 3 个源；
play 只回 `{ok, url 是否 http, format, 失败原因}` **不回完整地址**；state 回版本 +
计数 + 降级名单；任意结果超 2KB 截断标注。原始结果直接塞上下文既费钱又抓不住重点。

### 5.5 死循环判定与失败模式

死循环两个维度（只按一个判会漏）：① 同工具 + **同参数**连续 2 次（机械重复）；
② 同工具**连续失败** 2 次（换参数硬试也没用）。实测只按①判时，模型每次重试参数
略有不同、签名全不同，`meow_play` 连试 4 次一路试到轮数耗尽。

| 失败 | 行为 |
|---|---|
| 不存在的工具名 | 回"没有这个工具，可用：…"让它纠正 |
| 参数缺失/类型错 | 回校验错误重试一次，再错放弃 |
| 幻觉片名（search 返回 0） | 直接说"没搜到"，**绝不猜别的片** |
| 死循环 | 终止，给出已有结论 |
| 上下文超限 | 丢最早对话轮，保留 system + 最近几轮 |
| 401/403 | 提示"密钥无效"，**不重试** |
| 429/超时 | 静默降级（返回已有结论，`stopReason` 区分 done/max_rounds/timeout/loop/error，各给对应文案——"试了 8 轮没搞定"不能说成"网络慢"） |

**token 预算的坑**：推理模型（含名字里没有 r1/reasoner 的自建网关模型）会把
maxTokens 全烧在思维链上，`finish_reason=length` 且 content 与 tool_calls 都空。
**不能靠模型名判断**（正则 `REASONING_MODEL_RE` 兜底 token 下限 3000 只是第一层），
真正的判据是 `finish_reason=length` 且两样皆空 → 预算翻 4 倍重试一次（上限 8000）。
这是 `ai-llm-retry.test.ts` 钉住的行为。

### 5.6 提示词：三份，说法定期对齐

`prompt.ts` 的 `ORCH_SYSTEM_PROMPT`（编排）、`DIAG_SYSTEM_PROMPT`（诊断解释）、
`llm.ts` 的 `SYSTEM_PROMPT` 各司其职，**三处说法必须一致，改一处同步三处**。
编排提示词必须包含四块（测试逐个断言）：这是什么应用、术语表（源/线路/jar 站/
drpy/ext/parse/弹幕源）、工具调用原则（含"什么时候不要调 meow_search"的反向约束）、
明确禁止（不编造片名、不说"已帮你切换"除非工具成功、不输出完整 URL）。

`PERSONA` 给的是**身份与边界**，不是让模型演角色：不强行自我介绍（挤掉结论句）、
不卖萌不用表情（可爱腔会污染工具结果的呈现）、只承诺做得到的事（评分/上映日期
不在客户端能力内，直接说查不到）。诊断提示词只借语气不加长——它只需 1–3 句。

### 5.7 四条实现纪律

| 纪律 | 具体 |
|---|---|
| **状态只信工具返回** | UI 任何变化必须由工具执行结果驱动；模型说"已帮你切换"不算数 |
| **写操作要人确认** | `meow_cache_start` 只解析、transcode、disable_source 不由模型自主决定 |
| **无后端要快速降级** | 启动先 `meow_state`；失败则工具集收敛并说明，不让纯本地用户看一串 500 |
| **成本可见** | 编排结果带 `usage`（累计 prompt/completion tokens），量级参考：一次解释几百 in + 一两百 out，一次搜索对话几 k in |

第三条与"写操作一律确认"不冲突：**读操作自由，写操作一律确认**，两条不同的线。

### 5.8 未实现（不阻塞使用）

- **流式输出**：`llm.ts` 里 `stream: false` 硬编码，答案整段跳出（首字 1–3s）。
  要做的话壳代理必须同步支持（OkHttp 逐块读 / Tauri emit），不是前端单方面的事
- **解释缓存**：同一 cause_code + 证据特征可缓存 explanation（key 不含片名/URL，
  localStorage LRU 50 条 / 7 天），只缓存解释不缓存对话——**未实现**
- **Tauri `llm_chat` 与 TV `TvBridge` llm 方法**：未实现，PC/TV 模型调用都走 relay

---

## 六、安全与降级红线

| 红线 | 要求 |
|---|---|
| **默认关闭** | `llmEnabled: false`，没配就不调；不产生意外费用 |
| **失败静默降级** | LLM 超时 / 401 / 限流 → 直接返回规则结论，**绝不阻塞诊断** |
| **出口脱敏** | 发给 LLM 前在客户端替换 prefs 里自己知道的密码；后端日志侧已有 `LogBuffer.scrub()` 把 `url=/token=/password=` 打码 |

★ 还有一层常被忽略的隐私：**片名和源站 URL 本身也是隐私**（能看出用户在看什么）。
默认只发 cause_code + 结构化证据摘要，不发完整 URL；提供"只发本地规则结论"的开关。

---

## 七、三端差异

三端同一份前端，AI 逻辑只有一份；差异全在**出站通道**与**输入方式**。

| 端 | 模型出站 | 输入 |
|---|---|---|
| Web | relay 或本地 Ollama | 输入框 + 系统输入法；桌面 `Ctrl+K` |
| PC | relay（`llm_chat` 未实现） | 同上 |
| TV | relay（TvBridge 方法未实现） | 输入法含语音转文字；差异只有焦点环与触控目标尺寸；长对话用 `#/ai` 独立页 |

TV 的 `DebugServer` 绑 `0.0.0.0` 带 token，那是给**外部 AI 客户端**的通道，与应用内
AI 无关。老内核（Chrome 66）上 `fetch` 可用，注意 `AbortController` 行为；AI 模块
不要用可选链以外的 ES2020+ 语法。独立页高度写 `100vh` 与 `100dvh` 两遍——`dvh`
只有 Chrome 108+ 认，老内核丢掉声明退回 vh，只用 dvh 会塌成内容高度（实测 167px）。

---

## 八、明确不做的

| 想法 | 为什么 |
|---|---|
| 自然语言找片（"找个下饭的喜剧"） | 源是**关键词搜索**不是语义检索；LLM 只能翻成关键词，翻了也搜不到。泛化需求走追问 |
| AI 推荐 / 猜你喜欢 | 没有行为数据，冷启动无解 |
| AI 生成弹幕 / 评论 | 污染弹幕生态 |
| AI 总结剧情 | 片源是盗链，无字幕轨可读 |
| 内嵌本地大模型 | 投影仪 4GB 内存、后端 `-Xmx512m` 跑不动；本地 Ollama 走 HTTP 可行 |
| AI 直接改配置 / 删缓存 | 破坏性，出问题难回溯；AI 只读 + 建议，写操作一律用户点确认 |
| 为"看起来智能"而调模型 | 规则已能说人话，LLM 只在主因判断/长尾/追问三件事上有增量 |

---

## 相关

- 工具包装的端点契约：[API 契约](./api-contract.md)
- `meow_state` 读到的健康/降级语义：[架构](./architecture.md)
- 诊断数据源：播放器与错误页（[播放](./playback.md)）、日志缓冲与 `scrub`
- 外部 MCP 的宿主侧实现：[TV 接入](./tv-integration.md)（DebugServer）、
  PC 桌面端 MCP（`mcp.rs`，见仓库 `client/apps/desktop`）
- 面板消息与缓存确认卡：[本地缓存](./library-cache.md)
