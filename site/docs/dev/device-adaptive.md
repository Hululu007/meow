# 端、设备与尺寸适配

> 这一篇是**适配判据的单一清单**：应用在哪些端/设备/尺寸下有差异、靠什么识别、
> 差异点在哪、哪些写法已经混乱到必须收口。
>
> 状态：2026-11-17 首次审计。审计对象是 `client/apps/web/src`（Web/PC/TV/fnOS
> 共用同一份前端）+ 两个壳的注入层（`client/apps/tv` 的 `tv-nav.js`、
> `client/apps/desktop` 的 `tauriInvoke`）。
>
> **改任何"按端/按尺寸显示不同"的代码前先读第 5 节规范**；第 4 节是已确认的
> 混乱点，别在上面继续加判据。

## 0. 一句话现状

没有单一的"端"概念。当前是 **11 套身份判据（A1~A11，其中三组重名/重复实现）× 4 类输入
判据 × 22 条尺寸/方向判据 × 9 个 `html[data-*]` 全局开关 × 38 个注入桥** 在交叉判断，所以同一台设备
在不同功能里会被当成不同的端 —— 这就是"划分混乱"的来源。

统计口径（`src/` 内）：

```bash
# 身份判据出现次数（TV 身份相关）
grep -rn "isTvEnv\|data-tv\|MeowTV\|meowTv\." --include=*.ts --include=*.vue . | wc -l   # 211
# 断点使用（模板里"手机档"是绝对主流）
grep -ro "max-sm:" --include=*.vue --include=*.ts . | wc -l   # 224（sm: 302 / md: 74 / lg: 20 / wide: 21）
```

## 1. 判据全景

### 1.1 身份：你在哪个壳里

| ID | 判据 | 定义位置（符号） | 谁在用 | 备注 |
|---|---|---|---|---|
| A1 | `html[data-tv='1']` 或 UA `/MeowTV/i` | `composables/useCardCols.ts` `isTvEnv()` | 33 处 JS：VideoPlayer / useCardCols / LiveView | TV 壳 `MainActivity` 注入；`?tv=1` 可调试 |
| A2 | CSS `html[data-tv='1']` | `styles/tokens.css` | `tv-hide` / `tv-unstick` / TV 字号 / `--header-h` / `nav-label`·`touch-hide` 的排除 | 与 A1 同源、不同写法 |
| A3 | `meowTv.platform` 是函数 | `stores/tvMenu.ts` `isTvShell()` | 菜单键 / 返回键 | — |
| A4 | `meowTv.moduleCheck` 是函数 | `stores/updateCenter.ts` `isTvShell()` | 更新中心 | **与 A3 同名不同判据**（老壳会分叉） |
| A5 | `tauriInvoke() !== null` | `api/appUpdate.ts` `isDesktopShell()` | 平台判定 / 更新清单 | — |
| A6 | `'__TAURI_INTERNALS__' in w \|\| '__TAURI__' in w` | `api/index.ts` `isTauri()` | base 解析 / LLM / 手填地址 | **与 A5 同义、两份代码** |
| A7 | `currentPlatform()`：desktop → `meowTv.appUpdaterPlatform()` → web | `api/appUpdate.ts` | 更新包匹配（windows-x64 / android-arm64 / x86_64 / armv7 / web） | 每次调用重算 |
| A8 | `detectFpkShell()`：探 `/api/_shell/*` + `/app-center/*` | `api/fpkUpgrade.ts` | fnOS 更新、能力分派 | 「Web 平台但能力不同」 |
| A9 | `isBigScreenLandscape()`：横屏 + 短边≥480 + 无 `any-pointer: fine` | `compat/deviceForm.ts` | 播放页/直播页**返回键显隐** | 纯形态判据，和 A1–A4 无关 |
| A10 | `platformName() === 'tv'`（桥方法**返回值**） | `api/nativeBridge.ts`，用在 `SettingsView.vue` 的 `tvMode` | 设置页端分区、本机执行/运行时模块、远程调试开关 | **与 A3（方法存在性）不同判据**；当前 `TvBridge.platform()` 恒返回 `"tv"` |
| A11 | `isDesktop()`（第三处 PC 判据） | `api/index.ts` | SettingsView `desktop`、UpdateCenter `desktop` | 与 A5/A6 语义重叠 |

补充：`api/appUpdate.ts` 还有 `isDesktop()`（`api/index.ts` 导出）第三处入口，
语义与 A5/A6 重叠。

### 1.2 输入方式

| ID | 判据 | 位置 | 用途 |
|---|---|---|---|
| B1 | `html[data-input='touch'\|'key']`（横屏默认 `key`；竖屏有触点默认 `touch`；按键/触摸事件覆盖） | `compat/inputModality.ts` | 焦点环 `meow-tv-focus` 显隐 |
| B2 | `(pointer: coarse)` / `(any-pointer: fine)` | VideoPlayer（竖滑、长按、双击）、deviceForm、tokens.css | 手势是否可用、光标隐藏、本次新增两个 media |
| B3 | `navigator.maxTouchPoints > 0` | inputModality | B1 的输入 |
| B4 | `'ontouchstart' in window` | VideoPlayer `isTouch` | 双击分区、触屏判定 |

历史教训：`(hover: none)` **不能**当输入方式判据（模拟器/带鼠标的盒子会翻转，
曾出现"同一点法有时弹框有时直接删"）——已从 History/Favorites 移除，不要再加回来。

### 1.3 尺寸与方向

| 阈值 | 用途 | 位置 |
|---|---|---|
| 短边 **480** | 大屏电视形态（A9） | `compat/deviceForm.ts` |
| **640**（`sm`） | 手机 / 非手机分界（`max-sm:` 224 处、`sm:` 302 处） | Tailwind + `MobileTabBar` 的 `@media (max-width:639px)` |
| **768**（`md`） | 顶栏导航档位、搜索页源栏占宽、投屏面板锚定 | Tailwind；`SearchView.vue` `innerWidth >= 768`；`PlayView.vue` `innerWidth >= 768` |
| **899** | 顶栏导航文字图标化（2026-11-17 新增） | `tokens.css` |
| **1000** | 卡片目标宽 104 / 112 分档 | `useCardCols.ts` |
| **1023** | 控制栏重播/刷新 `.touch-hide`（2026-11-17 新增） | `tokens.css` |
| **1024**（`lg`） | 历史遗留双栏（设置页已改 `wide`） | Tailwind |
| **1280**（`xl`） | 顶栏同步徽标文字 | `AppHeader.vue` |
| **520**（CSS `max-height`）/ **560**（JS） | 海报行距收紧 / `compact` | `tokens.css` / `useCardCols.ts` |
| `orientation: landscape` 或 `pointer: fine` | 自定义变体 `wide`（设置页双栏） | `tokens.css` `@custom-variant` |
| 卡宽 76 / 104 / 112 + 矮屏加列 | 海报列数算法 | `resolveCardCols()` |
| `prefs.homeCols` | 列数上限（用户设置） | 设置页「外观」 |
| `--header-h` 三档 | 默认 4rem / TV 4.5rem / 手机 `3.5rem + safe-area` | `tokens.css` |
| 方向 | `wide`（orientation）、inputModality（`innerWidth>=innerHeight`）、deviceForm（同）、PlayView（`>=768`） | 四处各自实现 |
| `visualViewport` 键盘 | 布局视口高 − visualViewport 高 **> 120** → 键盘弹起（隐藏底部 tabbar） | `MobileTabBar.vue` |
| **359**（超窄屏） | 设置页 `.set-grid` 变单列（Galaxy Fold 外屏 / iPhone SE 一类） | `tokens.css` |
| TV 字号阶梯 **1280 / 1920 / 2400** | `html[data-tv]` 根字号 16 → 18 → 20 → **24px**（所有 rem 一起放大） | `tokens.css`（`tests/tv-font-scale.test.ts` 锁住） |

**`prefs` 里与端相关的字段**（用户设置层，不是判据）：

| 字段 | 端相关性 | 说明 |
|---|---|---|
| `homeCols` | 全端 | 海报列数**上限**（默认 6），实际列数由卡宽算法算 |
| `closeToTray` | PC 专属 | 关闭窗口收托盘（Web/TV 无此语义） |
| `autoCheckApp` / `autoCheckModule` / `autoCheckPlugins` / `autoCheckFpk` | 按 `capability` 生效 | 四条自动检查分别对应 shell / TV 模块 / PC 插件 / fnOS |
| `searchLayout` / `videoFit` / `danmaku*` | 无 | 纯偏好，不做端差异 |

### 1.4 能力探测（**这是唯一推荐做法**）

判断"能不能用"只探能力，不猜身份：

| 能力 | 探测方式 | 位置 |
|---|---|---|
| 系统音量/亮度 | `meowTv.getVolume/setVolume/getBrightness/setBrightness` 存在 | `api/nativeBridge.ts` |
| 原生播放器兜底 | `meowTv.nativePlayerAvailable()` | `nativeBridge.ts` / `VideoPlayer.vue` |
| 原生输入框（遥控器打字） | `meowTv.inputText` 存在 | `nativeBridge.ts` |
| 原生 HLS | `video.canPlayType('application/vnd.apple.mpegurl')` | `player/mediaKind.ts` `hasNativeHls()` |
| 画中画 | `document.pictureInPictureEnabled` | VideoPlayer |
| 系统休眠 | `hasSystemSleep()` | nativeBridge |
| 更新安装 | `capability`：`shell` / `fpk` / `none` | `stores/updateCenter.ts`（见 P2-8，目前三处各算） |

### 1.5 全局样式开关（`html[data-*]`）

| 属性 | 含义 | 设置者 | 影响面 |
|---|---|---|---|
| `data-tv='1'` | TV 壳身份 | TV 壳 / `?tv=1` | 61 处选择器：字号档、`--header-h`、`tv-hide`… |
| `data-input='touch'\|'key'` | 当前输入方式 | `compat/inputModality.ts` | 焦点环 |
| `data-legacy-css='1'` | 老内核 CSS 降级 | `styles/legacyCss.ts`（**实测探针**：flex gap / aspect-ratio / padding-inline / color-mix） | `legacy-generated.css` **255 条规则** |
| `data-style` / `data-mode` | 主题风格 / 明暗 | `stores/theme.ts` | 全站配色 |
| `data-wallpaper` / `data-wp` | 壁纸 | 壁纸设置 | 背景 |
| `data-tv-ime` | TV 输入法提示 | 壳 | TV 输入 |
| `data-no-color-mix` | 探针结果（不支持 color-mix） | legacyCss | 主题色降级 |

调试入口：`?tv=1`（强制 TV 布局）、`?legacycss=0|1`（强制关闭/开启降级）。

**其它环境判据（不属"端"，但同样改变显示）**：

| 判据 | 影响 | 位置 |
|---|---|---|
| `prefers-color-scheme` | 首次进入时的明暗主题（用户手动切过则以 prefs 为准） | `index.html` 首帧脚本 / `stores/theme.ts` |
| 老内核 API 补丁 | Chromium 66（Android 9 电视/投影）缺 `Promise.allSettled` / `flatMap` / `fromEntries` / `matchAll` / `.at` / `hasOwn`，`main.ts` **第一行**引入补丁；不能挪位置 | `compat/legacyPolyfills.ts` |
| `visualViewport` | 键盘弹起（差值 >120）时隐藏底部 tabbar | `MobileTabBar.vue` |

## 2. 端 × 功能矩阵（当前实际行为）

| 功能 | Web/PC 浏览器 | 手机竖屏 | 手机横屏 | TV 壳 | PC 壳（Tauri） | fnOS（fpk） |
|---|---|---|---|---|---|---|
| 顶栏导航文字 | 显示 | 多数不渲染（<640） | **图标化**（<900） | 显示（A2 排除） | 显示 | 同 Web |
| 底部 tabbar | `max-width:639px` 时显示 | 显示 | 不显示 | TV 竖屏（MuMu 360）会显示 | 不显示 | 不显示 |
| 设置页布局 | `wide` → 双栏 | 竖屏胶囊 | **双栏** | 双栏 | 双栏 | 双栏 |
| 海报列数 | 卡宽算法 + `homeCols` | 3 列 | **6 列**（矮屏加列） | 目标卡宽 76（内容宽≥640） | 同 Web | 同 Web |
| 播放页返回键 | 显示 | 显示 | 显示 | **大屏横屏隐藏**（A9） | 显示 | 显示 |
| 焦点环 | 横屏 `key` / 竖屏 `touch` | touch | key | `data-input` | key | 同 Web |
| 直播页 | 视口方向引导 | 同 | 同 | 方向键归属 `__meowTvKeyOwner` + 锁横屏 + 大屏隐藏引导 | 同 | 同 |
| 双击画面 | 全屏 | 分左/中/右区 | 分区 | 分区 | 全屏 | 全屏 |
| 竖滑亮度/音量 | 无（鼠标） | 有 | 有 | 有（**系统桥**真调） | 无 | 无 |
| 系统音量/亮度 | — | **iPhone 提示「用侧键」** | 同 | 真机桥 | — | — |
| 原生播放器兜底 | 无 | 无 | 无 | **ExoPlayer** | 无 | 无 |
| 投屏 | 有（同源 base） | 有 | 有 | 有（LAN 监听） | 有（LAN 监听） | 有（同源） |
| 在线更新 | 无安装包 | 无 | 无 | APK 清单（A3/A4/A7） | setup/插件（A5/A7） | **fpk 应用中心**（A8） |
| 托盘 / 关闭行为 | — | — | — | — | **有** | — |
| 焦点环样式 | `meow-tv-focus` | 默认不画 | 画 | 画 | 画 | 画 |

## 3. 混合态：为什么"划分混乱"（四个真实案例）

**案例 1：MuMu 模拟器竖屏（360×640）**
`data-tv='1'`（A1/A2 真）→ TV 身份；`max-sm` 命中 → 手机竖屏布局；
`html[data-tv]` 字号档 → 电视字号；`maxTouchPoints>0` → 输入 touch。
结果是「TV 身份 + 手机布局 + 电视字号」，卡宽算法还要额外补丁
（`tvWide = tv && usableWidth >= 640`）来避免算成 4 列 66px。

**案例 2：iPad 竖屏（768×1024）**
搜索页按 `innerWidth>=768` 给左右分栏（平板）；设置页按 `orientation:portrait`
给胶囊（手机）；顶栏按 `<900` 给文字（平板）；卡片按卡宽算 6 列（平板）。
**同一个页面切换，四个功能给四种"你是什么设备"的答案。**

**案例 3：手机横屏（852×393）**
`max-sm` 不命中（按桌面样式渲染），但 `pointer:coarse`/`isTouch` 为真（触摸交互）；
控制栏 `1023` 收按钮、顶栏 `899` 收文字 —— 两个阈值不同，用户会看到
"有的东西横过来就变、有的不变"。

**案例 4：iPhone Safari / PWA**
无 `requestFullscreen`（平台限制）→ 走伪全屏兜底；`video.volume` 赋值被系统忽略
→ 音量手势改提示侧键；原生 HLS 可用 → 不需要 hls.js。
判据全部是**能力探测**（B 类 + `hasNativeHls`），这部分是正确示范。

> **既有决策（不要回退）**：全屏**不要**改调 `video.webkitEnterFullscreen()`。
> 它会把播放交给 iOS 原生播放器，DOM 全被盖住 —— 弹幕层和自定义控制栏一起消失，
> 等于换了个播放器（见 `VideoPlayer.vue` 伪全屏函数上方的注释）。
> iOS 上正确做法是「容器撑满视口」的伪全屏：弹幕与控件留在原地，代价只是
> 地址栏不隐藏。若要做原生播放器全屏，只能作为「更多」里的**可选入口**。

### 3.5 端专属控制清单（组件 / 事件 / 桥）

这些是"额外控制"的另一半：不在样式里，而是在事件与桥上。改动前先确认所属端。

| 控制 | 形态 | 端 | 位置 |
|---|---|---|---|
| 返回键接管 | `window.__meowTvConsumeBack`（链式，本页先消费，否则交上一任） | TV 壳 | `App.vue`、PlayView、ExternalPlayView、UpdateDialog |
| 方向键归属 | `window.__meowTvKeyOwner`（页面声明"方向键归我"，如播放页进度条） | TV 壳 | VideoPlayer / LiveView |
| 焦点搬运 | `window.__meowTvFocus(el, pin)`（`tv-nav.js` 注入） | TV 壳 | 各面板 |
| 菜单键 | `registerTvMenuHandler()`（详情/历史/设置页各自的菜单动作） | TV 壳 | `stores/tvMenu.ts` |
| 原生播放器兜底 | `meowTv.nativePlayerAvailable()` / `openNative(url,title,headers,pos)` | TV 壳 | `nativeBridge.ts` |
| 原生输入框 | `meowTv.inputText(title, initial, mask, theme)` | TV 壳 | 搜索/设置输入 |
| 主题推给原生页 | `meowTv.setUiTheme(json)`（TV 配置页没有 WebView） | TV 壳 | `nativeBridge.ts` |
| 系统音量/亮度 | `get/setVolume`、`get/setBrightness` | TV 壳 | nativeBridge |
| 伪全屏事件 | `window` 自定义事件 `meow:pseudofs`（detail=boolean） | 全端（iOS 触发） | VideoPlayer → App.vue |
| 托盘/关闭行为 | `tauriInvoke` 命令（`desktop_*`）；关窗提示由 Rust `window.__meowTrayHint?.()` 触发 `TrayHintDialog` | PC 壳 | `api/index.ts`、`App.vue`、`TrayHintDialog.vue` |
| 目录选择 | PC：Tauri dialog；TV：`MANAGE_EXTERNAL_STORAGE` + 内置浏览器；Web：目录选择器 | 三端不同 | `LibraryAddView` / `api/library.ts` |
| 局域网后端扫描 | `scanLanBackends()`（HTTP 探测 30010/9979） | 全端同一实现 | `utils/lanScanWeb.ts` |
| 键盘弹起 | `visualViewport` 差值 >120 → 隐藏 tabbar | 移动端 | `MobileTabBar.vue` |
| 投屏接收页 | `/ext-play`（`mutedFallback` 静音起播兜底） | 全端（接收端） | `views/ExternalPlayView.vue` |
| 老内核降级 | `data-legacy-css='1'`（实测探针） | 老 Android WebView | `styles/legacyCss.ts` |
| TV 专用弹层 | `TvActionSheet` / `TileSelect` / `TilePanel` | TV 壳 | 设置/片库/壁纸 |
| TV 字号档 | `html[data-tv]` 下顶栏 17px / 次要 15px / 图标 22px | TV 壳 | `tokens.css` |
| 设置页端专属分区 | `desktopOnly`：本机插件 / 桌面端行为；`tvOnly`：本机执行 / 运行时模块 | PC / TV 壳 | `SettingsView.vue` `NAV_ITEMS` + `tvMode` |
| 远程调试 | TV：DebugServer 开关 + 令牌（每次重开更换）；PC：只读展示；Web：不显示 | TV / PC / Web | `SettingsView.vue`（维护分区） |
| 页面缩放锁 1 | TV 壳把 viewport `min/max-scale` 写 1（旋转后保持 100%） | TV 壳 | `index.html` 首帧脚本 |
| 安全区 | 顶栏 `--header-h`、`--tabbar-h`、`--tabbar-clear`、AI 面板 padding 读 `env(safe-area-inset-*)` | 手机（刘海/手势条） | `tokens.css`、`MobileTabBar.vue`、`AiPanel.vue` |
| 弹层焦点作用域 | `data-tv-scope`（方向键收窄到弹层内，全仓约 100 处） | TV 壳 | 几乎每个浮层（VideoPlayer 26 处最多） |
| 初始焦点 | `data-tv-first`（打开弹层后落点；优先级最高） | TV 壳 | AiPanel/DetailView/播放器面板 |
| 滚动停靠点 | `data-tv-scroll`（焦点跟随滚动） | TV 壳 | 长列表/设置页/日志 |
| 内缩焦点框 | `data-tv-inset-focus`（贴边按钮的焦点框内缩） | TV 壳 | `tv-nav.js` |
| MCP / 调试控制面 | PC 18 个 `pc_*`（应用内线程）；TV 13 个 `tv_*` + `X-Meow-Token`；Docker/fnOS 无服务端 MCP | PC / TV / 其他 | `client/apps/desktop`、`client/apps/tv` `DebugServer` |
| 投屏设备名 | TV：`meowTv.deviceName()`；PC：`isDesktop()` → `'PC'` | TV / PC | `api/library.ts` |
| 启动容错 | 后端连不上时的重试次数：`isDesktop()` → **4 次**，其他端 1 次 | PC | `stores/app.ts` |
| AI 面板开关 | `window.__meowAiOpen/__meowAiClose/__meowAiIsOpen`（壳/系统入口触发） | TV / PC | `AiPanel.vue` |
| 媒体互斥 | `window.__meowWebviewPause/__meowWebviewResume`（原生播放器抢占/交还音频） | TV 壳 | `utils/mediaExclusive.ts` |
| 屏幕方向锁定 | `meowTv.setOrientation('landscape'|'portrait'|'auto')`；网页端无此桥 → 静默失败，靠竖屏提示 | TV 壳 | `LiveView.vue`、`VideoPlayer.vue` |

### 3.6 TV 焦点体系（`tv-nav.js`，端差异最大的单块）

TV 的"显示差异"一半来自 CSS，另一半来自**注入脚本 `tv-nav.js`**（壳在页面加载后注入，
`client/apps/tv/app/src/main/assets/tv-nav.js`）。它读四个 data 属性做焦点管理：

| 属性 | 语义 | 优先级 |
|---|---|---|
| `data-tv-scope` | 把方向键收窄到这个容器内（弹层/面板） | 最近的祖先生效 |
| `data-tv-first` | 打开弹层后的初始焦点落点 | `data-tv-first` > 当前焦点 > 第一个 input > 第一个可聚焦元素 |
| `data-tv-scroll` | 滚动停靠点（焦点移动时容器跟随滚动） | — |
| `data-tv-inset-focus` | 贴边按钮的焦点框内缩（否则被 `overflow` 裁掉） | — |

按键语义（播放页）：左右 = 快退/快进（`ArrowLeft/Right`），上下 = 切换音量/静音
（`ArrowUp/Down`），OK = 播放/暂停，返回键两级（先暂停、2.5 秒内再按才退出）。
这些分支都在 `VideoPlayer.vue` 的 `isTvEnv()` 判断里 —— 改按键行为前先看这里。

**规范（5.5 的延伸）**：新增弹层时必须标 `data-tv-scope`；有明确初始焦点就标
`data-tv-first`；长列表标 `data-tv-scroll`。漏标的表现是"遥控器方向键跑到弹层外面"。

### 3.7 Native → JS 注入桥（PC CDP / TV evaluateJavascript）

页面通过 38 个 `window.__meow*` 全局函数被"外部"驱动：PC 的 MCP 走 CDP（能 await
Promise），TV 的壳走 `evaluateJavascript`（同步回调，拿不到 Promise）——所以同一功能
有**两条通道**：

| 通道 | 形态 | 谁在用 |
|---|---|---|
| Promise 版 | `__meowPolicyJson` / `__meowPolicyApply` / `__meowPrefsJson` / `__meowWebdavJson` / `__meowUpdateJson` … | PC（CDP awaitPromise） |
| 投任务 + 轮询 | `__meowPolicyStart` / `__meowPolicyReadStart` / `__meowPolicyPoll` / `__meowToolStart` / `__meowActionStart` | TV（`MainActivity.pushPrefsHost`） |

分组（改任何一组前先确认两端通道都覆盖）：

- **配置注入**：`__meowPolicy*`（后端 policy 读写）、`__meowPrefs*`、`__meowWebdav*`、`__meowUpdate*`、`__meowTool*`
- **动作**：`__meowActionStart`（清搜索缓存 / 重置源健康）
- **AI**：`__meowAiOpen/AiClose/AiIsOpen`
- **媒体**：`__meowPauseMedia`、`__meowWebviewPause/Resume`、`__meowActionStart` 的同族
- **导航/返回栈**：`__meowTvConsumeBack`（链式）、`__meowTvRouteBack`、`__meowTvPageBack`、`__meowOwn`（归属标记）、`__meowInner`（内层标记）
- **投屏**：`__meowCastConfirm`、`__meowCastCancel`
- **诊断**：`__meowDiag`、`__meowTvMenuHook`

**规范**：新增"外部可调"能力时，Promise 版与轮询版**必须同时提供**（否则 TV 端不可用），
并在本表登记；不要只在 PC 侧测通就宣布完成。

### 3.8 壳侧能力清单（分组，完整清单看源码）

**TV 壳：`TvBridge.java` 86 个 `@JavascriptInterface` 方法**（按功能分组）：

| 组 | 代表方法 | 用途 |
|---|---|---|
| 设备 | `platform` / `deviceName` / `appVersion` / `setOrientation` | 身份、投屏设备名、版本、锁方向 |
| 输入 | `inputText`(×2) / `showIme` / `setEditing` / `setUiTheme` | 遥控器打字、主题传给原生输入框 |
| 播放 | `nativePlayerAvailable` / `openNative` | ExoPlayer 兜底 |
| 投屏 | `castConfirmResult` | 首投确认回执 |
| 连接 | `connState` / `saveConn` / `reloadApp` | 后端地址持久化（真源在壳 prefs） |
| 本地网关 | `localGatewayRunning` / `startLocalGateway`(×2) / `startScan` / `scanRunning` / `scanResult` | 端内 9978 网关与局域网后端扫描 |
| 推送 | `pushRunning` / `togglePush` / `pushToken` | 推送/远程调试令牌 |
| 更新 | `appUpdaterPlatform` / `appUpdateManifest` / `appUpdateDownload` / `appUpdateState` / `appUpdateInstall` / `netJobStart` / `netJobPoll` … | APK 更新与网络任务（同步回调 + 轮询） |
| 模块 | `moduleState` / `moduleSetEnabled` / `moduleCheckFromText` | 运行时模块（tv-node） |
| 载荷 | `payloadCheck` / `payloadState` | 弹幕载荷 |
| 调试 | `debugState` / `setDebugEnabled` / `crashLog` / `clearCrashLog` | 远程调试与崩溃日志 |

**PC 壳：`client/apps/desktop/src-tauri` 43 个 `#[tauri::command]`**（含 `desktop_*` 9 个：
托盘/光标/单实例/唤醒）；**另有 MCP 18 个 `pc_*`，是独立的 JSON-RPC 工具，不是 Tauri
命令**（由应用内线程提供，见 `mcp.rs`）。

**规范**：这张表只做「分组导览」。新增壳能力时同步
`site/docs/dev/tv-integration.md`（TV）与 `plugin-system.md`（PC 插件），
不要在本篇堆方法签名。

## 4. 混乱点清单（按严重度）

### P0（会分叉，必须收口）

- **P0-1 同一概念五套判据。** 「是不是 TV」同时有 A1（data-tv/UA）、A3（`platform`
  方法存在）、A4（`moduleCheck` 方法存在）、A10（`platform()` 返回 `'tv'`）、A9（形态）。
  其中 A3/A4 **函数同名、判据不同**（老壳只有 platform 时：菜单键认为"是 TV"、
  更新中心认为"不是"）；A3 与 A10 也不同（存在性 vs 返回值——将来出手机 App 时
  `platform()` 返回 `'android'`，A3 仍判 TV、A10 判非 TV）。
- **P0-2 「TV」被当成四个含义用。** 身份 / 无鼠标 / 大屏 / 遥控输入四件事被一个
  `isTvEnv()` 承担；MuMu 竖屏同时满足前两个而违反后两个，已出现补丁叠补丁。
- **P0-3 PC 身份三份实现。** A5（`tauriInvoke`）、A6（全局变量）、A11（`isDesktop()`）
  语义相同、代码三份；Tauri dev 插件未就绪时可能不同结论（base 解析 vs 更新判定）。

### P1（用户可感知的"不一致"）

- **P1-4 一台 iPad 竖屏四种答案**（见案例 2）。根因：搜索/播放用宽度、设置用方向、
  顶栏用 900、卡片用卡宽，四套坐标系。
- **P1-5 「手机」两套语义。** CSS 按 `<640`（`max-sm:`），JS 按 `pointer:coarse` /
  `isTouch` / `innerHeight<560`。852 宽的手机横屏 = 桌面样式 + 触摸交互。
- **P1-6 方向判据四种写法**（`orientation` / `innerWidth>=innerHeight` / `>=768`）。
  1024 横屏平板、768 竖屏平板正好落在缝隙里。
- **P1-7 矮屏阈值两个**（CSS 520 / JS 560）：520–560 之间会出现"JS 只铺 2 行、
  CSS 行距没收紧"。

### P2（维护成本，会持续制造新的混乱）

- **P2-8 更新能力算三遍**：`App.vue`（自动检查分派）、`UpdateCenter`（行状态）、
  `FpkUpgradePanel`（自探测）。历史已出过"两行状态不一致"，目前仍是三处。
- **P2-9 端专属类名在膨胀**：`tv-hide` / `tv-unstick` / `touch-hide` /
  `menu-replay` / `nav-label` / `has-tabbar`。没有登记处，本轮一次就新增 3 个。
- **P2-10 列数三层叠加**：`prefs.homeCols`（上限）→ `resolveCardCols`（卡宽算法）→
  TV 目标卡宽 76（第三层）。优先级只在注释里；本轮历史页漏了第二层（写死断点）。
- **P2-11 老内核降级是一整套并行样式表**：`data-legacy-css` 有 255 条规则，
  与 Tailwind 类名重叠。改动 Tailwind 间距类时要意识到老内核走的是另一份。
- **P2-12 全屏有三种实现 + 一个事件桥**：`requestFullscreen`（真全屏）/ 伪全屏
  （`pseudoFs` + `meow:pseudofs` 事件）/ iOS 铺满；状态分散在 `fullscreen`、
  `pseudoFs`、`fsIntent` 三份，判断在 VideoPlayer，副作用在 App.vue。
  改全屏逻辑时三处都要看（含"换集后恢复全屏"的 `rememberFsIntent`）。

## 5. 规范（目标模型，改代码前读这节）

### 5.1 单一数据源：`compat/deviceProfile.ts`

开机算一次，输出到 `<html>`，全应用只读属性/导出常量，**不允许在业务组件里
自己 matchMedia / 读 UA**：

```ts
// 目标结构（尚未实现，按 PR 分步落地）
type Shell = 'web' | 'tauri' | 'tv' | 'fpk'     // 身份（壳）
type Form = 'phone' | 'tablet' | 'desktop' | 'tv-large'  // 形态（宽高方向）
type Input = 'touch' | 'key'                    // 输入（已有：data-input）
type Orient = 'portrait' | 'landscape'

html.dataset.shell = shell    // 替代 A1/A5/A6/A8 散判
html.dataset.form = form      // 替代 A9 + 尺寸阈值组合
html.dataset.orient = orient  // 替代四套方向判据
// + 已有的 data-input / data-tv（兼容期保留，逐步只作为别名）
```

- `shell` 判断顺序：`tauriInvoke` → TV 壳（**先 `moduleCheck` 再 `platform` 兜底**）
  → `detectFpkShell` → `web`；UA `MeowTV` 只作为首屏兜底（壳注入晚于首屏）。
- `form`：竖屏且短边 <640 → phone；竖屏 → tablet；横屏且短边 <480 → tablet；
  横屏且短边 ≥480 且无 `any-pointer:fine` → tv-large；其余 desktop。
- resize/旋转只更新属性（debounce 100ms），不重建组件。

### 5.2 身份只认"壳"

- A3/A4 合并为一个 `isTvShell()`；A5/A6 合并为一个 `isDesktopShell()`；删除 UA 推断
  作为**显示判据**（只允许出现在 `deviceProfile` 的首屏兜底里）。
- `?tv=1` / `?legacycss=1` 保留为调试覆盖，禁止业务代码读 query。

### 5.3 能力只认桥方法

保留第 1.4 节做法。新增端差异时先问"这是能力还是身份"：
- 能力（能不能用原生播放器、能不能调系统音量）→ 探桥方法，**永不读身份**。
- 身份（PC 要不要显示托盘、TV 要不要隐藏返回键）→ 读 `data-shell` / `data-form`。

> 现有正面样板：`LiveView.vue` 的紧凑布局判据写的是**视口方向**而不是 `isTvEnv()`
> （注释：TV APK 也可能装在手机上、即竖屏）——这就是「形态归形态、身份归身份」。

### 5.4 尺寸收敛到 3+1

只保留：**640**（手机/平板）、**768**（导航密度）、**1024**（双栏）、
矮屏统一 **520**。删除 899 / 1023 / 560 / 480（480 并入 `form` 的单次计算）、
`innerWidth>=768` 的两处手写判断。

### 5.5 端专属样式改 `data-form` / `data-shell` 选择器

```css
/* 新写法（在 tokens.css 同一区块登记） */
html[data-shell='tv'] .hide-on-tv { display: none !important; }
html[data-form='phone'] .only-wide { display: none !important; }
```

现有 6 个类保留一个版本作为别名（`tv-hide ≡ hide-on-tv`），下个版本删除。
**新增"某端隐藏"必须先在这里登记**，不允许到处 `matchMedia`。

### 5.6 列数三层收敛为两层

`prefs.homeCols`（上限）→ `resolveCardCols`（目标卡宽 + 矮屏加列）。
删除 TV 目标卡宽 76 这一层，由 `form='tv-large'` 直接给 target=76。
所有海报列表（首页/历史/收藏/搜索/片库/分类/缓存）**必须**用
`colsStyle(useCardCols())`，禁止写死断点（门禁见 6.D）。

## 6. 整改路线（按 PR 拆分，可独立验收）

**阶段 0（先做，风险最低，均为独立几十行）**：修 8.3 的 5 个现存缺陷——
D-1 焦点环判据（`maxTouchPoints`→`pointer: coarse`）、D-2 `isTvShell` 拆身份/能力、
D-3 `FpkUpgradePanel` 改读 store、D-4 设置页判据统一、D-5 双击按事件来源。
每项验收：PC 竖窗口按方向键出焦点环（D-1）、老壳/新壳更新行一致（D-2/D-3）、
鼠标双击全屏而手指双击分区（D-5）。


- **A. 身份去重（低风险，半天）**：合并 `isTvShell` 两份（moduleCheck 优先，platform
  兜底）；合并 `isTauri` / `isDesktopShell`；`currentPlatform()` 结果缓存。
  验收：`grep -rn "isTvShell" src` 只剩一处定义；老壳（只有 platform）在更新中心与
  菜单键结论一致。
- **B. 尺寸收口（半天）**：按 5.4 替换阈值；`nav-label` 改 900→1024 或用 `form`；
  `touch-hide` 与 `nav-label` 用同一判据；矮屏统一 520。
  验收：`grep -rn "innerWidth >= 768\|innerHeight < 560\|max-width: 899\|max-width: 1023" src` 为空。
- **C. deviceProfile 落地（1~2 天）**：新增 `compat/deviceProfile.ts`，接入
  `main.ts` 首屏；业务侧改读 `data-shell` / `data-form`；`isTvEnv()` 变成
  读 dataset 的薄封装（兼容旧调用）。
  验收：第 2 节矩阵逐格用 Playwright 断言（852 横屏 / 390 竖屏 / 1280 PC /
  768 平板竖屏 / 1138 TV 仿真 五套视口）。
- **D. 门禁（半天）**：`tests/device-profile.test.ts` 扫 `src/`，除 `compat/` 外
  禁止出现：`/MeowTV/i`、`matchMedia('(pointer`、`innerWidth >=`、`innerHeight <`、
  `userAgent`；并断言所有 `poster-grid` 处都用了 `colsStyle`。
- **E. 更新能力收口（半天）**：`capability` 只在 `stores/updateCenter.ts` 算一次，
  App / UpdateCenter / FpkUpgradePanel 只读。
  验收：断开 `/api/_shell/info` 时三处结论一致（都 none）。

## 7. 验收断言（可执行）

```bash
# 1) 身份单一来源（A 阶段后）
grep -rn "export function isTvShell" client/apps/web/src   # 期望 1 处
grep -rn "MeowTV" client/apps/web/src/compat client/apps/web/src/views  # 期望仅 compat 命中

# 2) 阈值收口（B 阶段后）
grep -rn "max-width: 899\|max-width: 1023\|innerHeight < 560" client/apps/web/src  # 期望空

# 3) 海报列表统一（D 阶段后）
grep -rn "grid-cols-3 gap-x-4\|md:grid-cols-4 lg:grid-cols-6" client/apps/web/src/views  # 期望空

# 4) 前端回归
cd client/apps/web && npx vue-tsc --noEmit && npx vitest run
```

Playwright 断言矩阵（五项视口 × 第 2 节行）见 `smoke/` 现有冒烟脚本的组织方式；
断言的判据是 DOM 几何与 `html[data-*]`，不是截图肉眼。

## 8. 二次核查：判据精度与回归风险（2026-11-17）

### 8.1 信号实测矩阵（Playwright，Chromium）

| 环境 | 视口 | pointer | any-pointer | maxTouchPoints | hover |
|---|---|---|---|---|---|
| PC 桌面（无触摸） | 1280×720 | fine | fine | **10** | hover |
| PC + hasTouch（模拟触摸屏） | 1280×720 | **coarse** | coarse | 1 | none |
| 手机竖屏 | 390×844 | coarse | coarse | 1 | none |
| 手机横屏 | 852×393 | coarse | coarse | 1 | none |
| 平板竖屏 | 768×1024 | coarse | coarse | 1 | none |
| 平板横屏 | 1024×768 | coarse | coarse | 1 | none |
| TV 仿真（无触摸） | 1138×640 | **fine** | fine | 10 | hover |
| TV 仿真（hasTouch） | 1138×640 | coarse | coarse | 1 | none |

**两个反直觉结论**：

1. **`maxTouchPoints` 不可靠**：桌面 Chromium 无触摸也报 **10**。用它当触屏判据，
   PC 竖窗口会被判成"竖屏触屏"。
2. **`pointer` 随触摸能力翻转**：给 PC 加触摸模拟就变 `coarse`。真 TV（无触摸无鼠标）
   的 `pointer` 可能是 **none**（既非 coarse 也非 fine）——任何"用 coarse 表示触摸"的
   规则在真 TV 上都不命中。这也是为什么 TV 一律靠 `data-tv` 排除、不靠 coarse。
3. Playwright **无法模拟 `any-pointer: fine + coarse` 双真**（触摸屏笔记本/接鼠标的盒子），
   这类设备只能真机验证。

### 8.2 可区分性边界（"精准识别"到什么程度）

| 组合 | 能否区分 | 手段 | 说明 |
|---|---|---|---|
| PC / TV / fnOS / Web | **能** | tauriInvoke / data-tv(UA) / detectFpkShell / 默认 | 四个信号互斥、可靠 |
| MuMu 模拟器 vs 真 TV | **能** | data-tv 身份 + `any-pointer: fine` 形态 | 模拟器有鼠标 → fine 为真 |
| 触摸屏笔记本 vs 手机 | 能 | `any-pointer: fine` + 视口 | 有精确指针即按 PC |
| iPad 带鼠标 vs Mac | **不能** | — | iPadOS 桌面 UA + fine；按 PC 处理（可接受） |
| 安卓平板 vs 大屏手机 | 只能按尺寸 | form | 768 边界存在歧义设备 |
| 真 TV vs 禁用鼠标的 PC | **不能** | — | 极少见；靠 data-tv 兜底 |
| 老内核（Chrome 66） | 能 | `legacyCss` 实测探针 | 探针一次性 |

**结论**：
- **壳身份可精准识别**（用于端专属入口：托盘、ExoPlayer、原生输入、更新通道）。
- **形态只能近似**（phone/tablet/desktop/tv-large）→ **形态只允许影响布局密度**
  （列数、双栏/胶囊、按钮显隐），**永远不许影响功能可用性**（返回键、托盘、更新、
  系统音量、原生播放器）——后者一律用身份或能力判断。
- **设备能力必须探测**（解码、音量、亮度、HLS、原生播放器）。

### 8.3 本轮核查发现的 5 个现存缺陷（与整改无关，需单独修）

- **D-1 焦点环在 PC 竖窗口永久失效**（实测）：`inputModality.hasTouch()` 用
  `navigator.maxTouchPoints > 0` 判触屏，而桌面 Chromium 报 **10** →
  900×1000 的 PC 窗口 `data-input=touch`，按方向键也不会切回 `key`
  （实测按 ArrowDown 后仍是 touch）。修法：`hasTouch` 改用
  `matchMedia('(pointer: coarse)')`（真 TV 的 none、桌面 fine 都判"非触屏"，正确）。
- **D-2 `isTvShell()` 两份同名实现**（见 P0-1）：`tvMenu.ts` 看 `platform`，
  `updateCenter.ts` 看 `moduleCheck`。修法：拆成**身份** `isTvShell()`（任一桥方法存在）
  与**能力** `hasTvModule()`（`moduleCheck` 存在），更新中心用能力、菜单键用身份。
  **不要合并成一个布尔**——那会让"有 platform 无 moduleCheck"的老壳显示不可用行。
- **D-3 `FpkUpgradePanel` 绕过 capability**：`capability` 已单点在
  `stores/appUpdate.ts`（`probeCapability`），但 `FpkUpgradePanel.vue` 自己又调
  `detectFpkShell()`。修法：改为读 store，未就绪时触发一次 `probeCapability()`。
- **D-4 设置页与菜单键的 TV 判据不是一回事**：`SettingsView` 用 `platformName() === 'tv'`
  （A10，桥方法**返回值**），`tvMenu`/`updateCenter` 用方法**存在性**（A3/A4）。当前
  `TvBridge.platform()` 恒返回 `"tv"`，两者等价；但一旦推出手机 App（`platform()`
  返回 `"android"`），A3 会把手机当 TV、A10 不会。修法：统一用壳身份
  （`data-shell`），`platform()` 的返回值只用于"设备名/日志"。

- **D-5 双击语义按设备而非事件**（2026-11-17 用户确认口径后新增）：`isTouch` 是设备级
  判据（`pointer: coarse || ontouchstart`），触摸屏 PC 上恒 true → **鼠标双击也走分区快进**
  （PC 应为双击全屏）。修法见第 9 节第 2 条。
### 8.4 整改的回归风险（逐项规避）

| 风险 | 触发场景 | 规避 |
|---|---|---|
| R1 身份合并误判能力 | 老壳有 `platform` 无 `moduleCheck` → 更新中心显示不可用行 | 拆成身份/能力两个函数（D-2） |
| R2 PC 身份合并破坏"插件未就绪"报错 | Tauri dev 注入早于插件就绪 | 保留 `backendUnavailable()` 现有语义，只合函数不改调用点顺序 |
| R3 `nav-label` 阈值 899→1024 | 900–1023 的触屏平板重新显示文字 → 源下拉被挤 | 改按 `form`（phone/tablet）判断，不用单一宽度 |
| R4 `touch-hide` 与控制栏 | iPad 1024 横屏多 2 个按钮 | 实测 1024 宽度是否溢出再定 |
| R5 矮屏 520/560 统一 | 520–560 窗口的首屏行数/行距变化 | 统一到 520，跑三视口截图对比 |
| R6 返回键判据并入 form | PC 全屏/触摸屏笔记本丢返回键；或反之让插键鼠的 TV 隐藏返回键 | **红线**：必须保留 `any-pointer: fine` 子条件（用户已确认插鼠标的 TV 显示返回键是预期） |
| R7 deviceProfile 首屏 | `data-tv` 由 `index.html` 首帧脚本按 UA 写入（**不是壳注入**）；`?tv=1` 只设属性 | main.ts 读 dataset 是安全的；仍加 MutationObserver 监听 `html[data-tv]` 变化（成本极低，防历史 bug 复发——注释记录过"属性从来没被设过、电视样式静默失效"） |
| R8 缓存 form 不更新 | 旋转/改窗口后列数不换 | resize + orientationchange 都触发重算（复用 inputModality 的写法） |
| R9 `isTvEnv()` 语义 | 现有 5 处调用每次读 dataset | 替换为读 profile 时保证"属性变化即生效"（getter 或 observer） |
| R10 门禁禁 `userAgent` 误伤 | 6 处合法用法：iOS 音量判定、legacyCss 诊断、LogsView、MeowTV 兜底×3 | 白名单 `compat/**`、`api/nativeBridge.ts`、`styles/legacyCss.ts`、`views/LogsView.vue` |
| R11 门禁禁 `innerWidth >=` 误伤 | 搜索页源栏 172px、投屏面板锚定等布局测量 | 规则改为"禁止在顶层做身份判断"；布局测量允许，但优先用容器宽度 |
| R12 capability 收口时序 | 弹窗打开时 store 尚未探测 | 未就绪时触发一次 `probeCapability()` |

### 8.5 不要引入的判据（负面清单）

- `navigator.userAgent`（除 MeowTV 首屏兜底、iPhone 音量、诊断日志）
- `navigator.maxTouchPoints`（桌面 Chromium 报 10，见 D-1）
- `(hover: none)`（带鼠标的盒子会翻转，历史已踩）
- `devicePixelRatio` / 物理分辨率（TV 的 CSS 视口只有物理的一半）
- 新增窗口宽度魔法数（先问"这是身份、形态还是布局测量"）

## 9. 实际设备与验收优先级（2026-11-17 用户确认）

**设备矩阵不再按"理想组合"推演，以下为真实在用的设备**：

| 设备 | 视口（CSS） | 命中哪些判据 | 备注 |
|---|---|---|---|
| **Windows PC（触摸屏，主用端）** | 1280×720 起 | fine 主指针 + `maxTouchPoints>0` | **D-1 焦点环失效在此机真实存在**（竖窗口按方向键无环） |
| iPhone（Safari + 主屏 PWA） | 390×844 / 852×393 | coarse + 无 fine；无 requestFullscreen | 全屏方案**先不做**（保留弹幕，横屏铺满） |
| **iPad Air 4（10.9 寸）** | **820×1180 / 1180×820** | coarse；竖屏 `<900` 命中 nav-label，横屏 1180 不命中 | 不是 768/1024 档：竖屏胶囊 + 顶栏图标化；横屏双栏 + 文字 |
| TV / 盒子 / 投影 | MuMu 1138×640、极米 Android 9 | data-tv + coarse | **插鼠标/键盘时 `any-pointer: fine` 为真**；投影仪用内置输入法（遥控器方向键操作，走 `showIme`/`inputText` 桥） |

**验收优先级**：PC 为主用端 → 整改后**先验 PC**（D-1 焦点环、A 阶段身份合并、更新能力），
再验 iPad Air 4（820/1180 两档），iPhone 第三，TV/投影最后（真机最慢）。

**已确认的产品口径**：

1. **TV/盒子插鼠标时，播放页显示左上返回键 = 符合预期**（有指针就不算大屏电视）。
   → 整改时 **`any-pointer: fine` 这个子条件不能删**（R6 从风险升级为红线）。
2. **触摸屏 PC 上按事件来源切**：手指触摸 → 触屏语义（竖滑调亮度/音量、双击分区）；
   鼠标 → PC 语义（双击全屏、滚轮调音量）。
   → 新增整改项 **D-5：双击语义按事件来源**。现状 `isTouch` 是**设备级**判据
   （`pointer: coarse || ontouchstart`），触摸屏 PC 上恒为 true → 鼠标双击也会走
   "分区快进"，与期望相反。修法：双击处理里按 `e.pointerType`（touch → 分区，
   mouse → 全屏），不再读 `isTouch`。
3. **iPhone 全屏先不做**：保持"铺满 + 横屏提示"，不引入 `webkitEnterFullscreen`
   （会丢弹幕与控制栏，见第 3 节案例 4）。

**混合输入设备的结论（与 8.2 对照）**：本机组合（触摸屏 PC + 插键鼠的 TV + 纯触屏 iPhone
+ 触屏 iPad）正好覆盖三类"设备级判据会误判"的场景 → **判据必须按事件来源或按能力，
不能按设备**。这一条已写进 D-5 与 5.3。

## 10. 相关文档

- 前端不可回退决策：[frontend](./frontend.md)
- 播放器端差异（HLS/ExoPlayer/手势）：[playback](./playback.md)
- TV 壳注入与遥控协议：[tv-integration](./tv-integration.md)
- 投屏的设备矩阵与可达性：[casting](./casting.md)
- 测试与验收清单：[testing](./testing.md)

## 11. 硬事实去哪核对

| 事实 | 核对位置 |
|---|---|
| TV 判据 | `composables/useCardCols.ts` `isTvEnv` + `client/apps/tv/app/src/main/assets/tv-nav.js` |
| 大屏形态判据 | `compat/deviceForm.ts` `isBigScreenLandscape` |
| 输入方式 | `compat/inputModality.ts`（`data-input`） |
| 老内核降级阈值 | `styles/legacyCss.ts` 的四个探针 |
| 断点与阈值 | `styles/tokens.css`（`@custom-variant wide`、`@media` 块） |
| 列数算法 | `composables/useCardCols.ts` `resolveCardCols` |
| 更新能力 | `stores/updateCenter.ts` `capability`、`api/appUpdate.ts` `currentPlatform` |
| 顶栏高度 | `styles/tokens.css` `--header-h` 三档 |
