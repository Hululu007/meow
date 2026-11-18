---
name: meow-release
description: 发布猫窝新版本时使用：打 release tag、跑 CI 发版、写更新说明、发布 GitHub Release、重发/补发资产、核对 packages.json 与 fnOS 索引。用户说“发版/发个版/打 tag/出新资产/提交推送并 tag”时先读本技能。
---

# 猫窝发版

本技能只做**路由和门禁**。完整契约在 `deploy/README.md`（唯一操作手册），
本技能不复制它；两者冲突以 `deploy/README.md` 和代码为准。

## 先确认三件事（缺一不可）

1. **用户明确要求发版**。不要主动打任何 tag（tag 会触发全量 CI，见 `AGENTS.md §5.0`）。
2. **要发哪个版本号**。看 `client/package.json` 当前值，下一版按语义递增；
   没有用户指定就默认 patch +1。
3. **是不是要发到用户手上**（Publish）。只打 tag 不 Publish，客户端和飞牛都收不到。

## 版本号与更新说明

```powershell
./deploy/scripts/bump-version.ps1 -Check                 # 校验一致性
./deploy/scripts/bump-version.ps1 -Version 1.2.17        # 一次改齐清单内全部位置
```

- **禁止手改版本号**。脚本清单之外还有运行期读 `VERSION` 的（ApiServer/meowd），
  单独 grep 必漏。
- `CHANGELOG.md` 顶部写 `## x.y.z` 小节：`1. 2. 3.` 编号、每条 ≤60 字、≤6 条、
  面向用户（不写类名/`fix:`）。`verify.ps1` 会卡格式。
- 更新说明只写“用户能感知的变化”，内部重构不写。

## 标准流程（CI 发版）

```powershell
./deploy/scripts/verify.ps1 -Fast        # 13 项门禁，必须全绿
# 写 CHANGELOG + bump 版本
git status --short                       # ★ 先看有没有并行会话的改动
git add <本次文件>                        # ★ 不要无脑 git add -A
git commit -m "chore(release): x.y.z"
git push origin main
git tag -a release-vx.y.z -m "release x.y.z"
git push origin release-vx.y.z           # 触发 release.yml
gh run list --limit 5                    # 找到 release 那次
gh run watch <run-id> --exit-status
```

CI 成功后是 **draft**。必须发布：

```bash
gh release view release-vx.y.z --json isDraft,assets -q '.assets[].name'
gh release edit release-vx.y.z --draft=false --latest
```

发布后 `release: published` 会再跑两个 workflow：
`sync-packages`（写 `updates` 分支 `packages.json`）和 `fpk` 的
`index-after-publish`（写 FnDepot `fnpack.json` + 主仓 `fpk-updates` 分支 `fpk.json`）。

## tag 选择

| tag | 用途 | 建 Release |
|---|---|---|
| `release-v*` | 全量（PC + TV + 插件 + Docker + fpk 两条） | draft |
| `tv-v*` / `pc-v*` / `plugins-v*` / `tv-plugins-v*` | 单链补发 | draft |
| `fpk-v*` | 单独补 fpk | draft（仅单链） |
| `docker-v*` | 只推镜像 | 不建 Release（重发优先用 workflow_dispatch） |
| `v*`（无前缀） | 只是版本标记 | 不触发 CI |

- 全量 `release-v*` 已经包含 fpk（workflow_call），**不需要再补 `fpk-v*`**。
- `tv-node` 属于 `tv-plugins-v*`，不在 PC `plugins-v*` 里。
- 前缀后面必须紧跟数字，`tv-verify-*` 这类名字不会触发。

## 发布后必查（三索引 + 资产）

一条命令（仓库根目录，依赖 `git` + `gh`）：

```bash
python .agents/skills/meow-release/scripts/check-release-indexes.py <version>
```

它检查：
1. `updates` 分支 `packages.json`：meow-pc / meow-tv / apiserver = 目标版本
2. FnDepot `fnpack.json`：`apps.meow.releases` 含目标版本
3. 主仓 `fpk-updates` 分支 `fpk.json`：`apps.meow.releases` 含目标版本

任一项 FAIL 就不要宣布发版完成。手工排查时用：

```bash
git fetch origin updates && git show origin/updates:packages.json | head -c 400
gh api repos/upchr/FnDepot/contents/fnpack.json -H 'Accept: application/vnd.github.raw' | head -c 400
git fetch origin fpk-updates && git show origin/fpk-updates:fpk.json | head -c 400
```

资产至少应包含：PC `meow-setup-*.exe` / `meow-bare-*.exe`、`meow-TV-*.apk`、
`meow_*_x86.fpk` + `_arm.fpk`、插件 zip、`SHA256SUMS.txt`。
发现漏项：单链补 tag（`tv-v*`/`pc-v*`/`fpk-v*`）→ 再 Publish。

## 不发 CI 的路线（本地，零额度）

```powershell
./deploy/scripts/release.ps1 -Plan       # 只看会做什么
./deploy/scripts/release.ps1             # 本地构建，产物落 release/vx.y.z/
./deploy/scripts/release.ps1 -Publish    # 构建 + 建无前缀 tag + draft Release
```

`-Publish` 建的是 `v*`（不触发 CI），**仍要人工 Publish**。需要先 commit 源码，
它只让 tag 指向当前 HEAD。

## 会重复踩的坑

- **draft 忘 Publish**：资产对 API 不可见，客户端永远“已是最新”。
- **`actions/cache` 按 ref 隔离**：新 tag 首次跑是冷启动，慢属正常；
  插件缓存 key 含 `client/package.json` 版本号 → **每版必 miss**。
- **同版本重打包守卫**：同 tag 重跑会因 `size 校验失败` 被挡；用新版本号或
  dispatch 只重跑索引，不要手改索引。
- **并行会话**：`git add -A` 会把别人的未提交改动带进来；先 `git status --short`
  逐个 `git add`。
- **CHANGELOG 第一条版本**必须是要发的版本，`verify.ps1` 只检查最上面那一节。
- **keystore**（`client/apps/tv/*.jks`、`keystore.properties`）绝不入库。
- **`.env` 里的版本**被 bump 改但常被 gitignore，别以为漏改。
- **tag 建在 commit 之后**：先 commit 再 tag，否则 tag 指向旧代码。

## 更多细节

- 完整契约、产物矩阵、历史耗时：`deploy/README.md`
- 构建单元唯一真源：`deploy/units.json`
- 发版门禁实现：`deploy/scripts/verify.ps1`
- 客户端更新源与清单读取：`site/docs/dev/build-release.md`
- 需要发完版做真机验收：读 `.agents/skills/meow-control/SKILL.md`
