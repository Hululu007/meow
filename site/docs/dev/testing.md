# 测试与验收

三档验证：**单测**（改逻辑时）、**CI**（提交时）、**冒烟**（改端上行为时）。端上不给自动化兜底的部分，靠验收清单。

## 一、单测

前端用 Vitest（`client/apps/web/package.json` 没有 `test` script，直接调 vitest）：

```bash
cd client/apps/web && npx vitest run
```

`client/apps/web/tests/` 下有 100+ 个测试文件，覆盖的都是**数值判据和纯函数**，不碰 DOM：

| 测试对象 | 为什么值得测 |
|---|---|
| `playbackPolicy.ts` | ABR 档位、欠载判定、倍速恢复的边界（1.25x、带宽卡线、缓冲 1.5s） |
| `liveMerge.ts` | 台名归一化、跨源合并、线路池 |
| `danmaku` 调度 | 同步容差、缓冲暂停、密度 |
| `theme-tokens` | 8 套主题风格 × 每块 27 个变量是否齐全（少一个就有元素拿 `:root`） |

::: tip 抽纯函数的判据
「在组件里只能靠真机 + 慢源才能验证」的逻辑，就抽成纯函数进单测。
抽不出来的（依赖 WebView、依赖真实播放器事件）留给冒烟。
:::

后端没有 Java 单测框架——`server/host` 是单文件大仓库 + 大量静态方法，改造成本高于收益。
回归靠三样：**编译通过**（CI 的 javac）、**空壳站点表门禁**（`test_empty_shell_sites.py`）、
**冒烟 + 真实源手测**。drpy 运行时有 `npm test`（`tests/smoke.mjs`，宿主契约测试，离线）。

## 二、CI

`.github/workflows/ci.yml` 四个互不依赖的 job：

| job | 做什么 |
|---|---|
| `version` | 跑 `bump-version.ps1 -Check`，校验全部版本号位置一致 |
| `web` | `pnpm --filter @meow/web build`（含 vue-tsc）+ `vue-tsc --noEmit` + `vitest run` |
| `backend` | `javac` 编译 apiserver + 空壳站点表门禁（`python3 test_empty_shell_sites.py`） |
| `drpy` | `npm ci` + `npm test`（宿主契约测试，离线） |

触发条件：PR 到 main（收紧到 main 是为了不吃 fork PR），或手动 dispatch。
**不监听 push**——这三块在本地是同一组命令，推 main 时本地必然已跑过；
私有仓又不支持分支保护，云端重放起不到门禁作用。

`pages.yml` 单独一条：push main 且路径命中 `site/**`、`CHANGELOG.md`、
`client/package.json` 或该 workflow 自身时，构建 + 部署文档站（构建前先由
`site/scripts/sync-docs.mjs` 同步 `docs/` 与 changelog）。

## 三、冒烟脚本

`smoke/` 下的脚本是端上行为的验证工具，不是 CI 的一部分（需要真实设备/浏览器）。
硬约束：Python 只用标准库，不 pip 装依赖。

| 脚本 | 用途 |
|---|---|
| `smoke_web.py` | 起浏览器访问 Web 版（前端 nginx + Docker 后端），检查页面与接口；服务不在就报「未执行」，不编 PASS |
| `pc_smoke.py` | PC 端冒烟，走应用内 MCP 的 HTTP JSON-RPC（复用应用自己的 CDP 连接） |
| `tv_discover.py` | 局域网里找 TV 的调试服务（DebugServer / MCP） |
| `tv_cdp.py` | 标准库手写的最小 CDP 客户端，经 TV 调试服务操作界面 |
| `tv_docker_smoke.py` | Android 模拟器上的 TV 连 Docker 后端，CDP 读真实 DOM |
| `tv_mcp.py` | TV 端 MCP 客户端——投影仪没有 adb 时用这套操作验收 |
| `tv_mcp_endpoints.py` | 直连设备内 9977 端口，验 TV DebugServer 的端点（服务默认关闭，没起会明说） |
| `wsclient.py` | 上面几条共用的 CDP-over-WebSocket 模块，不是独立脚本 |
| `meow_mcp.py` | 猫窝统一 MCP 客户端：一套接口同时驱动 PC 与 TV |
| `edge_session.py` | 起 headless Edge 做 CDP 测试，退出时保证收尾 |
| `kill-test-edge.ps1` | 清理冒烟残留的测试浏览器（只匹配 `--user-data-dir` 指向仓库 `tmp/` 的实例） |
| `kill-test-edge.cmd` | 计划任务入口：每 10 分钟调上面的 ps1 `-Kill -OlderThanMinutes 90 -RemoveProfiles` |

::: warning 冒烟会留下浏览器进程
Windows 上 `proc.kill` 只杀 launcher，Edge 的子进程会残留（实测顶到系统虚拟内存不足）。
`kill-test-edge.ps1` 默认**只列不杀**，加 `-Kill` 才杀——它用 `taskkill /T` 连进程树一起
结束，缺 `/T` 正是当初的事故根因。
:::

## 四、手动验收

端上行为（遥控器导航、焦点、播放、弹幕、直播）没有可靠的自动化手段，靠清单：

| 场景 | 怎么验 |
|---|---|
| 播放 | `readyState` 到 4、时间推进、有画面、无 `playError` |
| 弹幕 | 屏幕上有弹幕、暂停时跟着停、恢复后不清屏 |
| 切换线路 | 死线导致换线而不是转码 |
| 直播 | 换台、坏线先换线再换台 |
| 遥控器 | 方向键可达全部可点元素、返回键逐层退 |

TV 上的验证建议用真实的 adb 遥控器事件，而不是 CDP 点击——焦点导航的 bug 只在真实按键下出现。

## 五、什么时候跑什么

| 你改了什么 | 跑什么 |
|---|---|
| 前端纯逻辑（策略、合并、格式化） | `cd client/apps/web && npx vitest run` |
| 前端组件/样式 | `pnpm build`（含类型检查）+ 浏览器手看 |
| 后端 Java | `./build.bat` + 起服务调 `/api/health` |
| TV 壳 / 遥控 | 真机或模拟器 + 遥控器按键 |
| 插件 / jar 加载 | 空壳实例 + 导入源包 + 冒烟脚本 |
| 文档站 | `pnpm run build`（VitePress 死链会让构建失败） |

## 六、相关

- 排障用的日志与健康接口：[诊断手册](/reference/diagnostics)
- 发版前的自检：[构建与发版](./build-release.md)
