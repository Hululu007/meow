# 猫窝 Meow · Web / PC 客户端

一份前端代码，两个出口：

- **Web**：Vue 3 + TypeScript + Vite + Tailwind v4，浏览器直接访问
- **PC**：Tauri 2 套同一份前端，打包成 Windows 安装包，内置后端插件管理

后端不在这里，在 [`../server/host`](../server/host)（Java 宿主）。
三端架构与取舍见 [`../site/docs/dev/architecture.md`](../site/docs/dev/architecture.md)。

| 你想干什么 | 看 |
|---|---|
| 跑起来看效果 | [快速开始](#快速开始) |
| 改设置页 | [设置页结构](#设置页结构) |
| 打包 PC 版 | [PC 打包](#pc-打包) |
| 查老 bug 别改回去 | [`../site/docs/dev/frontend.md`](../site/docs/dev/frontend.md) |

---

## 快速开始

### 先起后端

```bash
cd ../server/host
build.bat          # 首次或改过 Java 后必须跑
start-api.bat      # → 127.0.0.1:9979
```

> `start-api.bat` 会 `cd` 到 `server/`，所以数据目录是 `server/data/`，不是 `client/data/`。
> `classes/` 是 javac 产物、不入库，直接 `start-api.bat` 前必须先 `build.bat`，否则
> 跑到的是上次编译的版本（或直接报 ClassNotFound）。

### 再起前端

```bash
pnpm install
pnpm dev           # → http://localhost:5173
```

Vite 已把 `/api` 代理到 `127.0.0.1:9979`，开发期没有跨域问题。

**连远端后端**（不起本地 Java）：设 `VITE_API_TARGET`，或启动后在设置页填地址。

```bash
VITE_API_TARGET=http://192.0.2.10:30010 pnpm dev
```

### 一键脚本

| 脚本 | 作用 |
|---|---|
| `start-web.bat` | 起 Vite（需后端已在跑） |
| `start-desktop.bat` | `pnpm tauri dev`，后端由插件管理器拉起 |
| `run-desktop-debug.bat` | 起已构建的 exe 并开 CDP（默认 9222） |

---

## 目录

```
client/
├── apps/web/                 Vue 3 前端（Web 与 PC 共用这一份）
│   ├── src/
│   │   ├── api/              index.ts 后端封装 + types.ts 与后端共享的类型
│   │   ├── components/
│   │   │   ├── common/       PosterCard、TilePanel、TileSelect（磁贴控件）
│   │   │   ├── layout/       AppHeader
│   │   │   └── player/       VideoPlayer.vue、danmaku.ts（Canvas 渲染器）
│   │   ├── dev/              player-check.ts（播放器自检页）
│   │   ├── stores/           pinia：app / history / prefs / searchHistory / sync
│   │   ├── styles/           tokens.css 设计 token
│   │   ├── views/            7 个页面
│   │   ├── diagnostics.ts    诊断钩子（启动期错误与请求捕获）
│   │   └── main.ts           入口：桌面端等 sidecar 就绪后才 mount
│   ├── tests/                5 个 vitest 文件 / 143 用例
│   ├── player-check.html     播放器自检页（不影响主应用）
│   └── vite.config.ts        /api 代理、@ 别名、__APP_VERSION__ 注入
│
├── apps/desktop/
│   ├── src-tauri/
│   │   ├── src/lib.rs        应用装配、命令注册、boot_info
│   │   ├── src/plugins.rs    插件进程管理（启停、端口协商、Job Object 清理）
│   │   ├── src/installer.rs  插件下载/校验/解压/回滚、多源管理
│   │   ├── src/mcp.rs        内置 MCP 服务（18 个 pc_* 工具）
│   │   ├── src/main.rs       入口（5 行）
│   │   ├── Cargo.toml
│   │   └── tauri.conf.json   窗口、图标、打包目标
│   ├── build-gnu.ps1         GNU 工具链构建（避开 MSVC）
│   ├── build-gnu.bat         同上 .bat 版
│   ├── cdp.mjs               CDP 截屏/读 DOM/点击（调试用）
│   ├── debug-dav.mjs         WebDAV 调试
│   ├── smoke-fps.mjs         PC 端弹幕帧率冒烟
│   ├── smoke-fps-web.mjs     Web 端弹幕帧率冒烟
│   └── smoke-sync.mjs        倍速播放同步性冒烟
│
├── brand/                    图标单一源
│   ├── logo.svg              改图标只改这个
│   ├── build-icons.mjs       生成 Web 图标 + PNG
│   └── logo-*.png / tauri-icon.png
│
├── pnpm-workspace.yaml       workspaces: apps/*
├── package.json              根脚本（dev/build/preview/tauri）
├── .gitignore                客户端专属忽略规则
└── *.bat                     快速启动脚本
```

---

## 页面与路由

hash 路由（`createWebHashHistory`）——Tauri 加载的是 `file://`，history 模式会 404。

| 路由 | 文件 | 作用 |
|---|---|---|
| `/` | `HomeView.vue` | 首页、站点切换、分类入口 |
| `/category/:site` | `CategoryView.vue` | 分类浏览 |
| `/detail/:site/:id` | `DetailView.vue` | 详情、线路与剧集、续播 |
| `/search` | `SearchView.vue` | 聚合搜索（并发 `searchThreads`） |
| `/play/:site` | `PlayView.vue` | 播放页壳：取流、错误重试、连播 |
| `/history` | `HistoryView.vue` | 观看历史与进度 |
| `/settings` | `SettingsView.vue` | 设置（见下） |

`VideoPlayer.vue`（2768 行）是播放核心，`danmaku.ts`（1139 行）是弹幕渲染与调度。

---

## 设置页结构

6 个区块，其中**插件区仅 PC 存在**（`v-if="desktop"`）：

| 区块 | Web | PC | 内容 |
|---|---|---|---|
| 后端地址 | ✅ | ✅ | Web：同源或手填远端；PC：插件托管或手填远端 |
| 本机插件 | ❌ | ✅ | 插件源、下载/升级/卸载、启停、离线导入 |
| 网络 | ✅ | ✅ | 安全 DNS、DNS 测试、搜索线程、自动播放 |
| 播放与显示 | ✅ | ✅ | 弹幕 6 项、画面缩放、首页列数、搜索展示、缓存、历史、跳跃 |
| WebDAV 同步 | ✅ | ✅ | 连接配置、历史/搜索词同步、设置快照 |
| 数据与维护 | ✅ | ✅ | 导出/导入、重连、清缓存、恢复默认、站点明细 |

**设置项的存储分三层，别混：**

| 层 | 存在哪 | 例子 | 谁读 |
|---|---|---|---|
| 本地偏好 | `localStorage['meow.prefs']` | 弹幕、列数、历史上限 | 前端 |
| 后端策略 | `data/policy.json` | 安全 DNS、弹幕 API | 后端 |
| WebDAV 配置 | `localStorage['meow.webdav']` | 地址、账号、四个同步开关 | 前端 sync |

全部设置项定义在 `src/stores/prefs.ts` 的 `Prefs` 接口，默认值在 `DEFAULTS`。

### 弹幕密度三档（易改错）

密度不是独立参数，是「滚动时长 + 显示区域」的预设组合：

| 档位 | 时长 | 区域 | 上屏率 |
|---|---|---|---|
| 稀疏 | 18s | 55% | 48% |
| 标准 | 12s | 70% | 70%（= 历史默认） |
| 密集 | 9s | 85% | 91% |

用户手改时长或区域后档位自动降为 `custom`。数值是拿《庆余年》第二季真实数据反推的，
**不要凭直觉调**——实测「加大区域」只提升 4%，而「缩短时长」提升 30–57%。

---

## 样式规范（改 UI 前必读）

### 设计 token

颜色/圆角/字号一律走 `src/styles/tokens.css` 里的 CSS 变量（`--color-*` / `--radius-*` / `--fs-*`），
换肤（`html[data-style]` × `html[data-mode]`，4 套风格 × 明暗 = 8 组合）由
JS 只切这两个属性完成，组件里**不写死颜色**。

★ **不要用 `color-mix()` 做半透明**：Chrome 66（投影仪）不支持，切主题时还会保留旧值。
需要半透明就写 `bg-accent/15` 这类工具类（Tailwind 会同时输出 hex 兜底 + `@supports` 版本）。

### TV 焦点环（三层，全部走 token）

| 位置 | 形态 |
|---|---|
| 普通元素（`.meow-tv-focus`） | `inset 1px 内线` + `2px accent 环` + `12px accent 辉光` |
| 弹层内（`[data-tv-scope] .meow-tv-focus`） | `inset 1px 内线` + `inset 3px accent` + `10px 辉光` |
| 首页分类胶囊（`.cat-chips`） | 同弹层（滚动容器裁切，只能内嵌） |
| 分段控件（`.seg-group`，「追加/替换」这类合体按钮） | `inset 1px 内线` + `inset 2px accent`（贴边 1px，外扩环必被裁） |
| 可滚停靠点（`[data-tv-scroll].meow-tv-focus`） | 只剩左侧 3px 竖条 |

- **accent 环与辉光都是 `var(--color-accent)`**，8 套主题自动跟随，不要写死青色。
- **内线颜色是 token**：`--tv-focus-inner`（深色 `rgba(255,255,255,.65)` / 浅色 `rgba(0,0,0,.42)`）。
  它在实心 accent 元素上负责把边界压出来 —— 单靠 accent 环会和同色底重合，
  2026-11-04 和 2026-11-06 各踩过一次。
- **环的形状 = 焦点所在元素的 `border-radius`**。所以可聚焦元素自己必须带圆角：
  `PosterCard` 的根 `<button>` 有 `rounded-lg`（圆角只写在内层 div 上时环是直角的）。
- **滚动容器里的焦点环要用 inset**：外扩环会被 `overflow` 按 padding box 裁掉
  （胶囊条实测"边框被裁一点"）。要么 inset，要么容器留 ≥14px 内边距。
- 老内核（`html[data-legacy-css='1']`）**不要再给 `*:focus` 画 outline**：
  tv-nav 只搬 class 不搬 DOM 焦点，页面里的 `focus()` 会让某个元素长期带着 DOM 焦点，
  Chrome 66 的 outline 又不跟随圆角 → 屏上同时出现"圆环 + 残留四角方框"（2026-11-06 实锤）。
  现在只有表单控件保留 outline。

### 投影仪（Chrome 66）禁用清单

| 特性 | 首个支持版本 | 处理 |
|---|---|---|
| CSS `min()/max()/clamp()` | Chrome 79 | 写 `w-[X] max-w-[calc(...)]` / `height + max-height` |
| flex `gap` | Chrome 84 | `legacy-generated.css` 自动转 margin |
| `aspect-ratio` | Chrome 88 | 生成器转 padding-top |
| `inset` 简写 | Chrome 87 | 生成器转四边 |
| `translate/rotate/scale` 单属性 | Chrome 104 | `legacy-css.css` 转 transform |
| `:is()/:where()` | Chrome 88 | 只用 preflight / group-hover（悬停效果会丢，可接受） |
| `color-mix()` | Chrome 111 | Tailwind 自带 hex 兜底 |
| `dvh` | Chrome 108 | 一律成对写 `vh` 兜底 |
| `env(safe-area-*)` | Chrome 69 | 只在 `max-width:639px` 档用 |

### 可聚焦元素与滚动容器

- 列表项做成 `<button>` / `<a href>` / `[tabindex]`，tv-nav 靠这个集合算几何最近邻。
  只在**外层不可聚焦 div** 上加焦点环是错的（环会画在错误的矩形上，且没有弧度）。
- 横向滚动的胶囊条：`focusin` 时把聚焦项 `scrollTo` 居中（首页/设置页都这么做）；
  **不要用 `scrollIntoView`**，部分内核会连带滚竖向容器把页面拽回去。
- 粘性定位（`sticky`）只给 `<640px`：TV 上 tv-nav 会把任何 sticky 祖先当"钉住层"，左右键进不去内容区。

---

## 两端的关键差异

改设置页或后端地址相关逻辑前必须知道：

| | Web | PC（Tauri） |
|---|---|---|
| 后端来源 | 同源 nginx 反代（base 为空串） | 插件协商端口（9979→9980…），`boot_info` 提供 |
| 后端地址框 | 可编辑，默认空 | 默认只读，有「用插件」恢复按钮 |
| 保存地址后 | 普通刷新 | 重走 bootstrap：splash → 等 sidecar → mount |
| 启动流程 | 直接 mount | 先等 `initBackend()` 就绪再 mount（否则首屏必然“后端未连接”） |
| 多标签/多实例 | 可多开（**设置不跨标签同步**） | 单窗口 |
| 视口 | 浏览器，可能手机 | 1440×900，最小 1024×640 |
| 文件选择 | `<input type="file">` | 无 dialog 插件，走 `prompt()` 手输路径 |

**后端地址解析优先级**（`src/api/index.ts` 的 `resolveBase()`）：

```
PC：   localStorage['meow.api'] + scope='desktop'  →  boot_info.backend_base
Web：  localStorage['meow.api']  →  VITE_API_BASE  →  同源空串
```

桌面端手填地址必须带 `scope='desktop'` 标记，否则会被 Web 调试期的残留劫持（踩过）。

---

## 校验

```bash
cd apps/web
npx vue-tsc --noEmit      # 类型检查，必须 exit 0
npx vitest run            # 97 文件 / 1295 用例
npx vitest run tests/prefs.test.ts   # 单文件
pnpm legacy-css           # 重新生成老内核降级层（见下）
```

canvas 相关的 jsdom 警告（`getContext()` not implemented）**属正常**，不影响结果。

**仓库没有 ESLint / Prettier**。不要引入，也不要顺手格式化未改动的文件。

代码风格：单引号、不写分号、2 空格缩进、`<script setup lang="ts">`。

**★ `legacy-generated.css` 是手动的**：它会从 `dist/**/*.css` 里扫出用了
`gap / padding-inline / margin-block / inset / aspect-ratio / translate` 的类，
生成 `html[data-legacy-css='1']` 前缀的物理属性回退（给投影仪那台 Chrome 66 用）。
**没接进构建脚本**，所以加了这类新类之后必须手动跑一次 `pnpm legacy-css` 并提交 ——
否则新样式在投影仪上会静默丢失（2026-11-06 实测过一次：文件落后 62 行）。

---

## PC 打包

前置：Rust + MinGW（不需要 MSVC）。

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu
winget install BrechtSanders.WinLibs.POSIX.UCRT

cd apps/desktop
powershell -ExecutionPolicy Bypass -File build-gnu.ps1 --bundles nsis
```

产物：`src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/`

MinGW 装法不唯一，脚本按顺序自动探测：环境变量 `MINGW_BIN` → winget 的
WinLibs 包目录 → PATH 上的 `x86_64-w64-mingw32-gcc`。装在别处就设 `MINGW_BIN`。

- `build-gnu.ps1` 不带参数时是 `--no-bundle`，**只出 exe 不出安装包**
- 脚本会把 Git 的 `usr\bin` 从 PATH 剔除——里面的 `link.exe` 是 coreutils 的 `link`，
  不是链接器，不清掉会报 `link: extra operand` 这种指不到病因的错
- `.cargo/config.toml` 已固定 GNU target，所以 `cargo build` 也不会误走 MSVC

**安装包不含任何插件**（v0.7.0 起全外置）。首次打开一定是「后端未连接」，
在设置页配插件源后下载。这是设计如此，不是装坏了。

---

## 调试

### 内置 MCP（推荐，PC 端）

应用启动后开 18 个 `pc_*` 工具，端口从 9339 起协商，信息写 `~/.zcode/meow-mcp.json`。

```bash
curl -s http://127.0.0.1:9339/health    # 先看 cdp_ready
```

配套 skill：`~/.zcode/skills/meow-pc-smoke/`。

### 裸 CDP

```bash
run-desktop-debug.bat                  # 默认 9222
node apps/desktop/cdp.mjs shot out.png # 只截应用窗口
node apps/desktop/cdp.mjs text         # 读页面文字
node apps/desktop/cdp.mjs eval "location.hash"
node apps/desktop/cdp.mjs click "搜索"
node apps/desktop/cdp.mjs nav "#/settings"
```

也可以把端口交给 Playwright `connectOverCDP` 或 chrome://inspect。

### 前端自省钩子

| 钩子 | 用途 |
|---|---|
| `window.__meowDm` | 弹幕渲染器状态（条数、上屏率） |
| `window.__playerDebug` | 播放诊断（内核状态、HLS 分片耗时、丢帧） |
| 播放页按 `D` | 开关调试面板 |

### 冒烟脚本

```bash
node apps/desktop/smoke-fps.mjs       # PC 端弹幕帧率（需先开 CDP，目标 tauri.localhost）
node apps/desktop/smoke-fps-web.mjs   # Web 端（目标 localhost:5173）
node apps/desktop/smoke-sync.mjs      # 不同倍速下的播放同步性
```

输出是纯文本结论（fps / 长帧 / 最大间隔），不落文件。

---

## 图标

`brand/logo.svg` 是唯一源文件，其他全是生成的：

```bash
node brand/build-icons.mjs                                      # → apps/web/public + brand/logo-*.png
cd apps/desktop && npx tauri icon ../../brand/tauri-icon.png     # → src-tauri/icons/
```

设计约束：扁平、饱和纯色铺满、白色字形、无边框无底板、16px 可辨。
（用户明确否决过 3D 浮雕、深色底板、黑框。）

---

## 已知限制

- **源站时效**：不少源的播放地址绑定客户端 IP 且几分钟过期，拿到要立刻播
- **线路存活**：上游整条失效很常见；`sessionStorage` 里按线路名记失败，**不含 site/vod_id**
- **`parse=1` 的源**（部分 DuoDuoTv / SP360 / SaoHuo）：后端补 `parse:1` 但前端不读，
  地址被直接丢给 hls.js → 播放失败。Web 端不支持第三方解析器
- **画质切换**：47 个源几乎全返单 URL，没有多档可切，做不了选择器
- **外挂字幕 / 片头尾跳过**：后端 `normalizePlay()` 丢弃 `subs`/`skips`，前端拿不到
- **设置不跨标签同步**：没有 `storage` 事件监听，两个标签页会各改各的
- **`cacheDays` 设置项无消费方**：UI 有、逻辑没实现
- **PC「导入本地包」**：没有 Tauri dialog 插件，实际退化为 `prompt()` 手输路径
