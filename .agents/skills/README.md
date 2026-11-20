# 仓库内置 AI 技能

给在本仓库工作的 AI（ZCode / Claude 等）用的技能包。它们在项目内**自动被发现**，
不需要安装；装到用户级只是为了在仓库外也能用。

## 技能目录

| 技能 | 什么时候用 |
|---|---|
| [`meow-control`](./meow-control/SKILL.md) | 驱动运行中的猫窝做验收/排障：读页面状态、截图、点按、网络与控制台、业务工具 |
| [`meow-release`](./meow-release/SKILL.md) | 发版：版本号、更新说明、tag、CI、Publish、三索引核对、补发资产 |
| [`issue-triage`](./issue-triage/SKILL.md) | 处理仓库 issue：核实上报、读代码/抓响应定因、记录证据与计划、简短回复、打标签 |

## 发现顺序（ZCode）

1. 显式配置的技能根
2. `~/.zcode/skills`
3. `~/.agents/skills`
4. **工作区 `.zcode/skills`**（从当前目录向上到仓库根，越深越优先）
5. **工作区 `.agents/skills`**（本目录）
6. 已启用插件的技能根

同级里 `.zcode` 先于 `.agents`；**同名技能只有第一个会被加载**。所以：

- 仓库内的唯一真源是本目录；
- 用户级同名副本会**遮蔽**仓库副本（用户级顺序更高），改了仓库要重新拷一次；
- 想临时覆盖某个技能，放到仓库 `.zcode/skills/<name>/`（该目录被 gitignore，只影响本机）。

## 安装到用户级（可选）

```powershell
# 整个技能（含 scripts/meow_mcp.py）
Copy-Item -Recurse -Force .agents\skills\meow-control $HOME\.zcode\skills\
```

```bash
cp -r .agents/skills/meow-control ~/.zcode/skills/
```

## 新增技能

- 目录名与 frontmatter `name` 必须一致（kebab-case）；
- frontmatter 必须有 `name` + `description`（≤1024 字），触发词放前 250 字；
- 正文 <500 行；细节放 `references/`，按需读取；
- 只写“入口 + 门禁 + 会重复踩的坑”，不复制 `AGENTS.md` / `site/docs/` 的长正文，
  避免两处漂移。

## 相关代码

- PC MCP 服务：`client/apps/desktop/src-tauri/src/mcp.rs`
- TV MCP 服务：`client/apps/tv/app/src/main/java/com/meow/tv/DebugServer.java`
- 两端共用业务工具：`client/apps/web/src/ai/tools.ts`
- 发版契约：`deploy/README.md`
