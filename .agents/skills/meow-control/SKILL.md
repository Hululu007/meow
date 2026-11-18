---
name: meow-control
description: 用猫窝应用自带的 MCP 操作/调试猫窝（PC + TV）。需要读页面状态、复现界面问题、截图、点按输入、查网络或控制台、跑业务工具（搜索/播放/缓存/日志/诊断）时使用。统一走仓库里的 smoke/meow_mcp.py，一套命令同时驱动 PC 与 TV。
metadata:
  type: skill
  version: "1.0.0"
---

# 猫窝应用控制（PC + TV，走应用内置 MCP）

驱动**真实运行中的猫窝**做验收与排障。工具由应用自己暴露，不需要外部浏览器、
不需要手写 CDP。PC 与 TV 是同一套 MCP 报文（JSON-RPC 2.0，`/mcp`），工具名只差
前缀：PC `pc_*`、TV `tv_*`；另有 10 个两端共用的业务工具 `meow_*`。

## 这套东西在哪

| 东西 | 位置 |
|---|---|
| 本技能（仓库唯一真源） | `.agents/skills/meow-control/SKILL.md` |
| MCP 客户端（仓库内直接跑） | `smoke/meow_mcp.py`（纯标准库） |
| PC 的 MCP 服务与 18 个 `pc_*` 工具 | `client/apps/desktop/src-tauri/src/mcp.rs` |
| TV 的 MCP 服务与 `tv_*` 工具 | `client/apps/tv/app/src/main/java/com/meow/tv/DebugServer.java` |
| 两端共用的 `meow_*` 业务工具 | `client/apps/web/src/ai/tools.ts`（面板与外部桥同一批实现） |

**安装到本机**（ZCode 在项目内会自动发现 `.agents/skills/`，通常不需要装）：

```powershell
# 仓库技能是唯一真源；装到用户级只是拷贝，改完仓库要重跑一次
Copy-Item -Recurse -Force .agents\skills\meow-control $HOME\.zcode\skills\
Copy-Item -Force smoke\meow_mcp.py $HOME\.zcode\skills\meow-control\scripts\
```

用户级同名技能会**遮蔽**仓库副本（ZCode 的发现顺序），两处不一致时以仓库为准。

## 何时用

- 装了新版本（PC 包 / TV APK / fnOS fpk）要确认没坏
- 用户说“某功能不对/点了没反应/黑屏”，要复现并取现场
- 要确认后端、插件、弹幕、播放器状态
- 要查前端 JS 报错、某个请求为什么失败、性能哪一步慢
- 要让 AI/脚本替用户搜索、取播放地址、看缓存与日志

**不要**用它做：Web / fnOS 页面（没有窗口，没有 MCP）、文件上传下载、视频像素级截帧。

## 前置：先探活，再动手

```bash
python smoke/meow_mcp.py probe
```

PC 的端口**不写在** `~/.zcode/meow-mcp.json` 里（该文件只有 pid / version /
cdp_port，且 pid 可能是上次运行的）。真实判据是扫 **9339–9346** 的 `/health`，
看谁自报 `server: "meow-player"`。

```bash
curl -s --max-time 5 http://127.0.0.1:9339/health
```

| 字段 | 含义 | 异常时 |
|---|---|---|
| `server` | 必须是 `meow-player` | 不是 → 这个端口不是猫窝，继续扫 |
| `cdp_ready` | WebView2 调试端是否响应 | `false` → 重启应用（CDP 会假死） |
| `plugins[].phase` | sidecar 状态 | 非 `ready` 看 `error` |
| `version` | 应用版本 | 与预期不符先查是不是旧包 |

TV 相反：端口和令牌由 `DebugServer` 给，**必须带 `X-Meow-Token`**。
设置 → 维护 → 远程调试：开关 + 令牌（重启会换）。模拟器/投影仪无路由 IP 时：

```bash
adb forward tcp:19777 tcp:9977
python smoke/meow_mcp.py call tv_health --target tv --host 127.0.0.1 --port 19777 --token <令牌>
```

## 客户端：只用 `smoke/meow_mcp.py`

```bash
python smoke/meow_mcp.py probe
python smoke/meow_mcp.py tools --target pc
python smoke/meow_mcp.py tools --target tv --host 127.0.0.1 --port 19777 --token <令牌>

# 调工具：两端同一条命令，只换 target
python smoke/meow_mcp.py call pc_eval --target pc --args '{"expression":"location.hash"}'
python smoke/meow_mcp.py call tv_state --target tv --host 127.0.0.1 --port 19777 --token <令牌>
```

没有仓库副本时，把 `smoke/meow_mcp.py` 拷出来单独用即可（纯标准库，无依赖）。
按站点说明独立安装 skill 时，客户端在 `~/.zcode/skills/meow-control/scripts/meow_mcp.py`，
参数与上面完全一样，只换脚本路径。安装方式见 `site/docs/guide/automation.md`
（仓库地址 `.agents/skills/meow-control/SKILL.md`）。

## 工具清单

### 读状态（只读，可随便调）

| PC | TV | 用途 |
|---|---|---|
| `pc_eval {expression}` | `tv_eval {js}` | 页面内执行 JS。**PC 没有 `pc_state`**，状态用 `pc_eval` 取 |
| `pc_dom` | `tv_dom` | DOM/可见文本摘要，用来定位按钮 |
| `pc_console` | `tv_console` | JS 错误与堆栈（带路由） |
| `pc_network` | `tv_network` | fetch/XHR：状态码、耗时、失败原因 |
| `pc_danmaku` | `tv_danmaku` | 弹幕渲染器状态（canvas/active/queue） |
| `pc_perf` | `tv_perf` | 导航时序与最慢资源 |
| `pc_screenshot` | `tv_screenshot` | 截图（TV 返回 base64 + `possiblyBlank`） |
| `pc_backend` | `tv_health` | 后端基地址 / 应用与页面状态 |
| `pc_plugins` | `tv_gateway` | 插件（PC）/ 端内网关（TV）状态 |

### 做动作（会改状态，谨慎）

`pc_click` / `pc_type` / `pc_key` / `pc_hover` / `pc_drag` / `pc_wait` / `pc_navigate`；
TV 侧 `tv_key {seq:"down,down,ok"}` / `tv_navigate` / `tv_wait {js}`。
TV 只能靠 `tv_dom` 找焦点，再 `tv_key` 走。

### 业务工具（两端同名，`meow_*`）

`meow_state`（任何任务开始前先调）、`meow_logs`、`meow_diagnose`、
`meow_search` → `meow_play`、`meow_sources`、`meow_library`、`meow_live`、
`meow_danmaku`、`meow_cache`（只读；`meow_cache_start` 是写操作，不进外部桥）。

## 常用配方

**播放失败**：`meow_diagnose` → 不够再 `meow_logs {minLevel:"warn", limit:50}` →
`pc_network {only_failed:true}` 或 `tv_network` 看是哪一层失败。

**检查更新 UI**：`pc_eval` 切 `#/settings` → 点「更新」→ 读
`document.querySelector('[data-update-center]').innerText`；弹框读 `[role=dialog]`。

**搜索并播放**：`meow_search {keyword}` 取 `site` + `vod_id` → `meow_play`。

**TV 无 adb 的投影仪**：直接连 `IP:9977` + 令牌；没有可路由 IP 再 `adb forward`。

## 红线（踩过的，必须遵守）

1. **默认只读**。任何「更新 / 安装 / 卸载 / 删除 / 清空 / 重启 / 退出」动作，
   先向用户确认。**不要点更新弹框里的「更新」**——会真的下载安装包并拉起安装器
   （2026-11-16 事故：脚本误点，用户屏幕上弹出了安装向导）。
2. **同一台机器只跑一个 PC 实例**。要并行必须同时隔离：
   `MEOW_CDP_PORT=<不同端口>` + 独立 `WEBVIEW2_USER_DATA_FOLDER`，并且**只调用该
   实例自己的 MCP**（端口从该进程的 netstat 取）。否则 `pc_eval` 会通过 9455
   CDP 打到**别的实例**上——这是上面那次事故的根因。
3. 动手前核对 `~/.zcode/meow-mcp.json` 的 `pid` 与目标进程一致；这个文件会被
   每次启动重写，不能当“还活着”的证据。
4. **不杀不是自己启动的进程**（端口上的服务可能是别的会话在测）。
5. 改 `localStorage` / prefs / 配置前先记录原值，改完**必须还原**；TV 令牌不写进
   日志、不贴到回复里。
6. 汇报时区分「实测」与「推断」，给证据（版本号、字段值、截图路径）。

## 排障

| 症状 | 处理 |
|---|---|
| 9339–9346 找不到 | 应用没启动；或 `server` 不是 meow-player（被别的服务占了） |
| `cdp_ready:false` / eval 超时 | 重启应用（WebView2 CDP 假死） |
| TV 403 | 令牌错/已轮换；去设置页重读 |
| TV eval 拿不到异步结果 | `tv_eval` 不 await Promise：用 `tv_wait` 或先写 `window.__x` 再读 |
| 端口变了 | PC 端口顺延（9979→9980…；MCP 9339→9346），每次以 `/health` 为准 |
