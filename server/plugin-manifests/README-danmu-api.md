# danmu-api 插件（可选安装）

本插件**不随安装包分发**，需要时手动放进应用的 `plugins/danmu-api/` 目录。

## 为什么不做成内置

| 原因 | 说明 |
|---|---|
| 体积 | 源码依赖 9288 个文件 / 98MB，加 node 运行时 81MB，安装包会从 38MB 涨到约 220MB |
| 许可 | danmu_api 是 AGPL，随应用分发需开源整个应用 |
| 非必需 | 未安装时弹幕自动降级为爱奇艺直连（实测 5489 条可用），播放完全不受影响 |

## 安装步骤

### 1. 决定用哪种方式

**方式 A：用外部 danmu_api（推荐）**

已经有 Docker 容器或 NAS 上跑着 danmu_api？**不用装本插件**，
直接在应用「设置 → 弹幕源 → 自定义弹幕 API」填地址即可：

```
http://192.0.2.10:9321
```

**方式 B：装成本机插件**

想让它随应用启停、零配置，才需要装。

### 2. 装配插件目录

在有源码的机器上执行：

```bash
cd meow
powershell -ExecutionPolicy Bypass -File build-plugin-danmu.ps1
```

产出 `plugins/danmu-api/`（约 98MB）和 `plugins/node/node.exe`（约 81MB）。

### 3. 复制到应用目录

把 `plugins/danmu-api/` 和 `plugins/node/` 一起复制到：

```
<安装目录>/plugins/
```

Windows 默认在 `C:\Program Files\猫窝\plugins\`，
便携版就在 exe 同级的 `plugins\`。

### 4. 在应用里启用

打开「设置 → 本机插件」，找到「弹幕聚合服务」：

1. 点左侧开关（变绿 = 随应用启动）
2. 点「启动」立刻拉起

端口会自动协商（9321 被占用时用 9322 等），
启动后自动把地址写进 `policy.json` 的 `danmakuApi`。

## 注意事项

**不会覆盖你手填的地址**。如果设置页已经填了远端地址，
插件启动时不会把它改成 `127.0.0.1`——只在字段为空时才写入。

**端口通过环境变量传**。danmu_api 读的是 `DANMU_API_PORT`，
不是命令行参数。manifest 里已经配好：

```json
"env": { "DANMU_API_PORT": "{port}" }
```

**首次启动较慢**。Node 要加载 9000+ 模块，健康检查超时给到 90 秒。

**日志在哪**。当前 sidecar 的 stdout/stderr 被丢弃。
要排障可以先手工验证一次：

```bash
cd <安装目录>/plugins/danmu-api
DANMU_API_PORT=9321 ../node/node.exe danmu_api/server.js
```

## 卸载

删掉 `<安装目录>/plugins/danmu-api/` 和 `plugins/node/` 即可。
`enabled.json` 里会留一条 `"danmu-api": true`，无害。
