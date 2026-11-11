# 测试与验收

三档验证：**单测**（改逻辑时）、**CI**（提交时）、**冒烟**（改端上行为时）。端上不给自动化兜底的部分，靠验收清单。

## 一、单测

前端用 Vitest：

```bash
cd client && pnpm --filter @meow/web test
```

`client/apps/web/tests/` 下有 100+ 个测试文件，覆盖的都是**数值判据和纯函数**，不碰 DOM：

| 测试对象 | 为什么值得测 |
|---|---|
| `playbackPolicy.ts` | ABR 档位、欠载判定、倍速恢复的边界（1.25x、带宽卡线、缓冲 1.5s） |
| `liveMerge.ts` | 台名归一化、跨源合并、线路池 |
| `danmaku` 调度 | 同步容差、缓冲暂停、密度 |
| `theme-tokens` | 8 套主题 × 27 变量是否齐全 |

::: tip 抽纯函数的判据
「在组件里只能靠真机 + 慢源才能验证」的逻辑，就抽成纯函数进单测。
抽不出来的（依赖 WebView、依赖真实播放器事件）留给冒烟。
:::

后端没有单测——`server/host` 是单文件大仓库 + 大量静态方法，改造成本高于收益。
后端的回归靠「编译通过 + 冒烟脚本 + 真实源手测」。

## 二、CI

`.github/workflows/ci.yml` 四个互不依赖的 job：

| job | 做什么 |
|---|---|
| `version` | 跑 `bump-version.ps1 -Check`，校验 13 处版本号一致 |
| `web` | `vue-tsc --noEmit` + `vite build` |
| `backend` | `javac` 编译 apiserver |
| `drpy` | drpy 运行时的单测 |

触发条件：PR 到 main，或手动 dispatch。**不监听 push**——本地已经跑过同一组命令，
云端重放只会消耗 runner。

`pages.yml` 单独一条：文档站构建 + 部署，路径过滤到 `site/**`。

## 三、冒烟脚本

`smoke/` 下的脚本是端上行为的验证工具，不是 CI 的一部分（需要真实设备/浏览器）：

| 脚本 | 用途 |
|---|---|
| `smoke_web.py` | 起浏览器访问 Web 版，检查页面与接口 |
| `pc_smoke.py` | PC 端冒烟（进程、端口、插件状态） |
| `tv_discover.py` | 局域网里找 TV 的调试服务 |
| `tv_cdp.py` | 通过 TV 的调试服务操作界面 |
| `edge_session.py` | 复用的 Edge 会话（headless 冒烟） |
| `meow_mcp.py` | 通过 MCP 驱动客户端 |
| `kill-test-edge.ps1` | 清理冒烟残留的 Edge 进程（按 profile 路径匹配） |

::: warning 冒烟会留下浏览器进程
Windows 上 `proc.kill` 只杀 launcher，Edge 的子进程会残留。
跑完用 `kill-test-edge.ps1` 清一下，默认 dry-run，加 `-Apply` 才真删。
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
| 前端纯逻辑（策略、合并、格式化） | `pnpm test` |
| 前端组件/样式 | `pnpm build`（含类型检查）+ 浏览器手看 |
| 后端 Java | `./build.bat` + 起服务调 `/api/health` |
| TV 壳 / 遥控 | 真机或模拟器 + 遥控器按键 |
| 插件 / jar 加载 | 空壳实例 + 导入源包 + 冒烟脚本 |
| 文档站 | `pnpm run build`（自带死链检查） |

## 六、相关

- 排障用的日志与健康接口：[诊断手册](/reference/diagnostics)
- 发版前的自检：[构建与发版](./build-release.md)
