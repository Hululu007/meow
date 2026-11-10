# 文档站

仓库门面的静态站点，VitePress 构建，部署在 GitHub Pages：
<https://upchr.github.io/meow/>

## 内容从哪来

| 内容 | 真源 | 说明 |
|---|---|---|
| 首页、指南、生态、下载、限制、许可 | `site/docs/**` | 直接维护 |
| 开发文档（`docs/dev/`） | 仓库 `docs/*.md` | 构建前由 `scripts/sync-docs.mjs` 生成，**不要手改** |
| 更新日志（`docs/reference/changelog.md`） | 仓库 `CHANGELOG.md` | 同上，自动裁掉维护说明 |
| Logo | `client/brand/` | 构建时复制到 `docs/public/` |

生成物在 `site/.gitignore` 里，不提交。改技术文档只改 `docs/`，站点会跟着更新。

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
技术文档里的仓库相对路径（如 `../deploy/README.md`）会被自动改写成 GitHub 链接。

## 部署

`.github/workflows/pages.yml`：

- 触发：push 到 `main` 且改动涉及 `site/**`、`docs/**`、`CHANGELOG.md`、`client/package.json`
- 构建 → `upload-pages-artifact` → `deploy-pages`
- 也可以在 Actions 页面手动 `workflow_dispatch`

仓库 Pages 的 Source 必须是 **GitHub Actions**（不是分支目录）：

```bash
gh api -X POST repos/upchr/meow/pages -f build_type=workflow
```

## 新增一个页面

1. 在 `site/docs/guide/`、`ecosystem/` 或 `reference/` 下建 `.md`
2. 在 `.vitepress/config.mts` 对应的 `sidebar` 数组里加一条
3. 需要出现在顶部导航就改 `themeConfig.nav`
4. 本地 `pnpm run dev` 确认，提交

## 版本号

`config.mts` 读 `client/package.json` 的 `version`，通过 `vite.define` 注入，
页面里用 `<VersionBadge />` 展示。**不要写死版本号**。

## 配色

主色取自 `client/apps/web/src/styles/tokens.css` 的 Material 主题：
浅色 `#00897B`，深色 `#03DAC5`。改主题在 `.vitepress/theme/custom.css`。
