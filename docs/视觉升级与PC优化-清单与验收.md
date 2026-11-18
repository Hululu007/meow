# 视觉升级与 PC 优化 · 执行文档

> 状态：**v4 FINAL（2026-11-18）**——收到执行命令后按本文逐项完成，不再二次决策
> 范围：Web / PC(Tauri) / TV(APK) / fnOS(fpk) 四端视觉 + PC 窗口与启动体验
> 依据：仓库代码、PC 实机数据、全量测试（§2）
> 落点说明：本文件暂放 `docs/`；定稿后建议迁入 `site/docs/dev/` 并在站点索引登记

---

## 0. 执行口径（默认决策已定）

| 待决项 | 默认执行 | 说明 |
|---|---|---|
| B4 红黄绿位置 | **2b：圆点在左上，悬停显示 −/□/×** | 最接近参考图且兼顾 Windows 习惯；如需 2a/2c 请在开工前一句话覆盖 |
| B2 范围 | **缩范围**：只做非播放器请求 | 播放器文件并行会话在改，弹幕/评论延后 |
| B6 海报 srcset | **不做** | 代理无缩放能力，后端件另立项目 |
| B7 调试端口 | **做成开关，默认保持开启** | 不改变现有 MCP/冒烟行为 |
| A4 字号 | **不迁移 629 处硬编码 px** | 只新增 display/title 档并用于指定场景，规避 TV 双缩放 |
| A1b 表面 | **新增 `.surface-1` 类**，不改 `--color-card` | 避免波及按钮/chip/底栏 |
| A9 Bento | **只做详情页 + 我的页** | 设置页 8214 行，不做结构重排 |
| 提交 | **不 commit / 不 tag / 不 push** | 由用户控制节奏 |

---

## 1. 开工前置检查（每次开工都跑）

```bash
cd client/apps/web
git status --short
find src tests -newermt '-10 minutes' -type f      # 是否有并行会话在写
```

判定：

1. 若 `components/player/*`、`views/PlayView.vue`、`components/library/LibraryAddDialog.vue`
   **仍在被写**（mtime 近 10 分钟）→ 等其提交，或在 `.worktree/` 单开，**不要在主工作区开工**。
2. 记录测试基线：`npx vitest run`，把“通过/失败/跳过”三个数字与失败用例名记下来。
   当前已知基线：1859 条（1852 通过 + 4 失败 + 3 跳过），4 红为并行改写造成的假红。
3. 后续验收一律用 **“失败集合不扩大”**，而不是“全绿”。

---

## 2. 基线数据

### 2.1 PC 运行时（PC 1.2.14，Settings 页）

| 指标 | 实测 |
|---|---|
| 视口 / DPR | 1440×900 / 1.5 |
| 空闲帧率 | 61 fps，长帧 0，最大间隔 17.4ms |
| JS 堆 | 13.5MB 用 / 16.9MB 总 |
| DOM / 图片 | 1148 节点 / 19 张 |
| 控制台 | 0 错误 |
| 导航 | TTFB 125ms / DCL 150ms / load 158ms |

> **归因修正**：`pc_perf` 的资源列表是**整会话累计**，不是启动项。
> `plugin_install` 13558ms 是设置页手动安装（已有 400ms 进度轮询）；
> `plugin_index` 1630ms 是设置页/后台检查。**启动无实测阻塞**。
> B0 必须按页采集。

### 2.2 构建与测试

| 项 | 实测 |
|---|---|
| dist | 3.2MB（assets 2.5MB，无 sourcemap）；CSS 141.9KB |
| 测试 | 1859 条 = 1852 通过 + 4 失败 + 3 跳过（140 文件） |

---

## 3. 端与内核能力矩阵

| 能力 | PC | Web | fpk(Safari) | TV 新机 | **TV 老机 C66** |
|---|---|---|---|---|---|
| 圆角/阴影/rgba/渐变 | ✅ | ✅ | ✅ | ✅ | ✅（阴影可关） |
| `backdrop-filter` | ✅ | ✅ | ✅ | ✅ | ❌ 实色兜底 |
| `filter: blur()` 大面 | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `aspect-ratio`/flex `gap`/`inset` | ✅ | ✅ | ✅ | ✅ | ❌ → legacy 补 |
| `color-mix` | ✅ | ✅ | ✅ | ⚠️ | ❌ 仅 accent 兜底 |
| `dvh` | ✅ | ✅ | ✅ | ✅ | ❌ **无兜底** |
| `transform/opacity` | ✅ | ✅ | ✅ | ✅ | ✅ 手写 transform |
| `prefers-reduced-motion` | ✅ | ✅ | ✅ | ✅ | ❌ 不认 |
| `:focus-visible` | ✅ | ✅ | ✅ | ✅ | ❌ → `.meow-tv-focus` |
| Tailwind `scale-*`/`translate-*` | ✅ | ✅ | ✅ | ✅ | ❌ 单属性（C104+） |

判定：`legacyCss.ts` 实测几何 → `data-legacy-css='1'`；`color-mix` 单独 `data-no-color-mix='1'`。
强制模拟：`?legacycss=1`；新增 `?nocolormix=1`（E14）。

---

## 4. 设计规格

### 4.1 表面

| 级 | 用途 | 实现 | 阴影 |
|---|---|---|---|
| L0 | 页面 | `--color-base` | — |
| L1 | 卡片/内容块 | **新增 `.surface-1`**：`background: var(--color-elevated)` + 1px `--color-line` + `--shadow-1` | legacy 关 |
| L2 | 浮层 | `--color-elevated` + 1px `--color-line-hover` + `--shadow-2` | — |
| L3 | 模态 | `--color-panel` + 内高光 + `--shadow-3` | — |

> 为什么不改 `--color-card`：它同时驱动 `.tile` / `.set-btn` / `.set-chip` / `MobileTabBar`
> 与 169 个 `bg-card`，改动会波及控件。`.surface-1` 只用于内容容器，零外溢。

### 4.2 令牌落点（硬约束）

| 约束 | 内容 | 证据 |
|---|---|---|
| H1 | 主题测试精确断言每块 **28 个变量**，不得增减 | `theme-tokens.test.ts:88-92` |
| H2 | 结构令牌放 `@theme` 才有 `rounded-*`/`shadow-*`；`:root` 只放非工具类 | `tokens.css:19-90` / `:93-149` |
| H3 | **不覆盖** Tailwind 默认 `--radius-2xl/3xl`（播放器唯一一处 `rounded-2xl`） | `VideoPlayer.vue:5849` |
| H4 | 新的每主题 RGB 三元组放**独立选择器块**；不要写进 28 变量块 | `tokens.css:1961` 既有范式 |

| 组 | 落点 | 取值 |
|---|---|---|
| 圆角 | `@theme`：`--radius-panel:18px` / `--radius-modal:22px` | 10/14/18/22 |
| 阴影 | `@theme`：`--shadow-1..3` | `0 1px 2px` / `0 4px 16px` / `0 12px 32px` |
| 阴影色 | `html[data-mode]`：`--shadow-rgb` | dark `0 0 0`；light `20 26 40` |
| 字号 | `:root`：`--fs-title` / `--fs-display`（rem） | 1.25–1.5rem / 1.75–2rem |
| 动效 | `@theme`：`--ease-spring`；`:root`：`--dur-*` | 120/180/240ms |

### 4.3 回归防护（必须逐条满足）

| # | 防护 | 原因/证据 |
|---|---|---|
| **Q1** | 动效关闭规则**排除** `.animate-spin` / 骨架微光 / 播放器控件 | 否则加载转圈静止，像卡死 |
| **Q2** | `text-[Npx]` **不迁移**；只新增字号档并用于指定场景 | 迁移会让 TV 下限规则失效并双缩放（`tokens.css:1032`） |
| **Q3** | B3 的 `StateFlags` 必须 **SIZE\|POSITION\|MAXIMIZED**，排除 `VISIBLE`/`FULLSCREEN`/`DECORATIONS` | 默认 `all()` 含 VISIBLE → 关闭到托盘后重启窗口不显示（`window-state lib.rs:52-65`） |
| **Q4** | E1 错误/空状态**不得替换 RouterView**，只叠加占位 | 旧 bug 记录在 `App.vue:1062-1070` |
| **Q5** | A3 只换外观类名：保留 `Teleport :to="host"`、`data-tv-scope`、`cancelBtn/okBtn` refs、`max-h`+内部滚动 | 电视选焦与矮屏滚动修复 |
| **Q6** | A2 不动 `[data-site-menu] { flex-shrink:0 }` | 2026-11-18 投影仪 960×540 源下拉折叠修复 |
| **Q7** | A9 不动 `wide:grid-rows-[minmax(0,1fr)]` | 设置页方向键滚不动的修复（`SettingsView.vue:4904`） |
| **Q8** | 玻璃层只动 `opacity`，不得给自身/祖先加 `transform` 动画 | `backdrop-filter` 采样根会被破坏 |
| **Q9** | B5 的 Ctrl+F **仅 Tauri 壳生效** | Web/Docker 上是浏览器查找，拦截会破坏原生功能 |
| **Q10** | 新 Tailwind 工具类出现后必须重跑 `node scripts/gen-legacy-css.mjs` | 否则老内核兜底缺失 |

---

## 5. 执行清单

> S=≤0.5d，M=0.5–1d，L=1–2d。每条都含“改哪 / 不改什么 / 验收”。

### Wave 0 — 基线与隐患（3.25 天）

| 编号 | 内容 | 改动点 | 验收 |
|---|---|---|---|
| **B0** | 按页基线 | 首页/详情/播放：每页独立 `navigation` + 1.5s 帧率探针；4 宽（390/768/1440/1920）× 3 页截图存 `tmp/2026-11-18-visual-audit/` | 三页各一份改动前数据 |
| **E10** | 截图脚本 | 固定 meow-dark + 壁纸关 + 固定视口 | 可重复产出同名图 |
| **E14** | `?nocolormix=1` | `legacyCss.ts` 支持强制挂 `data-no-color-mix` | 现代浏览器可模拟颜色退化 |
| **C1** | `dvh` 兜底 | 7 文件 15 处：先 `vh` 后 `dvh`（`tokens.css:112-118` 本就禁止 100dvh） | legacy + 720p 下 ConfirmDialog 不溢出 |
| **C2** | `color-mix` 收敛 | 5 文件 28 处 → `rgb(var(--color-X-rgb)/a)`；三元组放独立块（H4） | 正常态与 `?nocolormix=1` 布局一致 |
| **C3** | 动效守卫 | 全局覆盖：legacy 或 reduced-motion 下 `transition-duration:.01ms!important`、装饰动画 `none`；**排除 Q1 白名单** | legacy 下无装饰动画，转圈仍转 |
| **A1** | 令牌地基 | 按 §4.2；不碰 16 个主题块 | `vue-tsc` 0；测试失败集合不扩大 |

### Wave 1 — 表面与质感（4 天）

| 编号 | 内容 | 改动点 | 验收 |
|---|---|---|---|
| **A1b** | `.surface-1` | `tokens.css` 新增类；应用于 `PosterCard.vue`、首页/片库/历史/收藏的卡片容器、详情页信息块 | 8 主题×明暗 4 组截图；浅色不发灰 |
| **T1** | 表面对比度门禁 | 测试先做 alpha 合成，再校验 `ink-2/ink-3` 对 `.surface-1` / `elevated` | ≥4.5:1 |
| **E1** | 空/错/加载态 | 首页/搜索/片库/详情：图标+原因+一个动作；**保留原回调与路由出口**（Q4） | 错误时不替换 `RouterView` |
| **A3** | 对话框 + 渐变按钮 | `ConfirmDialog.vue` 仅换类名；渐变 `accent→accent-dim`；暗端对比度 | 电视可选中按钮；Esc 正常 |
| **A2** | 浮层玻璃 | `AppHeader` 下拉、`AiPanel`、`UpdateDialog`；扩 `legacy-css.css §7` | legacy 实色、零位移 |
| **E12** | `forced-colors` | 高对比度下恢复 1px 边框与焦点环 | 系统高对比度下可辨 |
| **X9** | 底栏老内核兜底 | `MobileTabBar` 直写 `backdrop-filter`，§7 匹配不到 → 补 legacy 实色 | legacy 下底栏不透明 |

### Wave 2 — 内容感（3.75 天）

| 编号 | 内容 | 改动点 | 验收 |
|---|---|---|---|
| **A4** | 大字排版 | `:root` 两档；只用于详情页片名、分区标题、空状态；TV 单独 clamp；**不迁移 629 处**（Q2） | TV 不溢出；桌面字号不变 |
| **A5a** | 详情页静态氛围 | 海报放大 + 低透明度渐变；`pointer-events:none`；不与壁纸双层 blur | 内容可点、可读 |
| **A5b** | 海报取色 | 仅代理/same-origin URL；`crossOrigin='anonymous'`；canvas 32×32；按 URL 缓存；TV 不做；失败静默 | 无控制台错误；不阻塞渲染 |
| **A7** | 动效编排 | 手写 `transform`；玻璃只动 opacity（Q8）；单屏 ≤20 元素；legacy 关 | 长帧 0 |

### Wave 3 — PC 行为线（2 天）

| 编号 | 内容 | 改动点 | 验收 |
|---|---|---|---|
| **B3** | 窗口状态 | `tauri-plugin-window-state 2.4.1`；flags 按 Q3；副屏拔掉不越界 | 托盘关闭后重启窗口可见 |
| **B2** | 慢请求反馈（缩范围） | 仅海报图/非播放器请求；超时提示与重试；**不碰播放器文件** | 无播放器改动 |
| **B5** | 快捷键 | Ctrl+F（仅 Tauri）/Esc/F11/Ctrl+0；输入框内不拦截（Q9） | Web 上浏览器查找不受影响 |

### Wave 4 — 结构增强（1.5 天）

| 编号 | 内容 | 验收 |
|---|---|---|
| **A6** | 首页 hero 折中版（首条大图 + 原 grid，不加请求） | 首屏请求数不变 |
| **A8** | Inter latin 子集（≈50KB，swap） | 顶栏截断不变；包体增幅记录 |
| **A10** | Aurora 壁纸 | 加入 `WALLPAPER_IDS` + 明/暗分组（按实测亮度），复用 4 档可见度 |

### Wave 5 — 精修（3.25 天）

| 编号 | 内容 | 验收 |
|---|---|---|
| **A3b** | 双栏玻璃对话框（`LibraryAddDialog` 落定后） | 与 A3 同规格 |
| **A9** | Bento（仅详情页 + 我的页；**设置页不动**，Q7） | TV 选焦可走通 |
| **B7** | 调试端口开关（默认开） | 关后 `pc_*` 失能、开后可恢复 |
| **B8** | 分类胶囊横向滚轮（Shift+wheel） | 不劫持纵向滚动 |
| **E13** | 包体门禁 | assets 增幅 ≤10%（基线 2.5MB） |

### Wave 6 — 窗口壳（2 天，默认 2b）

| 编号 | 内容 | 验收 |
|---|---|---|
| **B4** | `decorations:false`；左上圆点（悬停显 −/□/×）；拖拽/双击最大化/8 热区缩放/DWM 圆角与阴影 | 播放页有隐形拖拽条；`Win+方向键` 可用；Alt+F4 可用 |

B4 的 6 个坑：drag-region 只对自身元素生效；双击判 `e.detail===2`；8 热区 `startResizeDragging`；
DWM 圆角加 `Win32_Graphics_Dwm`；丢阴影用 `DwmExtendFrameIntoClientArea`；
贴靠布局需 `HTMAXBUTTON`（不做则只影响悬停面板）。

---

## 6. 依赖

```
B0/E10 ── 退化对比依据
C1/C2/C3/A1 + E14 ── 视觉地基
        ↓
A1b + T1 → A3/A2/E1/E12/X9
A4/A5a/A5b/A7 ← A1 + C3
B2/B3/B5 独立（PC 线）
B4 默认 2b；A3b 依赖 LibraryAddDialog
```

---

## 7. 验收门禁

```bash
cd client/apps/web
npx vue-tsc --noEmit                 # exit 0
npx vitest run                       # 失败集合不扩大
node scripts/gen-legacy-css.mjs      # 新增 Tailwind 类后必跑
npx vite --port 5181 --strictPort
```

| 端 | 方法 |
|---|---|
| PC | 每页 navigation + 帧率，与 B0 对比 |
| Web 桌面 | `vite 5181` |
| 手机竖屏 | 390×844 + 真机 Safari |
| TV 布局 | `?tv=1` |
| 老内核兜底 | `?legacycss=1` |
| color-mix 缺失 | `?nocolormix=1` |
| 真机 | MuMu `.76/.78`、投影仪 1280×720 C66、`.34` fpk、iPhone |

量化：

1. legacy 与正常模式布局零位移
2. C66 长帧 0、无溢出、卡片无阴影
3. 正文对比度 ≥4.5:1（含表面对比）
4. 浅色三档表面不发灰
5. PC 61fps / 0 长帧不退化
6. 手机竖屏无横向滚动、底栏不遮内容

---

## 8. 只读与不做

### 8.1 只读（本轮不碰）

| 区域 | 原因 |
|---|---|
| `components/player/*`、`views/PlayView.vue` | 并行会话在改；63 处硬编码白 |
| `index.html` 首帧主题脚本 | 防闪屏决策 |
| 16 个主题块的 28 变量集合 | H1 门禁 |
| `.meow-tv-focus` 双环 | 电视焦点可见性 |
| Tailwind `--radius-2xl/3xl` | H3 |
| `[data-site-menu] flex-shrink` / 设置页 `grid-rows` | Q6 / Q7 |

### 8.2 不做

Mica、粗野主义、全仓换圆角、全局动态换肤、首页完整版 hero、B6 srcset、B1（依据不成立，已删）。

---

## 9. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | A5 canvas 污染 | 代理 + `crossOrigin` + 同 URL |
| R2 | 取色带宽 | PosterStore 缓存；32×32；仅详情一次 |
| R3 | 16 块×28 变量 | 只加独立块，不动主题块 |
| R4 | legacy 生成器漏跑 | Q10 |
| R5 | SettingsView 8214 行 | A9 不碰设置页结构 |
| R6 | B7 失能 MCP | 默认开；开关化 |
| R7 | 低端掉帧 | 只动 transform/opacity；≤20 元素；legacy 关 |
| R8 | 并发写文件 | 前置检查；worktree |
| R9 | 渐变暗端对比 | 测 `on-accent` |
| R10 | 字号迁移 | 不迁移（Q2） |
| R11 | B3 窗口不可见 | Q3 flags |
| R12 | 玻璃+transform | Q8 |
| R13 | ambient+壁纸双 blur | A5a 约束 |
| R14 | C66 卡片阴影 | legacy 关阴影 |

---

## 10. 数据勘误（相对前几版）

| # | 旧 | 实际 |
|---|---|---|
| D1 | 343 处 px / `text-[11px]` 263 | **629 处**；`[11px]` **459** |
| D2 | 对比度要扩到 ink-2/3 | 已覆盖；缺口是表面，且需 alpha 合成 |
| D3 | `data-lacks-colormix` | **`data-no-color-mix`** |
| D4 | 1855 全绿 | **1859**（1852+4+3） |
| D5 | dvh 是新增需求 | `tokens.css:112-118` 禁止；15 处是违规 |
| D6 | B6 0.5 天 | 代理无缩放；**不做** |
| D7 | B3 手写 0.5 天 | 插件已缓存；且需排除 VISIBLE |
| D8 | C2 换 rgba | 会丢主题跟随；用 `-rgb` 三元组 |
| D9 | B1 启动慢请求 | 依据不成立；**删除** |
| D10 | pc_perf 归因启动 | 是整会话累计 |
| D11 | 覆盖 radius-2xl | 会牵动播放器；用新命名 |
| D12 | C3 改 `--dur-*` | 需全局覆盖 |
| D13 | 4 档壁纸 | **18 张壁纸**；`data-wp` 是**可见度**四档 |

---

## 11. 来源对账

| 轮次 | 内容 | 落点 |
|---|---|---|
| 1 | mac 外观三层 | A1b/A2/A3/A3b；B4；Mica 不做 |
| 2 | 六方向 | A5/A2/A6/A4/A10/A9/A1 |
| 3 | PC 清单 | B2/B3/B5/B7/B8；B1 删；B6 不做 |
| 4 | 跨端分析 | C1–C3；A1b |
| 5 | 深度核查 | H1–H3、D1–D8、E9–E13 |
| 6 | 回归防护 | H4、Q1–Q10、D9–D12 |
| 7 | 执行定稿 | 默认决策、只读/不做、验收门禁 |

---

## 12. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-18 | v1 | 合并三轮讨论 |
| 2026-11-18 | v2 | H1–H3、D1–D8、E9–E13、并发与测试基线 |
| 2026-11-18 | v3 | 删 B1；修 `pc_perf` 归因；A1b 收窄；radius 新命名；C3 全局覆盖；E14/X9；A5 约束 |
| 2026-11-18 | v4 | **执行定稿**：默认决策表、Q1–Q10 回归防护、A1b 改 `.surface-1`、A4 不迁移、B2 缩范围、B4 默认 2b、B6 不做、D13 壁纸勘误、总工时 20 天 |
