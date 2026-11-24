# Web / Docker

Web 形态把前后端拆成四个容器：nginx 静态前端、JVM 后端、drpy 运行时、可选的弹幕聚合服务。
一套栈同时服务浏览器、手机、TV 与桌面客户端——别的端可以直接连这里的后端。

> 不确定装哪个？先看 [快速开始 · 路线选择](/guide/quick-start#路线选择)。

## 装好它

前置：Docker 24+ 与 Compose 插件；一台能长期开着、有 2 GB 可用内存的机器（NAS / 小主机 / 服务器）。

**最快路径**（下载编排文件 → 起服务 → 打开 → 导入源包）：

```bash
mkdir meow && cd meow
curl -O https://upchr.github.io/meow/docker-compose.yml
docker compose up -d
```

浏览器打开 `http://<主机IP>:30010`。首次是空界面，按 [导入源包](/guide/source-pack) 导入后才有站点。
数据写在当前目录的 `./data/`；默认值都内联在编排文件里，这一步**不需要 `.env`**。

::: details 改端口 / 版本 / 绑定地址时：建 `.env` 覆盖

同目录建 `.env`，只写要改的项；查看生效值用 `docker compose config`。
变量按「宿主侧 → 容器内 → 高级」分组，完整注释以仓库 [`.env.example`](https://github.com/upchr/meow/blob/main/deploy/docker/.env.example) 为准。

**A · 宿主侧**（不进容器）

| 变量 | 作用 | 默认 |
|---|---|---|
| `MEOW_VERSION` | web + apiserver 镜像 tag | `latest`（跟随最新发布；要固定才填） |
| `DRPY_VERSION` | drpy tag，**独立版本线**，不要跟着 `MEOW_VERSION` 改 | 编排内钉死的版本 |
| `WEB_PORT` | 浏览器访问端口 | `30010` |
| `APISERVER_BIND` / `APISERVER_PORT` | 后端绑定地址与端口 | `127.0.0.1` / `30011` |
| `DANMU_BIND` / `DANMU_API_PORT` | 弹幕服务绑定地址与端口 | `127.0.0.1` / `30012` |
| `DANMU_API_IMAGE` | 弹幕服务镜像（官方，不从本仓库构建） | `logvar/danmu-api:…` |
| `WEB_IMAGE` / `APISERVER_IMAGE` | 自定义镜像全名 | 留空用 `chrplus/meow-*` |

**B · 容器内**（会被传进容器）

| 变量 | 作用 | 默认 |
|---|---|---|
| `MEOW_APISERVER` | web 的 `/api` 反代目标；连外部后端改成绝对地址 | `http://apiserver:9979` |
| `MEOW_DANMAKU_API` | 后端要用的弹幕聚合地址；**不用就置空写 `MEOW_DANMAKU_API=`**（容器里 `127.0.0.1` 指容器自己） | `http://danmu_api:9321` |
| `MEOW_AUTH_TOKEN` | 写操作令牌（收藏/配置/片库/缓存/转码）。设了之后前端要填同一个值 | 空（关闭鉴权） |
| `MEOW_LIBRARY_ROOTS` | 片库「选择目录」可浏览的根，冒号分隔的容器内路径，如 `/media:/downloads` | 空（提示未挂载） |
| `DANMU_SOURCE_ORDER` | 弹幕来源顺序 | 内置 8 个来源 |
| `APISERVER_JAVA_OPTS` | JVM 参数，含 `sun.jnu.encoding=UTF-8`（中文路径必须） | `-Xms64m -Xmx512m …` |

**C · CORS 与源服务**（一般不用改）

| 变量 | 作用 | 默认 |
|---|---|---|
| `MEOW_CORS` | `*` 任意来源 / `none` 只放本机与壳 / 逗号分隔的完整 Origin | `*` |
| `MEOW_SOURCES_IMAGE` / `MEOW_SOURCES_BASE` / `MEOW_SOURCES_PORT` | 独立源服务镜像与对外地址（用 `docker-compose.sources.yml` 时） | 见 `.env.example` |

`MEOW_DATA` 在容器内固定 `/data`，不通过 `.env` 改；宿主目录由编排的 bind mount 决定，换位置要编辑编排文件。

**镜像 tag**：默认 `latest`，新机器 `up -d` 直接拿到最新发布；要固定版本就在 `.env` 写 `MEOW_VERSION=<版本>`
（填你要固定到的那个版本号，见 [下载与版本](/reference/downloads)）。升级要显式 `docker compose pull`（`up -d` 不会重新拉已有镜像）。

**注意**：`MEOW_DANMAKU_API=` 与不写不一样——不写会回退默认值，显式写空串才表示「不用聚合服务」；
没起 `danmu_api` 又没置空时，每个弹幕请求都会先等一次超时才降级。

:::

### 另一种装法：clone 仓库（要改配置 / 自己构建时用）

```bash
git clone https://github.com/upchr/meow.git
cd meow/deploy/docker
```

然后二选一：

```bash
cp .env.example .env && docker compose up -d              # 拉 Registry 上的预编译镜像（推荐）
docker compose -f docker-compose.build.yml up -d --build   # 或：在本地把源码编译进镜像
```

与「直接下编排文件」的区别只是多了一份仓库与示例配置；项目名与容器名一致，两种方式无缝切换。
三个镜像都支持 amd64 + arm64，Docker 按本机架构自动选。

::: details 只想起一部分容器

```bash
docker compose up -d                             # 四个都起
docker compose up -d apiserver drpy danmu_api    # 只起后端，给 TV / 别的客户端
docker compose up -d web                         # 只起前端，连远端后端
```

只起前端连别的后端：`.env` 里设 `MEOW_APISERVER=http://192.0.2.10:30011` 再 `up -d web`。
不用聚合服务时把 `MEOW_DANMAKU_API` 置空，省一个容器。

:::

## 装好之后

::: tip 接下来：导入源包
容器起来只是有了「播放器」，站点（搜索 / 详情 / 播放地址）来自源包；导入后首页才有内容。
步骤见 [导入源包](/guide/source-pack)。
:::

### 局域网访问与令牌

默认 `apiserver` 与 `danmu_api` 只绑 `127.0.0.1`，外部只能走 web 的 nginx 反代。
TV / 手机直连后端要三件事：**`APISERVER_BIND=0.0.0.0`**、
**设 `MEOW_AUTH_TOKEN`**（否则同网段任何人都能清空你的收藏与配置）、
**客户端在设置 →「连接」→「写操作令牌」填同一个值**（令牌只注入后端，web 不转发，不填会 401）。
只在可信网络这么做；公网暴露走反向代理 + HTTPS。

PC / TV 的填写位置见 [PC 桌面端 · 改用别人的后端](/guide/pc) 与 [TV · 连后端](/guide/tv)。

### 在 Mac 和 Linux 上

没有 macOS / Linux 桌面应用，也不需要：浏览器打开 Web 版就是完整功能
（搜索、播放、弹幕、片库、直播、AI、转码），与 Windows 桌面端共用同一套后端与源包。

镜像同时发布 `linux/amd64` 与 `linux/arm64`，Apple Silicon（M1–M4）与 Intel Mac 按本机架构自动选，不用 Rosetta。
安装就用上面的最快路径；家里 NAS 已跑一套的话，Mac 上什么都不用装，浏览器开 `http://<那台机器的 IP>:30010`。

### 在 iPhone 和 iPad 上

**官方路径是 Safari**（IPA 工程在实验分支，进度与边界见 [应用计划](/reference/roadmap)、
技术契约见 [iOS 端接入](/dev/ios-integration)）。
用 **Safari** 打开 `http://<后端所在机器的 IP>:30010`（**别写 `localhost`**，那指手机自己），
底部「分享」→「添加到主屏幕」→ 命名「猫窝」，以后从主屏图标进无地址栏全屏。

Safari 是唯一原生支持 HLS（`.m3u8`）的浏览器，播放兼容性通常比安卓 WebView 好；
局域网 `http://` 直连没问题——ATS 限制只作用于 App 内 WKWebView。
全屏、后台播放与弹幕的平台限制见 [已知限制](/reference/limits#在-iphone-和-ipad-上)。

## 出问题

| 症状 | 先查什么 |
|---|---|
| 页面白屏、静态资源 404 | 镜像的 `base` 必须与访问路径一致（子路径部署尤其常见） |
| 页面能开但接口 503 | `web` 的 `MEOW_APISERVER` 指向的容器名/端口；重建容器时**必须带 `--network-alias apiserver`**，否则 nginx 解析不到 |
| 接口 403 / 跨域 | `MEOW_CORS` 与 `MEOW_AUTH_TOKEN`；写门禁与下发白名单必须一致 |
| 后端起来了但站点全红 | 容器内能否访问源包地址；`127.0.0.1` 在容器里指容器自己 |
| drpy 站全部不可用 | `drpy` 容器是否在跑；drpy tag 是否独立正确（`DRPY_VERSION` 不能跟 `MEOW_VERSION` 走） |
| 弹幕一直转圈 | `danmu_api` 是否健康；不想要就显式置空 `MEOW_DANMAKU_API=` |
| 播放卡顿 / 转码失败 | `apiserver` 里有没有 ffmpeg；播放页错误文字里的 `playError`（源站/播放器）与 `hopError`（转码/代理这一跳）是前端状态，不在后端日志里 |
| 中文路径文件播不了 | `APISERVER_JAVA_OPTS` 是否含 `-Dsun.jnu.encoding=UTF-8` |

看日志：`docker compose logs -f apiserver` / `docker compose logs -f web`。

## 相关文档

- 升级镜像（换版本号、data 不覆盖）：[升级与迁移](/guide/upgrade)
- 导入源包：[导入源包](/guide/source-pack)
- 容器细节与完整排障：开发文档 [Docker 部署](/dev/docker)
- 令牌与 CORS 的完整说明：[.env.example](https://github.com/upchr/meow/blob/main/deploy/docker/.env.example) 的注释是最终依据
- 源服务（54 站默认配置 / 换自己的源包）：[源包格式](/ecosystem/source-format)
