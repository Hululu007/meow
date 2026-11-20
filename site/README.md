# 文档站

仓库门面的静态站点，VitePress 构建，部署在 GitHub Pages：
<https://upchr.github.io/meow/>

## 内容从哪来

| 内容 | 位置 | 维护方式 |
|---|---|---|
| 首页、指南、生态、参考 | `site/docs/**` | 手写 |
| 技术文档 | `site/docs/dev/**` | 手写，与 GitHub 共用同一份文件 |
| 更新日志（`docs/reference/changelog.md`） | 由 `site/scripts/sync-docs.mjs` 生成 | 不提交，构建前从 `CHANGELOG.md` 重建 |
| Logo | `client/brand/`（源） | 构建前由 `sync-docs.mjs` 复制到 `docs/public/`；副本已入库（与 changelog / compose 不同），改 logo 后跑 `pnpm run sync` 并一并提交副本 |

技术文档正文都在 `site/docs/dev/`；仓库的 `docs/` 只放索引与阶段性快照/专项文档
（`00-目录索引.md`，以及索引里登记的 `现状快照-*.md`、进行中的专项方案），
不再有技术文档正文。所以**改技术文档就是改站点目录里的那份文件**，GitHub 上点开也是它。

## 改功能时要同步哪些页

更新日志是自动生成的，不要手改。**其余页面（含技术文档）都是手写的**，
功能变更时按改动类型查这张表：

| 改了什么 | 要同步的页面 |
|---|---|
| Docker 容器 / 端口 / `.env` 键 | `guide/web-docker.md`、`guide/quick-start.md`、`reference/downloads.md`、`dev/docker.md` |
| PC 插件流程、端口回退、安装包形态 | `guide/pc.md`、`ecosystem/plugins.md` |
| TV 安装、遥控、网关、运行时模块 | `guide/tv.md`、`ecosystem/runtime-module.md`、`dev/tv-integration.md` |
| iOS 壳 / IPA 发版（签名、资产名、端支持） | `dev/ios-integration.md`、`reference/downloads.md`、`reference/compatibility.md`、`guide/faq.md` |
| 投屏（DLNA / 应用内会话）| `guide/playback.md`、`dev/casting.md` |
| config 字段（`spider` / `spiderJvm` / `sites` / `parses` …） | `ecosystem/source-format.md`、`guide/source-pack.md` |
| 导入选项（`mode` / `onConflict` / `replaceSpider`） | `guide/source-pack.md` |
| 插件清单字段（fnpack / manifest） | `ecosystem/plugin-manifest.md`、`ecosystem/plugin-source.md` |
| Release 资产名、系统要求 | `reference/downloads.md`、`dev/build-release.md` |
| 新增或移除用户可见能力 | 首页能力卡：`site/.vitepress/theme/components/FeatureGrid.vue` 的 `features` 数组（`index.md` 只挂 `<HomePage />`，不含文案）、`guide/what-is-meow.md` 的能力表 |
| 支持的端 / 平台（新增或取消某端） | `reference/compatibility.md` 的「端支持」、`guide/quick-start.md` 路线表、`guide/web-docker.md`、`guide/faq.md` |
| 鉴权范围 / 令牌语义（谁能调什么） | `dev/api-contract.md` §1.2、`dev/architecture.md` §6.1、`dev/public-deployment.md`、`dev/fnos-gateway-auth.md` |
| MCP 工具、调试入口、AI skill | `guide/automation.md`、`dev/ai-assistant.md` §2.7、`dev/testing.md` |
| 已知缺陷新增或修复 | `reference/limits.md`、`guide/faq.md` |
| 许可条款、第三方代码 | `reference/license.md` |
| 弹幕（渲染、默认优先级、屏蔽词） | `guide/playback.md`、`dev/danmaku.md` |
| 直播（频道源、EPG、回看） | `guide/vod-live.md`、`dev/live.md` |
| 片库 / 离线缓存 / 转码 | `guide/library.md`、`dev/library-cache.md`、`dev/library-local-browse.md`、`dev/playback.md` |
| 构建与发版（版本号、资产名、CI 触发） | `deploy/README.md`、`dev/build-release.md` |
| 数据与状态（配置落盘、迁移、清理） | `dev/data-state.md` |
| fnOS 套件 / fpk / 应用中心 | `guide/fnos.md`、`dev/fnos-gateway-auth.md` |
| 更新中心 / 版本历史 / updates 分支 | `guide/upgrade.md`、`reference/downloads.md` |
| 端 / 设备 / 尺寸判据（四层） | `dev/device-adaptive.md`（唯一真源）、`dev/frontend.md`、涉及的 UI 页 |

未列出的 `dev/*.md` 按其主题归属就近合并到上面某一行，不要让它谁都不挂。

## 硬事实去哪核对

手写页里的数字必须能对上代码，不要凭印象。已经因此修过两次（TV minSdk 写成 7.0、
弹幕默认顺序漏了 danmu_api）：

| 事实 | 核对位置 |
|---|---|
| TV 最低版本 | `client/apps/tv/app/build.gradle` 的 `minSdk` |
| 容器、端口、环境变量 | `deploy/docker/docker-compose.yml`、`.env.example` |
| PC 插件端口与回退 | `server/plugin-manifests/*.manifest.json` |
| 弹幕默认优先级 | `server/host/src/shared/ApiServer.java` 的 `DANMAKU_PRIORITY` |
| 配置导入选项 | `server/host/src/shared/ApiServer.java` + `SettingsView.vue` 的界面文案 |
| 运行时模块 `min_sdk` / `min_app_version` | `deploy/scripts/sync-packages.ps1` |
| Release 资产名 | GitHub Releases 或 `deploy/scripts/sync-packages.ps1` |
| 构建单元与产物 | `deploy/units.json` |

## 引用代码的写法

技术文档引用代码一律写「文件路径 + 符号名」（如 `ApiServer.java` 的 `call()`、
`dmUpgrade.ts` 的 `isSafeDanmakuSwap`），行号最多放在括号里当辅助提示。

**不要新增裸行号引用**：行号是绝对坐标，代码一改就漂。2026-11-19 全站审计里
上百处行号引用整体偏移 290~400 行，读者按行号跳转会落到无关代码。需要定位时给一条
`grep` 命令（如 `grep -n 'private static String call(' server/host/src/shared/ApiServer.java`），
而不是给一个会过期的数字。

## 本地开发

```bash
cd site
pnpm install
pnpm run dev        # 会先跑一次 sync，再起 dev server
# http://localhost:5173/meow/
```

`base` 是 `/meow/`，本地访问也要带这个前缀。

## 构建

```bash
cd site
pnpm run build      # 产物在 site/.vitepress/dist
pnpm run preview    # 本地预览产物
```

构建会检查死链：指向不存在页面的相对链接会直接失败。

技术文档里引用其他技术文档用站内相对路径（`./api-contract.md`）；引用仓库里的其他文件
（如 `deploy/README.md`）要写 GitHub 绝对地址——**迁移后不再有自动改写**。

## 部署

`.github/workflows/pages.yml`：

- 触发：**只认 tag**（不监听 main 推送，用户 2026-11-19 口径）：
  - 发版 tag：`release-v*` / `fpk-v*` / `tv-v*` / `pc-v*` / `plugins-v*` / `tv-plugins-v*` / `ipa-v*`
  - 纯文档重建：`site-*`（不为发版，只把 `site/**` 的改动推上线；`releaseInfo()` 不认这个前缀，
    所以它不会出现在更新日志版本列表里）
- 为什么：更新日志页只列「已有发版资产」的版本，tag 是发版的唯一信号；监听 main 会在 tag 之前白跑一次、
  页面还停在上一个版本（2026-11-19 1.2.18 实测）
- 构建 → `upload-pages-artifact` → `deploy-pages`
- 补部署也可 Actions 页面手动 `workflow_dispatch`
- ★ **`github-pages` 环境必须放行这些 tag**（Settings → Environments → Deployment branches and tags）：
  `main`（分支）+ `release-v*` / `fpk-v*` / `tv-v*` / `pc-v*` / `plugins-v*` / `tv-plugins-v*` / `ipa-v*` / `site-*`（tag）。
  否则「构建站点」成功、「部署」job 报 `Tag "..." is not allowed to deploy to github-pages
  due to environment protection rules`（2026-11-19 实测，已配置）。
  用 API 查：`gh api repos/<o>/<r>/environments/github-pages/deployment-branch-policies`

仓库 Pages 的 Source 必须是 **GitHub Actions**（不是分支目录）：

```bash
gh api -X POST repos/upchr/meow/pages -f build_type=workflow
```

## 新增一个页面

**普通页面**

1. 在 `site/docs/guide/`、`ecosystem/` 或 `reference/` 下建 `.md`
2. 在 `.vitepress/config.mts` 对应的 `sidebar` 数组里加一条
3. 需要出现在顶部导航就改 `themeConfig.nav`

**技术文档**

1. 在 `site/docs/dev/` 下建 `.md`
2. 在 `config.mts` 的 `devSidebar` 里加一条
3. 在 `site/docs/dev/index.md` 和仓库 `docs/00-目录索引.md` 各补一行（站点与 GitHub 两个入口）

本地 `pnpm run dev` 确认后提交。

## 版本号

`config.mts` 读 `client/package.json` 的 `version`，通过 `vite.define` 注入，
页面里用 `<VersionBadge />` 展示。**不要写死版本号**。

## 配色

主色取自 `client/apps/web/src/styles/tokens.css` 的 Material accent `#03DAC5`；
浅色模式在 `.vitepress/theme/custom.css` 压暗到 `#00897B` 保证正文对比度，
改主题只改 `custom.css`。
