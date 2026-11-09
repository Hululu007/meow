# Web / PC 前端施工手册

> 版本：v1（2026-10-21）
> 定位：**前端改造的唯一施工依据**。本文替代已作废的 `docs/22`。
> 配套：`docs/26`（API 契约）、`docs/25`（架构）。
> 适用：`client/apps/web/src`，80 个 `.vue/.ts`，约 36,600 行（2026-11-04 核对）。

---

## 第零章 铁律（改之前必读）

### 0.1 已经定型的决策 —— 不要回退

以下每一项都是**实测对比后的最终方案**，改动前必须给出量化证据。

| # | 决策 | 为什么 | 证据 |
|---|---|---|---|
| **R1** | **弹幕用 Canvas + 文字位图缓存**，不用 DOM | DOM 走 180~200 节点时 45fps/8 长帧（"卡成 PPT"）；Canvas fillText 53fps；**位图缓存 60.3fps/0 长帧/最大间隔 16.9ms** | `danmaku.ts` 头注释 |
| **R2** | **弹幕位置完全由视频时间计算**，不用 CSS transition | 暂停/倍速/拖动自动同步，不会"先飞一段" | 同上 |
| **R3** | **DPR 上限 1.5** | DPR=2 时画布 2160×1350，帧率掉到 45fps 以下 | 实测 |
| **R4** | **不用 ofetch，用原生 fetch** | ofetch 在 Tauri 下访问 `location[0]` 抛 `Cannot read properties of undefined` | `api/index.ts:48` |
| **R5** | **倍速用自研 `RateSelect.vue`**，不用原生 `<select>` | 原生下拉由浏览器绘制、**永远向下弹**，控制栏在底部会被裁掉 | 实测 |
| **R6** | **设置项一律用 `TileSelect.vue`（下拉）**，不做点击循环 | 用户明确要求："选项多时点击循环太繁琐" | 用户反馈 |
| **R7** | **路由用 hash 模式** | Tauri 打包后加载 `file://`，history 模式会 404 | `router/index.ts` |
| **R8** | **vue-router 不要手动 `encodeURIComponent`** | router 自己会编码，手动会变 `%253A` 双重编码 | 实测 |
| **R9** | **Teleport + Vue `<Transition>` 不用**（菜单类） | 过渡类不会被移除，菜单停在 `opacity: 0`。改用 `@keyframes` + **非 scoped** style | 实测 |
| **R10** | **判断桌面端用 `'__TAURI_INTERNALS__' in window`** | Tauri 在 Windows 上是 `http://tauri.localhost`，**不是** `tauri://` | 实测 |
| **R11** | **WebDAV 必须走后端代理** | 浏览器直连被 CORS 挡；MKCOL/PUT 预检多数服务器不支持 | 实测 |
| **R12** | **首页不做胶囊磁贴** | 用户明确要求删除，布局以用户截图为准 | 用户反馈 |
| **R13** | **控件要么有真实行为，要么删掉** | 留了开关却没有逻辑读取会被一眼看穿（WebDAV 启用开关曾是空壳） | 用户反馈 |
| **R14** | **设置按数据语义分两类**：`account.*` 需同步 / `device.*` 仅本地 | 有状态的要版本化快照，流水数据只要并集 | 用户明确。**⚠️ 尚未实现**：`prefs.ts` 现有 12 个扁平键（`homeCols`/`danmaku*`/`autoNext`/`searchThreads`/`cacheDays`/`historyLimit`），`grep account\.\|device\.` 命中 **0**。这是 [目标] 要求，不是现状 |
| **R15** | **历史记录合并时，空字符串不能覆盖已有展示字段** | `{...prev, ...next}` 会让后一次 push 的空 `vod_pic` 抹掉已存好的封面，表现为「偶尔看不到海报」，而且是**点开一次变空一次** | 实测：本机 10 条历史 `vod_pic` 全空，而同一部片 detail 明明有图 |
| **R16** | **移动端（<640px）只加 `max-sm:` / `@media (max-width:639px)`，不改写桌面默认值** | 桌面与 TV 共用一套模板；TV 的 CSS 视口实测 1138×640，永远在 ≥640 一侧。用 `sm:` 反向覆盖会把 TV/PC 的默认值一起改掉 | `tests/mobile-layout.test.ts` |

### 0.2 三条工程约束

1. **不擅自打包 PC**。日常验证一律走 Web（`pnpm --filter @meow/web dev`）。打包必须等用户开口。
2. **不常驻 9979**。需要后端时临时启动，验完即停。
3. **不臆造后端能力**。先读 `GET /api/health` 的 `capabilities`，没有就降级（见 `docs/26` §9.2）。

---

## 第一章 现状地图

### 1.1 目录与文件

```
apps/web/src/
├── api/
│   ├── index.ts         1107 行  HTTP 封装 + 所有端点函数
│   ├── library.ts        片库/缓存/转码
│   ├── health.ts         站点健康探活/降权
│   ├── logs.ts           运行日志
│   ├── nativeBridge.ts   TV 原生桥（SAF 保存 / ExoPlayer）
│   ├── playExtras.ts     skips/subs/position 毫秒→秒换算 + SRT/ASS→VTT
│   └── types.ts          120 行  返回类型
├── components/
│   ├── common/
│   │   ├── PosterCard.vue        海报卡
│   │   ├── TilePanel.vue         设置卡片容器
│   │   ├── TileSelect.vue        ★ 下拉选择器（R6）
│   │   └── tile.ts               磁贴工具
│   ├── layout/AppHeader.vue      顶栏（12 处响应式断点类）
│   ├── library/
│   │   └── CachePanel.vue        ★ 「我的缓存」列表（片库页与 /offline 共用）
│   └── player/
│       ├── VideoPlayer.vue 3738 行  ★ 播放器核心
│       ├── danmaku.ts      1139 行  ★ 弹幕引擎（R1-R3）
│       ├── danmakuStore.ts        IndexedDB 弹幕缓存（断网可看）
│       └── RateSelect.vue   153 行  自研倍速（R5）
├── stores/          11 个
│   ├── app.ts         88 行   站点列表 / 当前站点 / 在线状态
│   ├── prefs.ts      511 行   设置（含 WebDAV 配置）
│   ├── history.ts    276 行   观看历史 + 续播进度
│   ├── sync.ts       508 行   WebDAV 同步
│   ├── theme.ts      424 行   主题 / 壁纸
│   ├── favorites.ts  166 行   收藏（本地优先，后端只作同步通道）
│   ├── favUpdates.ts 131 行   收藏跨端事件的派发/订阅（防自激循环）
│   ├── searchHistory.ts  75 行 搜索历史
│   ├── skipMarks.ts  102 行   自定义片头/片尾（按片记，不进 prefs/history）
│   ├── linePref.ts    74 行   线路偏好（按片记）
│   └── watchStats.ts 136 行   观看统计
├── views/           14 个路由视图（含 LogsView、OfflineView；后者只剩薄壳）
└── tests/           16 个文件 / 283 用例
    ├── danmaku.test.ts  查 debugActive() 而非 DOM
    └── sync.test.ts
```

> 行数/用例数实测于 2026-10-26（`npx vitest run` → 16 files / 283 passed）。
> 加新文件/新 store 时同步更新这里，别让它变成"看一眼就知道过期"的表。

### 1.2 路由表

| 路径 | 视图 | 说明 |
|---|---|---|
| `/` | `HomeView` | 首页（Tab + 海报网格 + 首屏 3 行 + 触底预加载 900px） |
| `/category/:site` | `CategoryView` | 分类（分页 `page/pagecount` + 筛选 + 硬上限 50 页） |
| `/detail/:site/:id` | `DetailView` | 详情（多线路 + 剧集网格 + 收藏 + 缓存整季） |
| `/play/:site` | `PlayView` | 播放（query 携带 flag/id/name/ep/list） |
| `/search` | `SearchView` | 聚合搜索（左侧源筛选 + 命中数） |
| `/history` | `HistoryView` | 历史 |
| `/live` | `LiveView` | 直播（分组侧栏 + 频道格 + hls.js） |
| `/library` | `LibraryView` | 本地 / NAS 片库（根层级带「我的缓存」分区） |
| `/library/add` | `LibraryAddView` | 添加片库（WebDAV / SMB / 本地目录） |
| `/offline` | `OfflineView` | 薄壳（`CachePanel`），兼容旧书签与深链 |
| `/favorites` | `FavoritesView` | 收藏 |
| `/settings` | `SettingsView` | 设置（8 个分区 + PC 专属「本机插件」） |
| `/logs` | `LogsView` | 运行日志（服务端 + 客户端同屏） |

> 路由是 **hash 模式**（`createWebHashHistory`），深链必须写 `/#/xxx`。

---

## 第二章 改造清单（按依赖排序）

### 2.1 P0：必须先做的四件事

#### F-A `apiBase` 单值 → 多后端列表

**现状**（`api/index.ts:resolveBase()`）：返回单一字符串，`prefs` 里也只存一个。

**目标**：
```ts
interface Backend {
  id: string
  name: string
  url: string
  enabled: boolean
}
// prefs.backends: Backend[]
// prefs.activeBackend: string
```

**改造点**：
1. `prefs.ts` 加 `backends: Backend[]` 与 `activeBackend: string`，**迁移旧值**（`apiBase` 字符串 → 单元素数组）
2. `request()` 的 base 改为读 `activeBackend`
3. `SettingsView` 加"后端"卡片：列表 + 增删 + 切换 + 测试连接
4. 切换后端后**必须重新 `store.boot()`**（站点列表整体换）

**验收**：能配两个后端，切换后首页站点列表随之变化。

---

#### F-B 能力探测 + 降级

**新增** `stores/caps.ts`：
```ts
export const useCapsStore = defineStore('caps', {
  state: () => ({ set: new Set<string>(), version: '', sites: 0 }),
  actions: {
    async load() {
      const h = await request<Health>('/api/health')
      this.set = new Set(h.capabilities ?? [])
      this.version = h.version ?? ''
      this.sites = h.sites ?? 0
    },
    has(cap: string) { return this.set.has(cap) },
  },
})
```

**降级点**（对应 `docs/26` §9.2）：

| 能力 | 缺失时的 UI |
|---|---|
| `parse` | 播放失败不显示"自动解析"按钮，直接提示换源 |
| `live` | 顶栏不显示"直播" |
| `progress` | 不显示续播提示，进度只存 localStorage |
| `favorites` | 收藏按钮置灰 + tooltip |
| `state` | 设置页不显示"已同步"状态 |

**注意**：老后端没有 `capabilities` 字段 → 视为空集合（全降级），但**保留本地功能**。

---

#### F-C 详情页传全部线路

**现状**（`DetailView.vue:41-52`）：只传当前选中的 `line`。
```ts
list: JSON.stringify(line?.episodes || [])   // ← 只有一条线路
```

**目标**：
```ts
query: {
  flag: line?.name || '',
  id: ep.url,
  name: item.value?.vod_name || '',
  ep: ep.name,
  line: String(activeLine.value),
  lines: JSON.stringify(lines.value),   // ← 全部线路
}
```

`PlayView` 侧：
```ts
const allLines = parseLines(route.query.lines)   // [{name, episodes:[{name,url}]}]
const activeLine = Number(route.query.line ?? 0)
```

**为什么必须改**：失败重试链的第 3 跳是"换同站另一条线路"。
现在 `PlayView` 手里没有其他线路，做不到。

**兼容**：同时保留旧 `list` 字段（老链接仍可用），`lines` 优先。

---

#### F-D 失败重试链

**现状**（`PlayView.vue:88-100`）：
```ts
if (!r.url) error.value = r.msg || '未获取到播放地址（可能该线路需要解析器 parse=1）'
```
**诊断出了原因，然后什么都不做。**

**目标状态机**：

```
IDLE
  ↓ 用户点播放
ATTEMPT_LINE(lineIdx)            ① 当前线路当前集
  ↓ 失败
ATTEMPT_NEXT_EP                  ② 同线路下一集（仅当 url 为空时跳过）
  ↓ 失败
ATTEMPT_NEXT_LINE                ③ 同站下一条线路（需 F-C）
  ↓ 失败（且 parse===1 或 needsParser）
ATTEMPT_PARSE                    ④ POST /api/parse
  ↓ 失败
ATTEMPT_OTHER_SITE               ⑤ POST /api/search 同名片 → 取第一个其他站 → 重走 ①
  ↓ 失败
FAILED(记录全部尝试)
```

**实现要点**：

```ts
type Attempt = {
  kind: 'line' | 'nextEp' | 'nextLine' | 'parse' | 'otherSite'
  site: string
  flag: string
  id: string
  ok: boolean
  reason?: string
  elapsedMs: number
}

const attempts = ref<Attempt[]>([])
```

1. **每次尝试都要记 `attempts`**，最终失败时展示给用户（可复制）
2. **不要静默重试**：UI 上显示"正在尝试第 2 个来源（共 5 个）"
3. **总超时 60s**，超过则停止
4. **切站时 `name` 要保留**（用片名搜索）
5. **parse 成功后把结果当成新 url 继续**，不要重新走 ①

**验收**：构造 20 个失败场景，≥60% 能在 3 跳内播上（`docs/25` V2）。

---

### 2.2 P1：能力补齐

#### F-E 进度续播

**改动**：
1. `history.ts` 的 `HistoryItem` 加 `position?: number`、`duration?: number`
2. `PlayView` 的 `timeupdate` 节流写入（≥5s 或 `pause`/`beforeunload`）
3. 进播放页时若 `position > 5 && position < duration - 10` → `seek`
4. **后端有 `progress` 能力时优先后端**，否则本地

**注意**：`timeupdate` 只有 4Hz，节流用时间戳比较，不要用定时器。

---

#### F-F 收藏

1. 新建 `stores/favorites.ts`（同构于 `history.ts`）
2. `PosterCard` 加收藏角标
3. `DetailView` 加收藏按钮
4. `prefs.ts` 的备份结构加 `favorites` 字段
5. 后端有 `favorites` 能力时用后端

---

#### F-G 字幕轨（外部 `subs`）

**现状**：`VideoPlayer.vue:240-251` 只处理 HLS 内嵌字幕轨。

**目标**：在 `<video>` 里追加 `<track>` 元素：

```ts
watch(() => props.subs, (subs) => {
  videoEl.querySelectorAll('track[data-ext]').forEach(t => t.remove())
  for (const s of subs ?? []) {
    const t = document.createElement('track')
    t.kind = 'subtitles'
    t.src = proxyStream(s.url, playHeaders)
    t.srclang = s.lang || 'zh'
    t.label = s.name || '字幕'
    t.dataset.ext = '1'
    // flag: 0=普通 1=默认选中 2=强制
    if (s.flag === 1 || s.flag === 2) t.default = true
    videoEl.appendChild(t)
  }
})
```

**注意**：`<track>` 的 `src` 也可能需要代理（防盗链），统一走 `/api/proxy/stream`。

---

#### F-H 片头尾跳过（`skips`）

```ts
// 单位：毫秒 → 秒
watch(currentTime, (t) => {
  if (!skips?.length || skipSuppressed.value) return
  const ms = t * 1000
  for (const s of skips) {
    if (Math.abs(ms - s.start) < 1000) {      // 在 start 附近
      if (s.type === 'intro' && s.end) {
        seek(s.end / 1000)
        toast(`已跳过片头 ${Math.round((s.end - s.start) / 1000)} 秒`)
      } else if (s.type === 'ending' && !s.end) {
        showSkipPrompt('已到片尾，是否继续？')   // ← 不要自动停
      }
      break
    }
  }
})
```

**三条约束**（学影视仓的"宽容跳过"）：
1. **只在 start ±1s 内触发**，避免拖动时误跳
2. **给 3 秒可撤销提示**（`toast` + 撤销按钮）
3. **片尾不自动停**，只提示（影视仓有 `触发误操作` 的兜底文案，说明误判是常态）

---

#### F-I 多画质选择

`play.urls` 存在时，控制栏显示画质下拉（复用 `TileSelect`），切换时 `reload(url)`。

**注意**：切换画质**保留 position**（记录当前 `currentTime`，新源 seek 回去）。

---

#### F-J 音轨切换

hls.js 的 `audioTracks`：

```ts
hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_, data) => {
  audioTracks.value = data.audioTracks.map((t, i) => ({ index: i, label: t.name || t.lang }))
})
function setAudioTrack(i: number) { hls.audioTrack = i }
```

**只在 `audioTracks.length > 1` 时显示**（学影视仓的 `没有音轨` 处理）。

---

#### F-K 弹幕请求代际控制

**现状**：`danmaku.ts` 只有 `cancelAnimationFrame`（动画帧），**没有请求取消**。

**问题**：连点下一集，5 个请求并发，谁先回来谁先渲染。

**修法**（学 Fongmi `DanmakuApi` 的 `REQUEST_ID`）：
```ts
let reqGen = 0
let abort: AbortController | null = null

async function load(text: string) {
  const gen = ++reqGen
  abort?.abort()
  abort = new AbortController()
  const xml = await fetch(url, { signal: abort.signal }).then(r => r.text())
  if (gen !== reqGen) return          // ← 丢弃过期结果
  engine.load(xml)
}
```

---

### 2.3 P2：可选

| 项 | 说明 |
|---|---|
| **F-L PC 外挂播放器** | Tauri `spawn` 调 VLC/MPV；自动探测安装路径（学 FreeBox） |
| **F-M PC sidecar** | Tauri 起 JVM 子进程；jar 运行时拉取（**不内置**） |
| **F-N 直播页** | M3U + XMLTV 只读，不做回看 |
| **F-O 手机遥控 PC** | JSON-RPC over HTTP（学 Kodi），复用 `fm.stat()` 的状态结构 |

---

## 第三章 关键实现细节

### 3.1 弹幕引擎（不要改的部分）

**文件**：`components/player/danmaku.ts`（1139 行，实测 2026-10-24）

**核心不变量**：

| 项 | 值 | 位置 |
|---|---|---|
| 文字位图缓存键 | `${fontSize}|${color}|${text}` | `makeSprite()` |
| 缓存上限 | 600 条（LRU） | — |
| sprite 宽度**必须含 padding**（左右各 4px） | 否则 `drawImage` 拉伸文字 | — |
| DPR 上限 | 1.5 | — |
| 在场上限 | `MAX_ACTIVE = 120` | 超出丢弃新弹幕 |
| 位置公式 | `x = W - p * (W + width)`，`p = (now - born) / duration` | — |
| rAF 插值 | 最后权威时间 + 真实流逝 × rate，最多超前 0.4s | — |
| 跳转判定 | 首次 / 后退 >0.3s / 前进 >1.5s | 跳转只补最近 3 秒 |
| jsdom 降级 | `getContext('2d') || nullCtx()` | 让 11 个单测能跑 |

**测试**：`tests/danmaku.test.ts` 查 `debugActive()` 而非 DOM 节点。
**改弹幕引擎后必须跑**：`cd client/apps/web && npx vitest run`。

---

### 3.1.1 TV WebView 性能：实测基线与优化清单（2026-11-02）

**为什么要写这一节**：用户问「TV WebView 怎么优化能达到原生效果」。
先给结论——**当前已经接近 WebView 能到的上限**，剩下的差距主要在解码
与输入延迟，不在渲染。下面是 MuMu（Android 15 / WebView 110 /
1920×1080 CSS 视口 1138×640）的实测数据，可直接当回归基线。

| 场景 | p50 | p95 | max | 长帧(>32ms) | 帧率 |
|---|---|---|---|---|---|
| 首页快速移焦 20 次 | 16.7ms | 17.2ms | 17.4ms | 0 | 60fps |
| 首页连续下滚 25 次 | 16.6ms | 19.9ms | 32ms | 0 | 60fps |
| 视频播放（无弹幕） | 16.7ms | 17.1ms | 19.6ms | 0 | 60fps |
| **视频播放 + 15171 条弹幕**（同屏 29 条） | 16.7ms | 17.1ms | 21.2ms | 0 | 60fps |

首屏：`domInteractive 60ms / FCP 120ms / load 123ms`；
DOM 节点 372 个；运行中的无限动画 **0 个**（20 个 `fade-up` 都是一次性 0.35s）；
`backdrop-filter` 0 个；JS 堆 10MB / 上限 1078MB。

**已落地的优化（`MainActivity` + `tokens.css`）**：

| 设置 | 作用 | 副作用 |
|---|---|---|
| `LAYER_TYPE_HARDWARE` | 整页 GPU 合成；盒子 CPU 弱，软件合成 1080p 直接 20fps | 无 |
| `setOffscreenPreRaster(true)` | 屏幕外图块预光栅化；遥控器"跳一段"时不闪空白 | 内存略增 |
| `setTextZoom(100)` | 钉死字号缩放；部分固件默认 130% 会让整站错位 | 无 |
| `setRendererPriorityPolicy(IMPORTANT)` | 渲染进程别被系统优先杀（TV 内存小） | 无 |
| `LOAD_DEFAULT` | **必须**，见 §5.6（`LOAD_CACHE_ELSE_NETWORK` 会缓存 API） | — |
| `scroll-behavior:auto` | 关掉平滑滚动动画（盒子 60fps 保不住，观感"卡着挪"） | 无 |
| `overscroll-behavior:none` | 关掉滚到底的橡皮筋（纯掉帧源） | 无 |
| `text-rendering:optimizeSpeed` | 关连字/精细 kerning；中文无连字，收益为负 | 无 |
| `img { decoding: async }` | 海报墙一次铺 24 张图，异步解码避免"先白后闪" | 无 |
| `-webkit-tap-highlight-color: transparent` | 去掉部分固件的蓝色 tap 高亮（与焦点环叠加） | 无 |

**还能再压的三件事（按收益排序，均未做）**：

1. **弹幕 sprite 缓存预热**。当前 `makeSprite()` 是首次出现才画位图，
   片头弹幕密集时会有几十毫秒的集中开销。可在 `parseDanmakuXml` 之后
   按出现时间分片预热前 3 秒的字模（收益约 5–10ms，只在片头可见）。
2. **海报懒加载的 `rootMargin` 收紧**。现在 `loading="lazy"` 由浏览器
   决定触发距离，快速下滚时会连拉 3–4 屏的图。改成 IntersectionObserver
   + `rootMargin: '200px'` 可以少拉一半请求（首屏不受影响）。
3. **播放页的 DOM 精简**。播放页挂载了 6 个 `v-if` 浮层（选集/线路/
   弹幕/更多/快捷键/弹幕搜索），全部一次性渲染进树。改成 `v-if` 外提
   到 `<Teleport>` 或按需 `defineAsyncComponent` 可少约 90 个节点
   —— 但当前 372 个节点远未到瓶颈，收益有限，优先级最低。

**明确做不到的（不是优化问题，是 WebView 的物理边界）**：

- **首帧解码延迟**：WebView 走 `MediaCodec` 转 surface，ExoPlayer 直接
  喂 surface，起播快 100–300ms。这是 §`NativePlayerActivity` 存在的理由。
- **遥控器按键延迟**：Android `KeyEvent → WebView → JS → DOM` 有固定
  约 30–60ms 的跨进程链路。原生 View 是 10–20ms。**只能靠减少每帧工作量
  间接改善**（已做到：每次按键只改一个 class + 一次 `scrollIntoView`）。
- **弹幕 canvas 的合成层级**：WebView 里 canvas 与 video 是两张独立层，
  盒子 GPU 弱时叠加会有轻微撕裂；原生播放器可以把弹幕直接画进
  surface（这也是"原生播放器"路线的另一个卖点）。

---

### 3.2 播放器（VideoPlayer.vue）

**hls.js 配置（已调优，勿改）**：
```ts
maxBufferLength: 60
maxMaxBufferLength: 120
maxBufferSize: 60 * 1024 * 1024
fragLoadingMaxRetry: 6
// NETWORK_ERROR → hls.startLoad()
// MEDIA_ERROR   → hls.recoverMediaError()
```

**`[目标]` 增加错误分档**（学 Fongmi `ErrorAction`）：

| 现状 | 目标 |
|---|---|
| `NETWORK_ERROR → startLoad()` | `RECOVERED` |
| `MEDIA_ERROR → recoverMediaError()` | `DECODE` |
| 无 | **`REFRESH`（换源）** ← 新增，通知 `PlayView` 触发重试链 |
| 无 | `FATAL`（彻底失败） |

**实现**：`VideoPlayer` 通过 `emit('fatal', {kind, message})` 通知父组件。

---

### 3.3 设置页（SettingsView.vue）

**9 个分区（2026-10-30 定稿）**：

| 分区 | 一句话 |
|---|---|
| 连接 | 连不上后端怎么办（地址、令牌） |
| 本机插件（PC）/ 本机执行（TV）/ 远程调试（原生壳） | 平台专属 |
| 搜索与源 | 搜不到 / 源不对怎么办 |
| 播放 | 画面、连播、片头片尾 |
| 弹幕 | 弹幕长什么样、从哪来 |
| 外观 | 换皮肤、换列表密度 |
| 存储 | 空间不够（离线缓存 + 观看记录） |
| WebDAV | 多端同步 |
| AI | AI 配置 |
| 维护 | 网络解析（DNS）、应用更新、备份与诊断 |

**划分依据是「用户想做什么」，不是「技术上属于哪个模块」**。
这条不能反过来：2026-10-30 之前按模块划分，导致「某部剧搜不到」要在
网络 / 浏览与搜索 / 数据与维护三个区之间跳，用户原话「过于分散，让人摸不到头脑」。

**必须遵守**：
- 所有选项用 `TileSelect`（R6）；设置页禁用原生 `<select>`
  （深色主题下弹系统白底，高度/圆角也与磁贴不一致）—— 门禁 `settings-controls-consistency.test.ts`
- 每个控件必须有真实行为（R13）
- `NAV_ITEMS` 顺序必须与模板 `<section>` 顺序一致、label 与 `<h2 class="set-title">`
  一字不差 —— `onScrollSpy()` 按表顺序判断高亮，错了会「滚到 A 区亮 B 区」
  —— 门禁 `settings-nav-sync.test.ts`
- 归属已定的控件不许挪：缓存三档/搜索参数在「搜索与源」、DNS 在「维护」、
  列数在「外观」、历史条数在「存储」、本地弹幕在「弹幕」
  —— 门禁 `settings-controls-consistency.test.ts` 的「设置页分区归属」

---

### 3.4 代理与图片

**图片**（`vod_pic` 可能带内嵌 header）：

```ts
function posterUrl(pic?: string) {
  if (!pic) return ''
  // 形如 https://x.jpg@Referer=...@User-Agent=...
  if (pic.includes('@Referer=') || pic.includes('@User-Agent=')) {
    return proxyImage(pic)     // 后端会解析内嵌 header
  }
  return pic
}
```

**视频**：`proxyStream(url, headers)`，已支持 Range。

---

## 第四章 测试与验收

### 4.1 现有测试

```bash
cd client/apps/web && npx vitest run   # danmaku 11 个 + sync
```

**必须保持通过**。新增逻辑建议补测：
- `parsePlayLines` 的边界（名称含 `$`、url 含 `#`）
- 重试链状态机（可用 mock fetch）

### 4.2 验收方式（用户约定）

**一律 Web 场景验证，不打包 PC。**

```bash
# 1. 后端（临时启动，验完即停）
cd server/host && run.bat

# 2. 前端
cd client/apps/web && pnpm dev

# 3. 用 Edge app 窗口验收（CDP）
CDP_URL_FILTER="localhost:5173" node client/apps/desktop/cdp.mjs shot
```

**注意**：Edge 装了扩展会挤掉 app target，需 `--disable-extensions --no-first-run`
+ 独立 `--user-data-dir`。

### 4.3 UI 验收清单

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 首页 | 站点列表带健康状态；`Bili` 显示 6 个入口 |
| 2 | 搜索 | 显示源筛选 + 命中数；失效站不参与 |
| 3 | 播放 | 失败时有"正在尝试第 N 个来源"进度 |
| 4 | 续播 | 关闭再打开，进度误差 < 5s |
| 5 | 弹幕 | 60fps（用 `debugActive()` + DevTools Performance 核对） |
| 6 | 设置 | 所有控件有真实行为；无装饰性开关 |

---

## 第五章 常见坑（前端专项）

| # | 坑 | 解法 |
|---|---|---|
| 1 | **`location.hash` 里带 `#/detail/...` 被 Git Bash 当路径转换** | 用 `location.hash = '#/...'` 赋值，不要拼进命令行 |
| 2 | **vue-router 自动编码 query** | 不要手动 `encodeURIComponent`；读取端用 `safeDecode()` 兜底 |
| 3 | **CDP 截图与 DOM 不一致** | 先 `getComputedStyle` 核对；不一致时承认局限，不要按截图改代码 |
| 4 | **jsdom 无 canvas 2d** | 弹幕引擎构造器已降级 `nullCtx()`，测试查 `debugActive()` |
| 5 | **Tauri 图标不跟随 `web/public`** | 跑 `npx tauri icon "<绝对路径>"`（相对路径报 os error 3），并更新 `bundle.icon` |
| 6 | **Edge 扩展挤掉 CDP target** | `location.reload()` 后 9222 可能只剩扩展页，用独立 profile |
| 7 | **`m3u8` 相对 URI 以 `/` 开头** | 后端已处理（`ApiServer.java:896`），前端不要二次拼接 |
| 8 | **设置项写进 prefs 但没人读** | R13：要么接逻辑，要么删掉 |
| 9 | **历史记录海报"偶尔"消失** | R15 + §5.2：空值覆盖 + 缺补图回源 |
| 10 | **TV 控制栏收起后按键"死"了** | §5.3：`opacity` 不遗传，必须 `visibility` |
| 11 | **切集/换线路后旧片音轨还在响** | §5.4：只 `hls.destroy()` 不够，要 `stopMedia()` |
| 12 | **观看时长永远统计成 0** | §5.5：别用 `pos` 差值，按墙钟累计 |
| 13 | **弹幕搜索永远只返回 1 条** | §5.6：WebView 缓存了 API 响应 |
| 14 | **TV 弹框超出屏幕且滚不动** | §5.7：必须限高 + `data-tv-scroll` |
| 15 | **横向按键跳到上方同类元素** | §5.8：加"同行优先"一轮 |

### 5.3 TV 控制栏：为什么必须 `visibility:hidden`，不能只有 `opacity:0`（2026-11-02）

用户报「TV 偶尔按向下键唤不出控制栏，只能靠 ok/返回引起的暂停把它顶出来」。
查了四轮才定位，根因是两个层次叠在一起：

**① `opacity` 不遗传给子元素。** 控制栏外壳写 `opacity-0`，但里面的每个
`<button>` 自己的 `computed opacity` 仍是 `1`。tv-nav 的 `visible()` 判的就是
**元素自己**的 computed style，于是这排隐形按钮照样进候选集。

**② tv-nav 用裸 `querySelector('.meow-tv-focus')` 判断"要不要把方向键转给播放器"。**
只要 `.meow-tv-focus` 还挂在任何一个元素上（包括已经隐形、已经 `display:none`
的残留），壳就认为"用户正在移焦点"，把 ArrowDown 全部吃掉 —— 播放器
永远收不到唤出控制栏的那个键。

两条都修才算修好：
- 控制栏外壳用 `invisible opacity-0`（`visibility` **会**遗传，子元素的
  computed 也是 `hidden`）
- tv-nav 新增 `markedEl()`：遍历全部 `.meow-tv-focus`，只认**真正可见**
  （尺寸 ≥2、非 hidden、非 none）的那个；播放器的 `hasTvFocus` 同判据

门禁：`tests/tv-nav-dispatch.test.ts` 把真实 `tv-nav.js` 加载进 jsdom，
断言"残留焦点框在不可见元素上时，ArrowDown 仍然被派发到页面"。

**TV 上不渲染左上角返回按钮**：那个按钮是几何选焦的头号命中目标，按 ok
会直接退出整集。遥控器本身有返回键（`__meowTvConsumeBack` 两段语义），
页头按钮在电视上没有额外价值。`v-if="!isTvEnv()"`。

**播放页返回键语义（2026-11-03 用户定稿）**：分层退出——
弹幕搜索弹框 → 伪全屏 → 选集/线路/弹幕/更多面板（关闭时顺带收控制栏）→ 控制栏；
全都没显示时，第一次返回**只弹「再按一次返回退出播放」提示——不暂停、不唤控制栏**，
提示在屏的 2.5 秒内再按才交给壳退出。原来的"第一次 = 暂停 + 提示"已删：
暂停和"想退出"无关，用户看到的是"按了返回画面却定格"。
判据是"提示是否还在屏上"，不是按的次数——按慢了就重新提示，不会误退出。
倒计时进行中返回 = 立即跳过片头/片尾（优先级高于两段退出）。

### 5.4 切集/换线路/返回重播后"旧片声音 + 新片画面"（2026-11-02）

三条路径，同一条根因：**媒体元素没有真正停掉就被丢下了**。

| 路径 | 机制 |
|---|---|
| 切下一集 | 播放页模板第一条是 `v-if="loading"`，`loading=true` 把 VideoPlayer 整个卸载 |
| 切线路 | 同一个 `<video>` 元素换源 |
| 返回后重新播放 | 旧页面销毁 → 新页面挂一个新 `<video>` |

Chromium 对**带 MediaSource 的媒体元素**有个行为：元素从文档里摘掉后
不一定立刻停播（规范要求"等到稳定状态再暂停"，Android WebView 经常等不到）。
`hls.destroy()` 只是解绑 MSE、不再喂分片，**已缓冲的那段会继续播到末尾**。

统一解法 `stopMedia()`，三步缺一不可：

```ts
v.muted = true            // 立刻听不到
v.pause()
v.removeAttribute('src')  // 丢弃 MSE 引用
v.load()                  // 让解码管线收尾（只摘 src 不 load 仍可能出声）
```

调用点：`setupSource()` 开头（换源）、`onBeforeUnmount`（切集）、
TV 返回键第二次（即将 goBack）。

★ 换源后要立刻按用户偏好恢复音量（`v.volume = volume.value`），
否则 `stopMedia` 的静音会把新源也弄哑。

★ `stopMedia` 里的 `load()` 会派发一次 `durationchange`（duration=NaN）。
`onLoaded` 必须挡掉 `Number.isNaN(v.duration)`，否则时长被清零、续播点丢失。
判据只能用 duration —— **hls.js 走 MSE，`src` 属性始终为空、`currentSrc` 是 `blob:`**，
按 src 判会把正常起播也挡掉（踩过）。

### 5.5 观看时长统计：不能用 `pos` 差值（2026-11-02，第三次修）

用户连报三次「历史页无法统计播放时长」。前两次都在改 `addWatchTime` 的
小数累积，方向错了 —— 真正的洞在**上游门禁**：

```ts
// 错：进度心跳本来就是 5 秒一次（onTimeUpdate 里 `>= 5` 才发），
// 所以 pos 差恒为 5.0~5.3，而门禁是 `delta <= 5` → 几乎每条都被当成 seek 丢掉
const delta = p.pos - lastTickPos
if (delta > 0 && delta <= 5) addWatchTime(delta)
```

现在改成**播放器自己按墙钟累计** `watchedSec`，随 `progress` 一起发 `watched`：

```ts
// VideoPlayer.onTimeUpdate —— 三条判据缺一不可
if (!v.paused && !v.seeking && watchedTickAt) {
  const dt = (performance.now() - watchedTickAt) / 1000
  if (dt > 0 && dt < 2) watchedSec += dt   // <2s：切后台/挂起回来那段不算
}
```

父组件只做增量入账（门禁 `delta <= 90`），数值回落视为换集（基准重置）。

★ 去重也要放行：`flushProgress` 原来只按 `pos` 去重，源卡顿时位置长时间不动、
墙钟却一直在走 —— 必须加 `watchedAdvanced`（`watchedSec - lastSentWatched >= 1`）
才能把这段送出去。心跳条件同理（`|| watchedSec - lastSentWatched >= 5`）。

门禁：`tests/player-runtime-fixes.test.ts` 用真墙钟跑 3 秒，断言 `watched > 1.5`、
暂停/seek 期间不涨、换源后归零。

### 5.6 WebView 缓存了 API 响应（2026-11-02，自己引入的回归）

给 TV 壳加性能优化时设了 `WebSettings.LOAD_CACHE_ELSE_NETWORK`，语义是
"缓存里有就直接用，哪怕已过期"。它把 `/api/...` 的 JSON 一起吃掉了：

- 弹幕搜索**永远返回第一次那 1 条**（后端实际有 58 条）
- 加个 `&_r=<随机数>` 就正常 —— 这是最快的判据
- 换关键词、重启应用都没用，只有清 WebView 缓存才恢复

已改回 `LOAD_DEFAULT`，并在后端 `sendText` 统一加
`Cache-Control: no-store, no-cache, must-revalidate` + `Pragma: no-cache`。
**两层都要**：壳侧防自己，后端防运营商代理/企业网关/定制内核这类中间层。
图片代理与分片流不走 `sendText`（有自己的 `sendBytes` 与缓存头），不受影响。

门禁：`tests/tv-root-causes.test.ts` 断言 `setCacheMode` 不得回退到
`LOAD_CACHE_ELSE_NETWORK`、`sendText` 必须带 `no-store`。

### 5.7 TV 弹框：必须限高 + 声明可滚区（2026-11-02）

用户报「手动搜索弹幕，弹框滚动面板有误，方向键上下按无法显示弹框完全内容，出界了」。

真因不是滚动写错了，是**弹框根本没有高度上限**：标题 + 输入框 + 来源胶囊
（可能换两行）+ 结果列表 + 底部说明叠起来，在 TV 的 640px CSS 视口里
必然超出屏幕，而且整块不可滚。

三件事缺一不可：

```html
<!-- ① 外层：模态作用域（tv-nav 据此收窄焦点范围） -->
<div data-tv-scope class="grid place-items-center">
  <!-- ② 弹框本体：视口百分比限高 + flex 纵向（别写死 px，TV 视口小得多） -->
  <div class="flex max-h-[86vh] flex-col">
    <input data-tv-first />                      <!-- ③ 落点：搜索框 -->
    <div data-tv-scroll tabindex="0"
         class="min-h-0 flex-1 overflow-y-auto">  <!-- ④ 唯一可滚区 -->
```

`min-h-0` 是 flex 子项能收缩的前提 —— 少了它 `flex-1` + `overflow-auto`
在限高父级里不会生效（内容会把父级撑开，滚不动）。

★ 同一时刻只能有一个 `[data-tv-first]`：两个会打架（`querySelector` 取
DOM 顺序第一个，结果取决于模板顺序）。落点给"用户第一意图"的那个控件
—— 搜索弹框给输入框，统计面板给内容区。

★ 打开时主动 `focus()` 一次，不要只依赖 `data-tv-first`：
非 TV 环境没有 tv-nav（标记是死属性），TV 上 tv-nav 的 `focusIntoScope`
又有 1.2s 按键宽限期，从控制栏点开时可能整轮被跳过。

### 5.8 横向按键：必须有"同行优先"（2026-11-02）

用户报「首页第一行海报，右键偶尔跳到上方的分类胶囊里」。

根因是主轴用**区间距离**：分类胶囊横跨整页，横向区间一旦与当前卡片重叠
就算 0 分（满分），而次轴只乘 2 倍，压不住这个优势 —— 离得近的胶囊赢过
同一行的下一张卡片。

修法：左右键在几何评分之外再记一个"同行候选"（垂直区间有交集，容差 8px），
同行有就直接用；同行没有（真的到行尾）才放开全量。两件事都不能少：

1. **同行优先**：横着走就是横着走，不跨行。
2. **行尾兜底 `return best`**：走到最后一列时必须允许换行，
   否则右键彻底没反应。

★ 另有一条：横向走到行尾时**不要**带上钉住层（顶栏）重扫。
原来 `find(dir, true)` 会让行尾的右键跳到右上角「设置」——
横向的语义是"换列"，要上顶栏请按上键。上下键保留这条兜底
（页面滚到顶时按上键，用户的意图就是离开内容区）。

### 5.9 移动端（< 640px）适配：断点约定与五个真坑（2026-11-05）

手机视口（390×844，DPR 2）实测发现的问题，都不是"缩一缩"能解决的：

1. **顶栏站点名被挤成 0 宽**：搜索框 `flex-1` 会一路抢宽度，站点名
   （`max-w-[5.5rem] truncate`）可以缩到 0，只剩一个箭头 —— 用户不知道
   当前是哪个源。手机改成**占满剩余宽度的「搜索框」**：外观与输入框一致，
   但它是 `<button>`，点一下直接进 `/search`（不先弹键盘再跳页）。
   `/search` 自带输入框、范围切换和最近搜索，本来就更适合手机。
2. **历史 / 收藏的「详情 / 移除 / 取消收藏」只靠 `group-hover` 出现**：
   触屏没有 hover，这些动作在手机上**根本无法触发**。现在 `max-sm:opacity-100`
   常显，并且删除类操作在 `(hover: none)` 下加一次确认。
3. **详情页整屏海报**：`w-full` + `aspect-[2/3]` 在 390px 上是 500+px 高，
   播放按钮要滚一屏才看得到。手机改成 96px 海报 `float-left`，标题/简介绕排。
   ★ **float 只对 block 父级生效**：左栏原本是 `flex flex-col`，float 会被
   忽略；所以基线类改成 `block`，`sm:flex sm:flex-row` 恢复桌面两栏。
   片库的「影片层」用同一套。
4. **设置页整页被撑宽**：缓存目录 `C:\Users\…` 一行 369px，
   `documentElement.scrollWidth` 从 390 变 412，整页可横向拖动。
   给 `.set-card code` 加 `overflow-wrap: anywhere`。
5. **历史顺序与冷启动空白**（2026-11-05 用户报「历史页要逆序显示」）：
   ① `pushHistory` 会把命中的那条移到数组最前，而历史页补封面会逐条回写 ——
   一次进页面就把"最新在前"重排成"最旧在前"（实测 OECT：10月29日 排在
   11月2日 前面）。现由 `listHistory()` 统一按 `at` 倒序返回，`groupByDay`
   的「输入已倒序」假设才真正成立。
   ② 远端进度/收藏是启动后异步拉的，常常晚于页面 `onMounted`，
   不广播就停在「还没有观看记录」。`applyRemoteHistory` / `applyRemoteFavorites`
   现在分别派发 `meow:history-synced` / `meow:favorites-synced`，
   页面监听后重读 —— **不能复用 `meow:*-changed`**（那个会触发回推，形成自激循环）。

**手机导航（2026-11-05 用户定）**：

- 底部标签栏三个一级入口：**首页 / AI / 设置**（`MobileTabBar.vue`）。
  **透明玻璃 + 悬浮胶囊**：底色 `--color-card`（5.5% 白/6% 黑，不用
  `--color-header-veil` 那种 76% 厚纱）+ `backdrop-filter: blur(24px)`，
  左右各 12px、离底 12px + 安全区（用户明确否掉贴底版）。
  **中间 AI 是向上顶出的异形球**：56px 圆形、`top:-1.375rem`、主题色渐变
  + 上沿高光；绝对定位不占布局，左右两项仍等宽 1/3，不会误触。
  只在 `<640px` 出现；播放页/直播页不渲染（会盖住进度条）。
- 有了标签栏，手机顶栏的「…」菜单只留 片库 / 直播 / 收藏 / 历史；
  **AI / 设置不再重复出现**，右下角 AI 悬浮球在手机上收起
  （对话状态在 `stores/aiChat.ts` 是模块级单例，/ai 整页不丢上下文）。
- 页面底部要留 `--tabbar-h`（`.has-tabbar` = 栏 52px + 离底 12px +
  AI 球顶出 22px + 余量 = `calc(5.5rem + env(safe-area-inset-bottom))`），
  AI 独立页高度 = `100vh - --header-h - --tabbar-h`。
- 顶栏搜索是**输入框外形的按钮**（不是真 input，避免先弹键盘），
  点一下直达 `/search` —— 搜索页有范围切换、最近搜索和聚合进度。
- 玻璃底色必须用 `--color-header-veil`（每个主题/明暗各给一份常量），
  不要用 `color-mix`（切主题会保留上一次的值，docs/27 §5.1）。

**吸顶胶囊（2026-11-05 用户要求）**：

- 首页的**分类胶囊**、设置页的**分区胶囊**在手机上 `sticky` 到顶栏下沿
  （`top: var(--header-h)`），底色 `--color-header-veil` + `backdrop-blur-xl`，
  和顶栏连成一条玻璃面板。
- ★ 两处都**只给 `max-sm:`**（首页）/ `lg:hidden`（设置页已天然只在手机显示）。
  原因：TV 的 `tv-nav` 把**任何 `position: sticky` 祖先**当"钉住层"，左右键会
  进不去内容区（SearchView 的 `tv-unstick` 就是为这个加的）。
- ★ 设置页的胶囊必须挂**页面容器的直接子级**：原来嵌在 `<aside>` 里，而 aside
  在窄屏只有胶囊这一行高，sticky 的可粘范围等于自身高度 → 滚一下就没。
- 首页胶囊原本用 `-my-3` 抵消横向滚动条的留白，吸顶后要归零（`max-sm:my-0`），
  否则 `top` 会差 12px。
- **满宽**：吸顶条的底色要铺满视口，靠 `容器 max-sm:px-3` + 胶囊 `max-sm:-mx-3`
  抵消。首页容器原来只有 `px-6`，胶囊减 12px 后两边各留 12px 缝隙
  （2026-11-05 用户截图指出，设置页因为容器已有 `px-3` 所以是满的）。
- **搜索页的搜索框那一栏也吸顶**（`max-sm:sticky`），结果滚动时输入框常驻。
- **设置页胶囊要跟着激活项横向滚**（2026-11-05 用户要求「把没露出来的胶囊
  向左挤出来」）：`watch(activeSec)` 里按 `scrollLeft` 把激活项居中，
  不能用 `scrollIntoView`（部分内核会连竖向容器一起滚，把页面拽回去）。

**片库「添加/编辑」的返回（2026-11-05 用户报「取消后像刷新页面」）**：

- 取消/保存都是用 `replace({name:'library'})` 回列表，组件会被重建；不带位置就
  退回根层，用户看到"骨架闪一下 + 回到片库首页"。现在 `goAdd/goEdit` 把当前
  目录塞进 query（`backLib`/`backPath`），返回时还原成 `#/library?lib=&path=`，
  并且 `onMounted` 有 `lib+path` 时**先不 loadRoot**（否则会先闪一下根层）。

**搜索页空闲态（2026-11-05 用户报「搜索历史沉底」）**：

- 窄屏把「最近搜索」排到「热播榜」之前（`max-sm:order-first` / `order-last`）。
  原来 `flex-col` 里热播榜带 `flex-1`，把历史顶到屏幕外。
- 热播榜在窄屏不再限高内部滚动，交给页面滚（嵌套滚动在手机上容易"卡住"）。

**断点约定（不要再发明第三套）**：

- 手机 = `< 640px`，写作 `max-sm:` 或 `@media (max-width: 639px)`；
- `sm/md/lg` 保持原有桌面断点，TV 走 `html[data-tv='1']` 的根字号阶梯；
- 手机专属的 CSS 覆盖集中在 `tokens.css` 文件末尾的移动端块
  （`.app-header` 高度含 `env(safe-area-inset-top)`、`.set-card`/`.tile`/
  `.set-head`/`.set-sub` 的收窄），别散回组件里；
- AI 浮层在手机上改成贴底抽屉（`86vh` + `86dvh` 兜底，键盘弹出跟着缩）；
- AI 独立页高度也用 `dvh`（`100vh` 保留作兜底）：只用 `vh` 时移动浏览器把
  地址栏收起后的空间也算进视口，页面会多出一截可滚动空白（用户报
  「弹框太高，页面还能滚」）。
- 门禁：`tests/mobile-layout.test.ts`（20 条）+ 历史顺序三条（`history.test.ts`）。

### 5.2 历史记录海报：三个原因叠在一起（2026-10-30）

用户报"播放历史页偶尔看不到海报"。查下来本机 10 条历史 `vod_pic` **全是空串**，
而同一部片 detail 明明返回了封面 —— 不是源站没图。三个独立原因：

**① `mergeInto` 用 `{...prev, ...next}`，空串覆盖了已有封面**

播放页从历史页/搜索页直达时，URL 里只有 `id` 和 `ep`，没有封面
（`posterPic()` 本来就是"读历史里已有的"）。于是每播一次就 push 一条
`vod_pic: ''`，把上一次已存好的封面抹掉 —— **播一次空一次，越用越空**。

```ts
// stores/history.ts：展示字段只在非空时覆盖
merged.vod_pic = nonEmpty(next.vod_pic) || prev.vod_pic
merged.vod_name = nonEmpty(next.vod_name) || prev.vod_name
merged.vod_remarks = nonEmpty(next.vod_remarks) || prev.vod_remarks
```

进度字段仍按"有没有传"判断（`pos: 0` 是合法值，不能用真假判）。

**② 播放页拿到了 detail 却把它扔了**

`ensurePlaylist()` 为了补剧集表本来就调 `fetchDetail`，响应里有
`vod_pic`/`vod_name`/`vod_remarks`，但原来只取 `vod_play_from/url` 就丢弃。
现在存进 ref，写历史时优先用 —— 片名也从"75539"变成"剑来第二季"。

**③ 已有的空记录不会自己变好**

①② 只保证"以后不变空"，但已经空掉的那批需要回补。历史页 `onMounted` 给
**缺图**的记录回源查一次 detail 并写回 localStorage：

- **并发限 3 + 间隔 260ms**：历史最多 10 条，齐发在 TV 上拖慢首屏，
  且部分源 detail 要 2–3 秒
- **跳过 `__smoke__` 这类测试假站点**：回源只会 404
- 补到就写回，下次进页面不用再查

实测：`vod_pic` 从 0/10 → 8/10（剩 2 条是冒烟假数据），片名同步补全。

> **合并规则的通用判据**：`{...prev, ...next}` 只在"next 一定是更完整的新值"时才对。
> 只要 next 可能带空值（而 prev 可能是前一次好不容易拿到的），就必须显式写合并规则。

### 5.1 换肤：三个 Chromium 实测坑（照直觉改会回退）

`styles/tokens.css` + `stores/theme.ts` + `index.html` 首帧脚本，三处必须保持一致。

**① 不要用 JS 写行内 CSS 变量换肤**

实测 Chromium 只改根元素自定义属性时，**已渲染元素的 `background-color` 不重算**——
变量读出来是新值，元素背景还是旧色；同一父节点下新建的克隆元素却是对的。

正确做法：切 `html[data-style][data-mode]` 两个属性，靠选择器匹配触发样式失效。

**② `transition` 写 `background-color`，不能写 `background` 简写**

简写会让浏览器持有整条 background 的过渡状态，切主题时值变化被吞掉，
元素永远停在初始色（改成 `!important` 也不生效）。

**③ `prefers-reduced-motion: reduce` 下 CSS 动画时间轴不推进**

Windows 常把这个默认打开，表现为「`animationName` 读得到、`playState=running`、
但 `currentTime` 恒为 0、画面完全不动」。

需要闪烁/脉冲类反馈时用 JS 定时切 class，不要依赖 `@keyframes`。
另外 `color-mix(..., transparent)` 用在 `outline-color` 上实测解析成 alpha=0（不可见），
这类边框高亮直接给不透明主题色。

**结构**：8 套风格 × 浅/深 = 16 个变量块，每块 **27 个变量**（24 个配色/圆角 +
`--color-wp-tint` 壁纸玻璃 + `--color-on-warn` / `--color-on-hot` 语义色文字）；
壁纸可见度再叠 `data-wallpaper="1"` + `data-wp="0..3"` 四档覆盖块。新增一套主题只改
**`tokens.css`**（运行时唯一真源）+ `prefs.ts` 的联合类型 + `index.html` 首帧白名单；
`theme.ts` 的 `THEMES` 只留 `base`/`accent`（用于 `<meta name="theme-color">` 与
TV 焦点光晕），不要再往里抄整份色板。门禁：
`client/apps/web/tests/theme-tokens.test.ts`（块数、27 变量、accent 6 位 hex、
正文/次级/三级文字与 on-accent/on-warn/on-hot 对比度）。

---

## 第六章 与后端的分工边界

| 谁做 | 什么 |
|---|---|
| **后端** | spider 调用、parse=1、代理（含 SSRF）、m3u8 重写、封面 header 解析、状态持久化 |
| **前端** | UI、播放器、弹幕渲染、失败重试链编排、进度节流、能力降级 |
| **交叉点** | 契约以 `docs/26` 为准；前端不得假设后端有未声明的能力 |

**三条禁止**：
1. 前端**不直连源站**（CORS + 防盗链）
2. 前端**不解析 m3u8**（后端已重写，前端只喂给 hls.js）
3. 前端**不探测"哪个源能播"**（后端健康状态机负责）

---

**变更记录**

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-21 | 初版。替代作废的 docs/22；基于现有 26 个源文件的实测结构 |
