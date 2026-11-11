# 文档站

仓库门面的静态站点，VitePress 构建，部署在 GitHub Pages：
<https://upchr.github.io/meow/>

## 内容从哪来

| 内容 | 位置 | 维护方式 |
|---|---|---|
| 首页、指南、生态、参考 | `site/docs/**` | 手写 |
| 技术文档 | `site/docs/dev/**` | 手写，与 GitHub 共用同一份文件 |
| 更新日志（`docs/reference/changelog.md`） | 由 `scripts/sync-docs.mjs` 生成 | 不提交，构建前从 `CHANGELOG.md` 重建 |
| Logo | `client/brand/` | 构建时复制到 `docs/public/` |

技术文档已经迁入 `site/docs/dev/`，仓库的 `docs/` 只留一个 `00-目录索引.md`
指向这里。所以**改技术文档就是改站点目录里的那份文件**，GitHub 上点开也是它。

## 改功能时要同步哪些页

更新日志是自动生成的，不要手改。**其余页面（含技术文档）都是手写的**，
功能变更时按改动类型查这张表：

| 改了什么 | 要同步的页面 |
|---|---|
| Docker 容器 / 端口 / `.env` 键 | `guide/web-docker.md`、`guide/quick-start.md`、`reference/downloads.md` |
| PC 插件流程、端口回退、安装包形态 | `guide/pc.md`、`ecosystem/plugins.md` |
| TV 安装、遥控、网关、运行时模块 | `guide/tv.md`、`ecosystem/runtime-module.md` |
| config 字段（`spider` / `spiderJvm` / `sites` / `parses` …） | `ecosystem/source-format.md`、`guide/source-pack.md` |
| 导入选项（`mode` / `onConflict` / `replaceSpider`） | `guide/source-pack.md` |
| 插件清单字段（fnpack / manifest） | `ecosystem/plugin-manifest.md`、`ecosystem/plugin-source.md` |
| Release 资产名、系统要求 | `reference/downloads.md` |
| 新增或移除用户可见能力 | 首页 `index.md`、`guide/what-is-meow.md` 的能力表 |
| 已知缺陷新增或修复 | `reference/limits.md`、`guide/faq.md` |
| 许可条款、第三方代码 | `reference/license.md` |

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

- 触发：push 到 `main` 且改动涉及 `site/**`、`CHANGELOG.md`、`client/package.json`
- 构建 → `upload-pages-artifact` → `deploy-pages`
- 也可以在 Actions 页面手动 `workflow_dispatch`

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

主色取自 `client/apps/web/src/styles/tokens.css` 的 Material 主题：
浅色 `#00897B`，深色 `#03DAC5`。改主题在 `.vitepress/theme/custom.css`。
