# 脚本与 AI 操作猫窝（MCP）

猫窝的 PC 与 TV 客户端内置了一个 **MCP 服务**（Model Context Protocol，JSON-RPC 2.0），
把「读页面状态、执行 JS、截图、点按输入、查网络与控制台、调用业务工具」暴露给
外部脚本或 AI 代理。它不是播放接口，也不参与日常使用，属于**验收与排障用的控制面**。

> 只想看片子不需要这一页。这里面向两类人：写自动化/冒烟的开发者，以及想让 AI
> 直接操作猫窝的用户。

## 能做什么

| 用途 | 具体能力 |
|---|---|
| 真机验收 | 截图、读 DOM/路由、点击/拖拽/输入、等待条件（投影仪没有 adb 也能遥控） |
| 排障复现 | 读 console 错误、网络请求记录、弹幕与播放器状态 |
| 自动化驱动 | 执行任意 JS、调用 10 个业务工具（搜索/播放/缓存/日志/诊断…） |
| 健康检查 | 应用版本、页面 URL、后端地址、插件状态、CDP 是否就绪 |

## 安全边界

| 端 | 监听 | 鉴权 | 启停 |
|---|---|---|---|
| PC（Tauri） | `127.0.0.1:9339–9346`（只本机） | 无（仅回环可访问） | 随应用启动/退出，设置页只读展示 |
| TV（Android） | `0.0.0.0:9977`（局域网可达） | `X-Meow-Token`（设置页显示，重启会换；**分隔符可省略**） | 设置 → 维护 → 远程调试，可随时开关；**空闲 30 分钟自动关闭** |
| Web / fnOS 页面 | — | — | 没有窗口，不提供 MCP |

TV 之所以需要令牌：它监听局域网，方便一台电脑遥控投影仪；不放心就直接关掉开关。
令牌按 4 位分组显示只是排版（`a3f1-ffc7-2d7e-0eae`），请求头里带不带 `-` 都认。

## PC 接入

1. 启动 PC 应用（MCP 随应用生命周期，没有独立进程可重启）。
2. 找端口：**不要看 `~/.zcode/meow-mcp.json` 里的端口**（该文件只存 pid/版本/CDP 端口，
   而且 pid 可能是上次运行的）。正确做法是扫 9339–9346 的 `/health`，看谁自报
   `server: "meow-player"`：

   ```bash
   curl -s --max-time 5 http://127.0.0.1:9339/health
   ```

   关键字段：`server`（须为 `meow-player`）、`cdp_ready`（false = WebView2 调试端点假死，重启应用）、
   `plugins[].phase`（sidecar 状态）。

3. 调用工具（推荐用仓库里的统一客户端）：

   ```bash
   python smoke/meow_mcp.py probe                 # 自动发现 PC（和 TV，如果给了参数）
   python smoke/meow_mcp.py tools --target pc     # 列出 18 个 pc_* 工具
   python smoke/meow_mcp.py call pc_eval --target pc \
     --args '{"expression":"location.hash"}'
   ```

最小 JSON-RPC 示例（不用客户端时）：

```bash
curl -s -X POST http://127.0.0.1:9339/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"pc_eval","arguments":{"expression":"location.href"}}}'
```

## TV 接入

1. 电视上：设置 → 维护 → 远程调试 → 打开，记下**令牌**。
2. 有 adb/模拟器时做端口转发，或直接用局域网 IP：

   ```bash
   adb forward tcp:19777 tcp:9977
   python smoke/meow_mcp.py call tv_health --target tv \
     --host 127.0.0.1 --port 19777 --token <令牌>
   ```

3. 遥控按键用 `tv_key`（支持连按序列），定位按钮用 `tv_dom`：

   ```bash
   python smoke/meow_mcp.py call tv_key --target tv \
     --host 192.168.1.76 --port 9977 --token <令牌> \
     --args '{"seq":"down,down,ok"}'
   ```

## 工具一览

| 类 | PC（18） | TV（17） |
|---|---|---|
| 状态 | `pc_eval` `pc_dom` `pc_console` `pc_network` `pc_perf` `pc_danmaku` `pc_plugins` `pc_backend` `pc_screenshot` | `tv_eval` `tv_dom` `tv_console` `tv_network` `tv_perf` `tv_danmaku` `tv_gateway` `tv_health` `tv_screenshot` `tv_state` `tv_media` `tv_storage` |
| 动作 | `pc_click` `pc_type` `pc_key` `pc_hover` `pc_drag` `pc_wait` `pc_navigate` `pc_plugin_start` `pc_plugin_stop` | `tv_key` `tv_navigate` `tv_wait` `tv_pointer` `tv_focus` |

`tv_media` 读 `currentTime/duration/readyState/buffered/src`（续播、转码、卡顿）；
`tv_storage` 读写 localStorage（仅 `meow.*` 键）；
`tv_pointer` 合成鼠标 move/down/up/click（验证 hover/pointer 判据；不触发原生 `:hover`）；
`tv_focus` 把焦点设到指定选择器（走 tv-nav，会画框并钉住）。

两端共用 10 个业务工具：`meow_state`、`meow_logs`、`meow_diagnose`、`meow_search`、
`meow_play`、`meow_sources`、`meow_library`、`meow_live`、`meow_danmaku`、`meow_cache`。
建议任何任务先调 `meow_state` 建立上下文。

## 给 AI 安装 Skill

仓库里带了一份现成的 skill（覆盖 PC + TV、含工具清单与红线）：

- 仓库地址（可直接发给 AI）：
  `https://github.com/upchr/meow/blob/main/.agents/skills/meow-control/SKILL.md`
- 原始文件（AI 可直接下载）：
  `https://raw.githubusercontent.com/upchr/meow/main/.agents/skills/meow-control/SKILL.md`
- 国内加速镜像：
  `https://cdn.jsdelivr.net/gh/upchr/meow@main/.agents/skills/meow-control/SKILL.md`

**最简单的用法**：把下面这段原样发给你的 AI（ZCode / Claude 等支持 skill 的客户端）：

```text
请安装「猫窝控制」skill：
1) 下载 https://raw.githubusercontent.com/upchr/meow/main/.agents/skills/meow-control/SKILL.md
   保存到 ~/.zcode/skills/meow-control/SKILL.md
2) 下载 https://raw.githubusercontent.com/upchr/meow/main/.agents/skills/meow-control/scripts/meow_mcp.py
   保存到 ~/.zcode/skills/meow-control/scripts/meow_mcp.py
3) 告诉我装好了，以及 skill 的触发方式
```

手动安装（bash / PowerShell 同理，注意替换 `$HOME`）：

```bash
mkdir -p ~/.zcode/skills/meow-control/scripts
curl -fL https://raw.githubusercontent.com/upchr/meow/main/.agents/skills/meow-control/SKILL.md \
  -o ~/.zcode/skills/meow-control/SKILL.md
curl -fL https://raw.githubusercontent.com/upchr/meow/main/.agents/skills/meow-control/scripts/meow_mcp.py \
  -o ~/.zcode/skills/meow-control/scripts/meow_mcp.py
```

装好后，对 AI 说「用猫窝的 skill 验一下 / 操作一下」即可触发。SKILL.md 里写了前置探活、
工具清单、常用配方和红线；客户端是纯标准库、无第三方依赖。仓库里 `smoke/meow_mcp.py` 是同一实现的兼容入口，老命令不用改。

## 注意

- **不要点更新弹框里的「更新」**，除非你确实要升级：它会真的下载安装包并拉起安装器。
- 同一台机器**只跑一个 PC 实例**。要并行必须给第二个实例设 `MEOW_CDP_PORT=<不同端口>`
  和独立 `WEBVIEW2_USER_DATA_FOLDER`，否则 `pc_eval` 可能驱动到另一个实例。
- 端口会顺延（PC 后端 9979→9980…，MCP 9339→9346），每次以 `/health` 为准。
- TV 令牌不要贴到 issue/日志里；重启应用会换。
- 改 `localStorage` / 设置项做实验后记得还原。
