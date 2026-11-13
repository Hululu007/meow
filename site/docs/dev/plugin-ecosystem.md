# 插件生态统一规范（草案 v0.1）

> 本页是**跨端目标模型与迁移路线**。单端的字段细节看
> [插件系统](./plugin-system.md)；用户侧 manifest 说明看
> [插件 manifest 规范](../ecosystem/plugin-manifest.md)。

## 〇、结论

1. 统一 **清单（manifest）+ 状态（status）+ 生命周期（phase）** 三件。
2. **不统一** 分发（channel）与通信（transport）—— 这两项是端能力，不是插件属性。
3. 公共子集其实已经存在（`server/plugin-manifests/*.json`），缺的是"三端都按它校验"。
4. 分三步：P0 校验与状态对齐（约 1 天）→ P1 fpk 启停 + TV 列表复用（2–3 天）→ P2 安装记录统一（按需）。

---

## 一、三套现状（实测）

| | PC（Tauri） | TV（Android） | fpk（fnOS） |
|---|---|---|---|
| 载体 | sidecar 进程 / 本机目录 | 运行时模块 APK + `node-payload-danmu.zip` | 随包 `app/plugins/<id>/` |
| 清单 | `server/plugin-manifests/*.json` | 同上 + `packages.json` 条目 | 同左，由 `meowd` 解析 |
| 分发 | 应用内安装器 + `packages.json` | 同左（`tv-node` 独立链） | 应用中心整包替换 |
| 通信 | 本地端口 + HTTP 健康检查 | `DexClassLoader` → `:node` 进程 | 子进程 + 端口健康检查 |
| 状态可见 | 插件页 | 更新中心行 | `GET /healthz` 的 `plugins` 段 |
| 启停控制 | 安装/卸载 | 安装/卸载 + 停用 | **无**（全部无条件启动） |

## 二、六个不一致（都带证据）

1. **清单字段解析不全**：`danmu-api.manifest.json` 里写了 `"autostart": false`，但 `meowd` 的
   `Manifest` 结构里没有这个字段 → 反序列化时静默丢弃，`supervisor` 对 `app/plugins/*`
   仍然全部启动。声明了不生效，比没声明更危险。
2. **命名三套**：插件 / 模块 / 组件。同一份 danmu-api 载荷，三个端的设置页叫三个名字。
3. **状态口径只有 fpk 是完整的**：`starting / ready / failed / stopped / missing-payload /
   missing-runtime` 六个 phase 只在 fpk 侧存在，PC/TV 各自拼字段，UI 无法共用。
4. **分发入口三套，没有统一的"已安装记录"**：PC 读 installer、TV 读模块表、fpk 读目录扫描，
   同一件事三种查询方式。
5. **版本线独立但没进契约**：`danmu-api` 1.0.0、`drpy` 0.1.0 与应用版本解耦，
   可客户端没有任何字段能判断"这个载荷和当前壳兼不兼容"。
6. **权限模型只停在议题里**：PC/TV 讨论过 permissions/transport，但清单里没有对应字段，
   也就无法校验。

## 三、统一模型：三层拆开

```
artifact（载荷）  →  manifest（清单）  →  runtime（运行时）
  zip / APK / 目录     公共子集 + 私有块      node / exec / android-module
```

- **artifact**：内容寻址（sha256 必填），与端无关。
- **manifest**：只描述"要什么、怎么起、怎么判活"，见第四节。
- **runtime**：由端声明自己支持哪几种；清单里写 `runtime`，不匹配就不安装/不启动。
- **channel**（bundled / store / inapp）与 **transport**（本地端口 / RPC / 进程内）属于端能力，
  **不进清单**——同一份 danmu-api 在 fpk 是子进程、在 PC 是 sidecar，这是实现差异，不是插件属性。

## 四、清单公共子集（v2）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | `^[a-z][a-z0-9-]{1,31}$`，全局唯一、跨端一致 |
| `name` | | 展示名 |
| `version` | ✅ | 语义化版本；**独立于应用版本** |
| `capability` | ✅ | `danmaku` / `source` / `scraper` / `subtitle` / `runtime` |
| `runtime` | ✅ | `node` / `exec` / `android-module`（端不支持即不可用） |
| `exec` / `execFallback` / `args` / `cwd` | | `runtime=node/exec` 必填 |
| `port` / `portFallback` | | `0` = 不监听；非 0 必须在 1024–65535 |
| `health` / `healthExpect` / `healthTimeoutMs` / `healthIntervalMs` | | 有端口才需要 |
| `dataDir` | | 插件私有数据目录（相对应用数据根） |
| `env` | | 支持 `{port}` / `{dataDir}` 占位 |
| `inject` | | `{target,key,value}`；**target 必须落在应用数据目录内** |
| `autostart` | | 缺省 `true`；`false` 时由用户手动启用 |
| `required` / `fatal` | | `required` = 缺了应用不可用；`fatal` = 起不来要中断启动 |
| `platforms[]` | | `{os, arch, abi, artifact, sha256}`；跨端分发时必填 |
| `extensions{}` | | 端私有字段全部放这里（PC 的 permissions/transport、TV 的 module 名） |

最小示例（danmu-api 的公共子集）：

```json
{
  "id": "danmu-api",
  "name": "弹幕聚合服务",
  "version": "1.0.0",
  "capability": "danmaku",
  "runtime": "node",
  "exec": "node",
  "args": ["danmu_api/server.js"],
  "port": 9321,
  "portFallback": [9322, 9323, 9324, 9325],
  "health": "/api/v2/fongmi/danmaku?name=test",
  "autostart": true,
  "extensions": { "pc": { "transport": "http" }, "tv": { "module": "tv-node" } }
}
```

校验规则（三端共用一份脚本）：

1. `id` 正则、`version` 可解析、`capability` 在枚举内、`runtime` 在端支持列表内；
2. `port != 0` 时 `health` 必填；`port` 冲突直接拒绝（同端内唯一）；
3. `inject.target` 必须 realpath 后位于应用数据目录下（防穿越）；
4. `platforms[]` 里当前端必须恰有一条匹配（`os + arch/abi`），且 `sha256` 为 64 位小写 hex；
5. 未知字段只允许出现在 `extensions` 内，顶层未知字段报警告（本次审计的第 1 条就是漏了这条）。

## 五、生命周期（统一状态机）

沿用 fpk 已有的六个 phase，三端都输出这一套：

```
discovered → (disabled)                    # 清单存在但用户停用
           → starting → ready              # 端口就绪 + 健康检查通过
                    ↘ failed → starting    # 退避重试
           → missing-runtime / missing-payload
           → stopped                       # 应用退出
```

参数（fpk 实测值，建议三端统一）：稳定线 60s、退避上限 30s、连续 5 次失败判 `failed`、
运行时缺失每 15s 重探一次。

**`disabled` 的优先级高于 `autostart`**：用户停用后不得被自动拉起；停用时要同时撤掉
`inject` 写入的那条配置（fpk 上是 `policy.json.danmakuApi`，不清会让后端一直打已关闭的端口，
表现为"弹幕超时"）。

## 六、已安装记录（跨端统一）

三端都应能给出一模一样的一条：

```json
{ "id": "danmu-api", "version": "1.0.0", "channel": "bundled",
  "path": "…", "sha256": "…", "enabled": true, "phase": "ready", "port": 9321 }
```

有了它，设置页/更新中心/诊断页就能用同一套渲染，不用为每个端写一遍。

## 七、迁移路线

| 阶段 | 内容 | 成本 |
|---|---|---|
| **P0** | ①公共子集校验脚本接进三端 CI；②`meowd` 的 `Manifest` 补 `autostart/required/fatal`（否则声明无效）；③状态输出统一成第五节那个 JSON | ~1 天 |
| **P1** | ④fpk 加 `GET/POST /api/_shell/plugins[/{id}/enable\|disable]`，disabled 集合持久化到 `$TRIM_PKGVAR`，停用清 `inject`；⑤TV 更新中心的模块行改用同一 JSON | 2–3 天 |
| **P2** | ⑥PC/TV 安装器写同一条"已安装记录"；⑦签名与校验（`extensions.pc.permissions` 落地） | 按需 |

## 八、判据（怎么算对齐了）

1. 同一份 `danmu-api` 清单在 PC / TV / fpk 三端都能通过校验，且 `id/version/capability` 完全一致；
2. 三端的插件列表接口返回同一个 schema（字段名、phase 枚举、错误字符串）；
3. 任意一端的"停用"在重启后保持，且不再被 `autostart` 拉起；
4. 顶层出现未知字段时校验脚本会报警（而不是像现在这样静默忽略）。

## 九、明确不做

- **fpk 内插件下载安装**：包由应用中心整包替换，自己再搞下载器要额外做签名、回滚、升级不覆盖。
- **把 PC/TV 的 Host RPC 与权限审批搬进 fpk**：随包分发的插件天然可信，多出来的 token/白名单/secrets
  只在增加攻击面。
- **包内插件热更新**：与"整包替换"的升级模型冲突，收益低。

## 附：相关页

- [插件系统](./plugin-system.md) —— 单端实现的字段与故障排查
- [插件 manifest 规范](../ecosystem/plugin-manifest.md) —— 用户/作者视角
- [插件与安装](../ecosystem/plugins.md) —— 安装入口
