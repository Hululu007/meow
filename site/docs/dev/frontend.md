# Web / PC 前端手册

> 范围：`client/apps/web/src`，95 个 `.vue`/`.ts`、约 4.9 万行（另有 110+ 个测试文件在
> `client/apps/web/tests`）。
> 本文只写**当前状态与改动约束**：为什么这样做、动了会坏在哪、阈值是多少。
> 端点与字段见 [API 契约](./api-contract.md)，播放/转码策略见 [播放与转码](./playback.md)，
> 弹幕源与调度见 [弹幕](./danmaku.md)，TV 壳与遥控器见 [TV 端接入](./tv-integration.md)，
> AI 面板与意图编排见 [AI 助手](./ai-assistant.md)。

---

## 第零章 铁律（改之前必读）

### 0.1 不可回退的决策

| # | 决策 | 为什么 / 证据 |
|---|---|---|
| **R1** | 弹幕用 **Canvas + 文字位图缓存**，不用 DOM | 每条一个 DOM 节点 + `transform`，180~200 条同时在场时每帧写 200 次 style，卡成幻灯片；Canvas 每帧只重绘一次位图。`danmaku.ts` 头部注释 |
| **R2** | 弹幕位置**完全由视频时间现算**，不用 CSS 动画 | 暂停、倍速、拖动自动同步，不会出现"先飞一段"的错位。`danmaku.ts:741` |
| **R3** | **DPR 上限 1.5** | 画布每帧全量重绘文字，DPR=2 时像素量是 1 倍屏的 4 倍，实测掉到 45fps 以下。`danmaku.ts:493` |
| **R4** | 用**原生 fetch**，不用 ofetch | ofetch 在 Tauri 协议下访问 `location[0]` 抛 `Cannot read properties of undefined`。依赖仍在 `package.json`，源码无引用。`api/index.ts:338` |
| **R5** | 倍速用自研 `RateSelect.vue`，不用原生 `<select>` | 原生下拉由浏览器绘制、**永远向下弹**，底部控制栏会被裁掉。`RateSelect.vue` 头部注释 |
| **R6** | **选项型设置用 `TileSelect.vue`（磁贴外形 + 弹层）；布尔开关用 `ToggleSwitch.vue`** | 选项多时"点一下切下一个"太繁琐；布尔开关统一成一个 `role=switch` 按钮，避免拨动开关/勾选框多种视觉。`SettingsView.vue:6252` 的 WebDAV「启用」即后者 |
| **R7** | 路由用 **hash 模式** | 打包后加载 `file://`，history 模式会 404。`router/index.ts:4` |
| **R8** | **不手动 `encodeURIComponent`** | vue-router 自己会编码，手动会变 `%253A` 双重编码；读取端用 `safeDecode()` 兜底。`PlayView.vue:105` |
| **R9** | 菜单类 **Teleport 不配 Vue `<Transition>`** | 过渡类不会被移除，菜单停在 `opacity:0`。改用 `@keyframes` + 非 scoped style。`TileSelect.vue:214` |
| **R10** | 判断桌面端用 `'__TAURI_INTERNALS__' in window \|\| '__TAURI__' in window` | Tauri 在 Windows 上是 `http://tauri.localhost`，协议仍是 http，**不能按 protocol 判**；`__TAURI__` 是旧版 Tauri 的兜底。`api/index.ts:36` |
| **R11** | **WebDAV 必须走后端代理** | 浏览器直连被 CORS 挡；MKCOL/PUT 预检多数服务器不支持。`sync.ts:86` 打 `/api/webdav` |
| **R12** | **控件要么有真实行为，要么删掉** | 留开关却没逻辑读取会被一眼看穿。门禁 `tests/settings-controls-consistency.test.ts` |
| **R13** | 历史合并时**空字符串不能覆盖已有展示字段** | `{...prev, ...next}` 会让后一次的空 `vod_pic` 抹掉已存封面，表现为"播一次空一次"。`history.ts:123` |
| **R14** | 移动端**只加 `max-sm:` / `@media(max-width:639px)`**，不改写桌面默认值 | 桌面与 TV 共用模板，TV 的 CSS 视口永远在 ≥640 一侧；用 `sm:` 反向覆盖会把 TV/PC 默认值一起改掉。`tokens.css:1374` |

### 0.2 三条工程约束

1. **不擅自打包 PC**。日常验证一律走 Web（`pnpm --filter @meow/web dev`）。
2. **不常驻 9979**。需要后端时临时启动，验完即停。
3. **不臆造后端能力**。能力探测目前只有 `/api/health` 的 `capabilities` 里的 `state`
   一项（`api/index.ts:838`），对应 `/api/state/*` 同步；其余功能没有协商层。

---

## 第一章 代码地图

### 1.1 目录与文件

```
src/
├── api/          13 个模块：index（请求封装 + 端点函数）、library、appUpdate、
│                 fpkUpgrade、gitAccel、health、logs、nativeBridge、playExtras、
│                 liveMerge、searchAffinity、searchRank、types
├── ai/           意图解析、编排、工具、摘要、诊断、桥接、斜杠命令
├── components/   20 个 .vue：common 14、layout 2、library 1、player 2、ai 1
├── composables/  useCardCols（按卡宽算列数）、useReturnRestore（返回恢复滚动/焦点）
├── stores/       16 个
├── views/        14 个路由视图
├── styles/       tokens.css（主题与断点的唯一运行时真源）
├── utils/        下集预取、弹幕候选标题清洗、历史分组、互斥播放、二维码
└── tests/        测试与 src/ 平级：client/apps/web/tests，110+ 个文件
```

**先认这几个大文件**（行数会漂，改前用 `wc -l` 复核）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `views/SettingsView.vue` | 7,300+ | 设置页，16 个分区 |
| `components/player/VideoPlayer.vue` | 6,300 | 播放器核心：hls、看门狗、字幕、跳过、进度 |
| `views/LiveView.vue` | 2,800 | 直播，自带独立的最小 hls.js 播放器 |
| `views/PlayView.vue` | 2,100 | 取地址、解析、自动换线、转码、投屏 |
| `api/index.ts` | 1,500+ | `request()` 封装 + 100 多个导出 |
| `components/player/danmaku.ts` | 1,200 | 弹幕解析与 Canvas 渲染 |
| `views/LibraryView.vue` | 1,200 | 本地 / NAS 片库 |
| `stores/prefs.ts` | 700+ | 近 50 个设置字段 |

`stores` 一览：`app`（站点与当前源）、`prefs`（**单一 `meow.prefs` JSON**，不是按语义分键）、
`history`、`favorites`、`favUpdates`、`sync`、`theme`、`wallpapers`、`appUpdate`、
`updateCenter`、`watchStats`、`searchHistory`、`skipMarks`、`linePref`、`tvMenu`、`aiChat`。

### 1.2 路由表

| 路径 | 视图 | 说明 |
|---|---|---|
| `/` | `HomeView` | 首屏 3 行；触底 900px 预加载（`HomeView.vue:27`） |
| `/category/:site` | `CategoryView` | 分页 + 筛选；页数硬上限 50（`CategoryView.vue:38`） |
| `/detail/:site/:id` | `DetailView` | 多线路 + 剧集网格 + 收藏 + 缓存整季 |
| `/play/:site` | `PlayView` | query：`flag/id/name/ep/vod/list`；片库直链另有 `direct/library/file` |
| `/search` | `SearchView` | 聚合结果 + 按源筛选 + 最近搜索 |
| `/history` | `HistoryView` | 历史 + 观看统计 |
| `/live` | `LiveView` | 直播（分组 + 频道格 + hls.js） |
| `/library` | `LibraryView` | 本地 / NAS 片库（根层级带「我的缓存」） |
| `/library/add` | `LibraryAddView` | 添加片库；编辑复用同一页（`?edit=id`） |
| `/offline` | `OfflineView` | 22 行薄壳，只渲染 `CachePanel`，兼容旧深链 |
| `/favorites` | `FavoritesView` | 收藏 |
| `/settings` | `SettingsView` | 16 个导航项，按平台过滤 |
| `/ai` | `AiView` | AI 独立页（复用 `AiPanel` 的 inline 模式） |
| `/logs` | `LogsView` | 运行日志；入口在设置页「维护」 |

深链必须写 `/#/xxx`。`scrollBehavior` 只在 `savedPosition` 存在时恢复，其余一律回顶；
TV 的内部滚动容器由 `useReturnRestore` 单独记忆（见 `router/index.ts` 注释）。

---

## 第二章 关键实现细节

### 2.1 播放页的失败兜底

`PlayView.load()` 的顺序是**固定的**，每一跳都有明确判据：

1. **片库直链**：query 里有 `direct` 就直接交给播放器，不走 spider（`PlayView.vue:475`）。
2. **离线缓存优先**：后端 `state=done` 且给出 playlist 就播本地清单，不打源站。
   判据必须是 `done`——下载中的片子播到断点会停，看起来像"坏了"（`:450`）。
3. **下集预取**：命中 `takePlayPrefetch()` 省一次 `fetchPlay`（实测 0.4–1.9 秒），
   未命中照常请求，预取只加速、不影响正确性（`:497`）。
4. **`needsParse()`**：显式 `parse===1`，或返回的 url 不是 http(s)（加密串）都算需要解析。
   解析成功后**必须连 `header` 一起替换**——jx 接口给的 Referer 通常是播放必需的那个（`:503`）。
5. **取不到地址 / 抛异常 / 解析失败 → 自动换线**：记入 sessionStorage 的失败线路表，
   取 `nextLineCandidate`（未试过、且不是当前线路）。三条路径同一条规则（`:522`、`:540`、`:556`）。
6. **播放中失败**：只有 `media` / `src` / `fake` 三类走转码（`playError.ts` 的
   `shouldTranscode`）；网络、超时、4xx 换线才有用。片库播放没有"线路"概念，
   按 `lib + path` 让后端自己读文件转码（`:894`）。
7. **原生播放器不自动切**。TV 上一出错就 `openNative()` 会把用户整页切走，
   回来时进度、弹幕、控制栏全没了；只在错误页留一个按钮（`:874`）。

改这里之前必须知道的四条：

- **先 `ensurePlaylist()` 再 `load()`**（`:1673`）。换线依赖 `lines`，线路表还空着时
  失败就只能停在错误页——AppGet 首线路空 url、Jianpian 首线路 SSL 失败都踩过。
- **换集要清空失败线路记录**（`FAILED_KEY`，`:603`）。这份记录是 sessionStorage、跨集不清；
  不清的后果是第 1 集试遍全片线路，第 2 集自动换源直接失效。
- **两级错误**：`playError` 是播放器/源站的原始原因，`hopError` 是我们这一跳
  （转码、代理）的原因。转码失败不能覆盖播放器给的原因，否则用户看到
  "找不到 ffmpeg"而真实原因只是一次网络抖动（`:785`）。
- **手动换线路要清 `FAILED_KEY`**，自动换线不清（`switchLine` 的 `auto` 参数，`:1575`）。

### 2.2 播放器（VideoPlayer.vue）

**hls.js 配置**（按实测三档选定，别再回到 60/120/60MB）：

| 项 | 值 | 理由 |
|---|---|---|
| `maxBufferLength` / `maxMaxBufferLength` | 180 / 300 | hls.js 实际上限是 `min(max(8×maxBufferSize/码率, maxBufferLength), maxMaxBufferLength)`；60/120 时永远只领先 2 分钟 |
| `maxBufferSize` | 120MB | 实测领先 188s、堆 15MB；240/600/200MB 会囤到撑爆 MediaSource |
| `backBufferLength` | 60 | 回看上一句台词很常见 |
| `fragLoadingMaxRetry` | 6 | 源站经常瞬时 5xx |
| `MAX_RECOVER_ATTEMPTS` | 3 | `startLoad()` / `recoverMediaError()` 必须计次，否则持续 5xx 会无限重连（`VideoPlayer.vue:1398`） |

**错误分档**（判据在 `playError.ts`，转码决策见 [播放与转码](./playback.md)）：
`media / network / timeout / stall / http / fake / src / unknown`。
4xx 且非 403 直接判死，不重试——"清单 200 + 分片全 404"原本要白等 20 秒；
403 例外，换一轮有机会带上新 header。

**起播看门狗**：起播预算 20s，`MANIFEST_PARSED` 后放宽到 35s，总上限 45s；
有分片进来则把"假死"窗口续 12s。清单能开、分片全失败（`duration` 有值但
`readyState` 一直是 0）也归到这里。

**跳过片头/片尾**：

- 优先级：手动标记（`skipMarks`，按 `site+vod_id`）> 源站 `skips` > 设置页全局秒数。
  片尾三种来源口径不同（绝对秒 / 距结尾秒），统一换算成 `outroAt` 再比较（`:473`）。
- `skipCountdown === 0` 表示点了直接跳；`>0` 时提示条转圈，暂停时停表、恢复重新计时。
- **跳片尾先 seek 到 `duration-1`，再立即发 `ended`**：这次 seek 只为让画面和进度条停在末尾；
  紧接着 `endedSent = true` 并 `emit('ended')`，**不等待自然 `ended`**。约 1 秒后自然触发的那次
  由 `endedSent` 吞掉，否则会连跳两集。最后一个分片与 `duration` 有几十毫秒偏差时，
  指望"再等 1 秒自然结束"经常等不到（`:736`）。
- 中插广告段默认不跳（`prefs.skipMiddle`）：区间标错会吞剧情，必须用户显式打开。

**外挂字幕**：只取第一份**能渲染**的（vtt 原样、srt/ass 转 VTT），图形字幕直接跳过。
VTT 用 `blob:` URL 喂 `<track>`，**不要**把代理地址直接当 `src`——跨源 track 要求
`<video crossorigin>`，一旦打开，所有分片/密钥/Range 都会变 CORS 模式，少一个头整片播不了
（`VideoPlayer.vue:522`）。

### 2.3 弹幕引擎（不要改的部分）

| 项 | 值 | 位置 |
|---|---|---|
| 在场上限 | `MAX_ACTIVE = 120`，超出丢弃新弹幕 | `danmaku.ts:151` |
| 位图缓存上限 | 600 条，另有 6M 像素预算 | `:154`、`:170` |
| 缓存键 | `${fontSize}\|${color}\|${text}` | `makeSprite()` |
| sprite 宽度 | 必须含左右 padding，否则 `drawImage` 拉伸文字 | — |
| DPR | `Math.min(1.5, devicePixelRatio)` | `:493` |
| 位置 | `x = W - p * (W + width)`，`p = (time - born) / dur` | `:741` |
| 跳转判定 | 首次 / 后退 >0.75s / 前进 >1.5s；跳转只补最近 3 秒 | `:788` |
| rAF 插值 | 最后权威时间 + 真实流逝 × rate，最多超前 0.4s | `sync()` 注释 |
| jsdom 降级 | `getContext('2d') || nullCtx()` | 让单测能跑 |

`0.75 > 0.4` 不是随手取的：缓冲恢复时第一个 `sync` 的 `time` 比插值前的位置
最多小 0.4，阈值必须大于它，否则每次缓冲恢复都被误判成 seek、弹幕被清空。
测试查 `debugActive()` 而不是 DOM 节点。改完跑 `npx vitest run`。

### 2.4 设置页（SettingsView.vue）

`NAV_ITEMS` 定义 **16 个分区**，按平台过滤：

- 通用：连接、搜索与源、直播源、播放、弹幕、外观、存储、WebDAV、AI、网络与加速、更新、维护
- `desktopOnly`：本机插件、桌面端行为
- `tvOnly`：本机执行、运行时模块

**分区顺序不是装饰**：`NAV_ITEMS` 的顺序必须与模板 `<section data-sec>` 顺序一致，
`label` 与 `<h2 class="set-title">` 一字不差。`onScrollSpy()` 按表顺序判断高亮，
错了会"滚到 A 区亮 B 区"。门禁 `tests/settings-nav-sync.test.ts`。

设置页**禁用原生 `<select>`**（深色主题下弹白底，高度圆角也与磁贴不一致），
统一 `TileSelect`；归属已定的控件不许挪（缓存三档/搜索参数在「搜索与源」、
DNS 在「维护」、列数在「外观」、历史条数在「存储」、本地弹幕在「弹幕」）。
门禁 `tests/settings-controls-consistency.test.ts`。

### 2.5 代理与图片

- **封面统一走 `PosterImage.vue`**，默认 `proxied = true`，即所有 `vod_pic` 都经
  `/api/proxy/image`。源站把 `@Referer=...@User-Agent=...` 挂在 URL 后缀，后端负责解析。
  组件自己处理加载中/失败占位，不要在页面里裸写 `<img :src="vod_pic">`。
- **视频统一走 `proxyStream(url, header)`**：`Referer`/`User-Agent` 拆成独立参数，
  其余鉴权头（Cookie、Origin、自定义 token）序列化进 `headers`，后端按白名单过滤。
  只转 Referer/UA 会让"原生能播、Web 永久 403"。
- 前端**不拼 m3u8 相对地址**、不改写分片，后端已经处理。

### 2.6 TV WebView 的边界

TV 壳的 WebView 设置（`client/apps/tv` 的 `MainActivity`）里有几条不能动的：

- `LOAD_DEFAULT`，**不能**用 `LOAD_CACHE_ELSE_NETWORK`（会把 `/api/*` 的 JSON 一起缓存，见 3.8；
  门禁 `tests/tv-root-causes.test.ts`）。
- `setTextZoom(100)`：部分固件默认 130%，整站会错位。
- `LAYER_TYPE_HARDWARE` + `setOffscreenPreRaster(true)`：盒子 GPU 弱，软件合成 1080p 直接掉帧
  （以上均在 `client/apps/tv/.../MainActivity.java:231` 起）。
- `tv-nav` 把任何 `position:sticky` 祖先当"钉住层"，横向键进不去内容区；
  确实需要吸附的元素在 TV 上用 `.tv-unstick` 摘掉（`tokens.css:820`）。

物理边界（不是优化问题）：WebView 解码要经 `MediaCodec` 转 surface，起播比原生
ExoPlayer 慢；遥控器按键要跨 `KeyEvent → WebView → JS → DOM` 四层。**只能靠减少
每帧工作量间接改善**，别指望调到原生手感。

---

## 第三章 常见坑（前端专项）

### 3.1 换源后"旧片声音 + 新片画面"

三条路径同一个根因：**媒体元素没有真正停掉就被丢下了**。切集（`loading` 卸载）、
切线路（同一 `<video>` 换源）、返回重播（旧页面销毁）都会触发。

Chromium 对带 MediaSource 的元素，从文档摘掉后不一定立刻停播；`hls.destroy()`
只是解绑 MSE，已缓冲的那段会继续播到末尾。统一解法 `stopMedia()`
（`VideoPlayer.vue:1483`），三步缺一不可：

```ts
v.muted = true            // 立刻听不到
v.pause()
v.removeAttribute('src')  // 丢弃 MSE 引用
v.load()                  // 让解码管线收尾；只摘 src 不 load 仍可能出声
```

调用点：`setupSource()` 开头、`onBeforeUnmount`、TV 返回键第二次（即将 goBack）。
★ 换源后要按用户偏好恢复音量，否则 `stopMedia` 的静音会把新源也弄哑。

★ `load()` 会派发一次 `durationchange`（`duration=NaN`）。`onLoaded` 必须挡掉
`Number.isNaN(v.duration)`（`:2208`），否则时长被清零、续播点丢失。判据只能用
duration——hls.js 的 `src` 属性始终为空、`currentSrc` 是 `blob:`，按 src 判会把
正常起播也挡掉。

### 3.2 观看时长不能用 `pos` 差值

进度心跳本来就是 5 秒一次，`pos` 差恒为 5.0~5.3；用 `delta <= 5` 当"非 seek"门禁，
几乎每条都会被丢掉，统计永远是 0。

现在播放器自己按**墙钟**累计 `watchedSec`，随 `progress` 发 `watched`：

```ts
// 三条判据缺一不可
if (!v.paused && !v.seeking && watchedTickAt) {
  const dt = (performance.now() - watchedTickAt) / 1000
  if (dt > 0 && dt < 2) watchedSec += dt   // <2s：切后台/挂起回来那段不算
}
```

父组件只做增量入账（门禁 `delta <= 90`），数值回落视为换集、基准重置。
★ 去重也要放行：源卡顿时位置长时间不动、墙钟却一直在走，必须加
`watchedAdvanced`（`watchedSec - lastSentWatched >= 1`）才能把这段送出去；
心跳条件同理（`>= 5`）。门禁 `tests/player-runtime-fixes.test.ts`。

### 3.3 历史记录：空值覆盖、顺序与补图

**① 合并**：展示字段只在非空时覆盖（`history.ts:123`）；进度字段按"有没有传"判断
（`pos: 0` 是合法值，不能用真假判）。通用判据：`{...prev, ...next}` 只在
"next 一定是更完整的新值"时才对。

**② 写历史前先补 detail**：播放页 `ensurePlaylist()` 本来就要拉 detail，
响应里的 `vod_pic`/`vod_name`/`vod_remarks` 要存下来写历史，不能只取
`vod_play_from`/`vod_play_url` 就丢。

**③ 历史页回补**：只补缺图且非 `__` 开头的假站点，**并发 3 + 间隔 260ms**
（`HistoryView.vue:36`）。齐发会在 TV 上拖慢首屏，且同一个源站连发容易 429。
补到就写回，下次进页面不再查。

**④ 顺序**：`pushHistory` 会把命中的那条移到最前，而历史页补封面会逐条回写——
一次进页面就能把"最新在前"重排成"最旧在前"。`listHistory()` 统一按 `at` 倒序返回
（`history.ts:86`），`groupByDay` 的"输入已倒序"假设才成立。

### 3.4 换肤：三个 Chromium 实测坑

`styles/tokens.css` + `stores/theme.ts` + `index.html` 首帧脚本，三处必须一致。

1. **不要用 JS 写行内 CSS 变量换肤**。Chromium 只改根元素自定义属性时，已渲染元素的
   `background-color` 不重算——变量读出来是新值，背景还是旧色（新建的克隆元素却是对的）。
   正确做法：切 `html[data-style][data-mode]`，靠选择器匹配触发样式失效。
2. **`transition` 写 `background-color`，不能写 `background` 简写**。简写会让浏览器
   持有整条 background 的过渡状态，切主题时值被吞掉（加 `!important` 也没用）。
3. **`prefers-reduced-motion: reduce` 下 CSS 动画时间轴不推进**。Windows 常默认打开，
   表现为 `playState=running` 但 `currentTime` 恒为 0。需要闪烁反馈时用 JS 定时切 class。
   另外 `color-mix(..., transparent)` 用在 `outline-color` 上实测解析成 alpha=0，直接给不透明色。

结构：8 套风格 × 浅/深 = **16 个变量块，每块 27 个变量**；壁纸再叠
`data-wallpaper` + `data-wp` 四档覆盖。新增主题只改 `tokens.css`（运行时唯一真源）+
`prefs.ts` 的联合类型 + `index.html` 首帧白名单；`theme.ts` 的 `THEMES` 只留
`base`/`accent`。门禁 `tests/theme-tokens.test.ts`。

### 3.5 TV 焦点、返回键与控制栏

**控制栏收起必须用 `visibility:hidden`，不能只有 `opacity:0`**。两个层次叠在一起：

- `opacity` 不遗传给子元素。外壳 `opacity-0`，里面每个按钮自己的 computed opacity 仍是 1，
  `tv-nav` 的可见性判断看的是**元素自己**，隐形按钮照样进候选集。
- `tv-nav` 不能裸用 `querySelector('.meow-tv-focus')`：只要残留一个（包括
  `display:none` 的），壳就认为"用户正在移焦点"，把 ArrowDown 全吃掉，播放器
  永远收不到唤出控制栏的键。用 `markedEl()` 遍历全部、只认真正可见的
  （尺寸 ≥2、非 hidden、非 none、opacity 非 0，`tv-nav.js` 的 `visible()`）。

**播放页返回键是分层退出**：弹幕搜索弹框 → 伪全屏 → 选集/线路/弹幕/更多面板
（关闭时顺带收控制栏）→ 控制栏。全都没显示时，第一次返回**只弹
「再按一次返回退出播放」提示——不暂停、不唤出控制栏**，2.5 秒内再按才交给壳退出。
判据是"提示是否还在屏上"，按慢了就重新提示，不会误退出（`VideoPlayer.vue:4393`）。
倒计时进行中返回 = 立即跳过片头/片尾。

**TV 上默认不渲染左上角返回按钮**（`showBackButton = !isTvEnv() || compactViewport`，
`VideoPlayer.vue:2522`）：它是几何选焦的头号命中目标，按 ok 会直接退出整集。
遥控器自己有返回键。

### 3.6 TV 弹框与横向选焦

**弹框必须限高 + 声明唯一可滚区**。四件事缺一不可：

```html
<div data-tv-scope class="grid place-items-center">   <!-- 收窄焦点范围 -->
  <div class="flex max-h-[86vh] flex-col">            <!-- 视口百分比，别写死 px -->
    <input data-tv-first />                           <!-- 唯一落点 -->
    <div data-tv-scroll tabindex="0" class="min-h-0 flex-1 overflow-y-auto">
```

`min-h-0` 是 flex 子项能收缩的前提，少了它 `flex-1 + overflow-auto` 在限高父级里
不生效。同一时刻只能有一个 `[data-tv-first]`；打开时再主动 `focus()` 一次，
不要只依赖标记（非 TV 环境没有 tv-nav，TV 上又有 1.2s 按键宽限期）。

**横向键必须有"同行优先"**：主轴若只用区间距离，横跨整页的分类胶囊与当前卡片
重叠就算满分，次轴权重压不住，右键会跳到上方胶囊里。左右键先找"垂直区间有交集
（容差 8px）"的同行候选，同行没有才放开全量；行尾必须 `return best` 允许换行，
否则右键彻底没反应。横向走到行尾**不要**带上钉住层重扫（那会跳到右上角设置），
上下键保留这条兜底。

### 3.7 移动端（<640px）

断点只有一套：手机 = `<640px`，写作 `max-sm:` 或 `@media(max-width:639px)`；
`sm/md/lg` 保持桌面语义，TV 走 `html[data-tv='1']`。手机专属覆盖集中在
`tokens.css` 末尾的移动端块，别散回组件里。

- **顶栏搜索是"输入框外形的按钮"**（`AppHeader.vue:404`，`sm:hidden`），点一下直达
  `/search`：手机先弹键盘再跳页是多余的一步，搜索页本来就有输入框、范围切换和最近搜索。
- **底部标签栏**三入口：首页 / AI / 设置（`MobileTabBar.vue`）。中间 AI 是向上顶出的
  异形球，绝对定位不占布局，左右两项仍等宽。播放页与直播页不渲染（会盖进度条）。
  页面底部留 `--tabbar-h`，值 = `calc(6rem + env(safe-area-inset-bottom))`（`tokens.css:1379`）。
- **触屏没有 hover**：历史/收藏的"移除/取消收藏"必须 `max-sm:opacity-100` 常显，
  删除类操作在 `(hover: none)` 下加一次确认。
- **详情页海报**：手机 96px + `float-left`，标题简介绕排。★ float 只对 block 父级生效，
  左栏基线类必须是 `block`，再用 `sm:flex sm:flex-row` 恢复桌面两栏。
- **设置页整页被撑宽**：缓存目录 `C:\Users\…` 一行 369px 会让整页可横向拖动，
  `.set-card code` 必须 `overflow-wrap: anywhere`。
- **搜索页空闲态**：窄屏把「最近搜索」排到「热播榜」之前（`order-first`/`order-last`），
  热播榜不再限高内部滚动，交给页面滚。
- **吸顶**：首页分类胶囊、设置页分区胶囊、搜索页输入栏在手机上 sticky 到
  `var(--header-h)`，底色 `--color-header-veil` + `backdrop-blur`。三处都**只给手机**，
  原因见 2.6 的钉住层；设置页胶囊必须挂在页面容器直接子级，否则可粘范围只有自身高度。
  设置页胶囊跟着激活项横向滚动用 `scrollLeft` 居中，不要 `scrollIntoView`
  （部分内核会连竖向容器一起滚）。
- **AI 高度用 `dvh`**（`100vh` 兜底）。只用 `vh` 时地址栏收起后的空间也算进视口，
  页面会多出一截可滚动空白。门禁 `tests/mobile-layout.test.ts`。

### 3.8 工具链上的坑

| 坑 | 解法 |
|---|---|
| `location.hash` 里的 `#/detail/...` 被 Git Bash 当路径转换 | 用 `location.hash = '#/...'` 赋值，不要拼进命令行 |
| CDP 截图与 DOM 不一致 | 先 `getComputedStyle` 核对；不一致时承认局限，不要按截图改代码 |
| Edge 扩展挤掉 CDP target | 独立 `--user-data-dir` + `--disable-extensions --no-first-run` |
| Tauri 图标不跟随 `web/public` | `npx tauri icon "<绝对路径>"`（相对路径报 os error 3），并更新 `bundle.icon` |
| WebView 缓存了 API 响应 | 壳侧 `LOAD_DEFAULT`，后端 `sendText` 统一 `no-store`。判据：加 `&_r=<随机数>` 就正常 |

---

## 第四章 测试与验证

### 4.1 单测

```bash
cd client/apps/web && npx vitest run
```

改动弹幕、播放器、历史、设置页、AI、TV 相关逻辑后必须全量跑；失败时以
`npx vitest run` 的具体用例为准，不要拿旧数字当"全绿"前提。

重点门禁（都在 `tests/`）：

| 文件 | 钉住什么 |
|---|---|
| `danmaku*.test.ts`（多个） | 解析、缓存 LRU、像素预算、跳转阈值 |
| `player-*.test.ts` | 错误分类、看门狗、返回键、停播、进度 |
| `settings-nav-sync.test.ts` | `NAV_ITEMS` 与模板顺序/标题一致 |
| `settings-controls-consistency.test.ts` | 控件真实行为、分区归属 |
| `theme-tokens.test.ts` | 每套风格浅/深两块 × 27 变量、对比度、hex 格式 |
| `tv-nav-*.test.ts` | 真实 `tv-nav.js` 进 jsdom 的选焦/派发 |
| `mobile-layout.test.ts` | 手机断点只覆盖、不污染桌面 |
| `ai-commands.test.ts` | 斜杠命令解析/拒绝路径；`TOOL_LABEL` 覆盖全部 `TOOL_DEFS` |

### 4.2 Web 验证

```bash
# 1. 后端（临时启动，验完即停）
cd server/host && run.bat

# 2. 前端
cd client/apps/web && pnpm dev

# 3. 截图（Edge app 窗口，CDP）
CDP_URL_FILTER="localhost:5173" node client/apps/desktop/cdp.mjs shot
```

一律 Web 场景验证，**不打包 PC**。打包必须等用户开口。

---

## 第五章 与后端的分工边界

| 谁做 | 什么 |
|---|---|
| **后端** | spider 调用、`parse=1`、代理（含 SSRF 防线）、m3u8 重写、封面 header 解析、状态持久化、转码 |
| **前端** | UI、播放器、弹幕渲染、换线编排、进度节流、错误分档与展示 |
| **交叉点** | 契约以 [API 契约](./api-contract.md) 为准；前端不得假设后端有未声明的能力 |

**三条禁止**：

1. 前端**不直连源站**（CORS + 防盗链）。
2. 前端**不解析 m3u8**（后端已重写，前端只喂给 hls.js）。
3. 前端**不探测"哪个源能播"**（后端健康状态机负责，见 `api/health.ts` 注释）。
