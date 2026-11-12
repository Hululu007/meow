# Web / Docker

Web 形态把前后端拆成四个容器：一个 nginx 静态前端、一个 JVM 后端、一个 drpy 运行时、
一个可选的弹幕聚合服务。

## 前置

- Docker 24+ 与 Compose 插件
- 一个能长期开着的机器（NAS / 小主机 / 服务器）
- 2 GB 可用内存（apiserver 的 JVM 与 ffmpeg 是主要占用）

## 起服务

两种起法，效果相同：**clone 仓库**（连构建文件与示例配置一起拿）或**只下编排文件**（不 clone，最快）。

### 方式一：clone 仓库

```bash
git clone https://github.com/upchr/meow.git
cd meow/deploy/docker
cp .env.example .env
docker compose up -d
```

### 方式二：不 clone，直接下编排文件

默认值都内联在这份文件里，**不需要 `.env`**：

```bash
mkdir meow && cd meow
curl -O https://upchr.github.io/meow/docker-compose.yml
docker compose up -d
```

数据写在当前目录的 `./data/`。项目名与容器名和仓库版完全一致，两种方式可以无缝切换；
要改端口 / 绑定地址 / 镜像版本，同目录建一个 `.env` 覆盖即可（变量见下方表格）。

::: details 展开看这份编排的全文（与下载的是同一份，构建时从仓库自动同步）
<<< ../../../deploy/docker/docker-compose.standalone.yml
:::

浏览器打开 `http://<主机IP>:30010`。

首次打开是空界面，需要导入源包，见 [导入源包](/guide/source-pack)。

### 只想起一部分

```bash
docker compose up -d                             # 四个都起
docker compose up -d apiserver drpy danmu_api    # 只起后端，给 TV / 别的客户端
docker compose up -d web                         # 只起前端，连远端后端
```

只起前端连别的后端：改 `.env` 里的 `MEOW_APISERVER=http://192.0.2.10:30011`，
再 `docker compose up -d web`。

## 容器与端口

| 容器 | 内容 | 端口变量 | 默认 |
|---|---|---|---|
| `web` | nginx + 静态文件 | `WEB_PORT` | 30010 → 容器 8080 |
| `apiserver` | JVM + spider jar + ffmpeg | `APISERVER_PORT` | 30011 → 容器 9979 |
| `drpy` | Node 运行时 | `DRPY_PORT` | 30013 → 容器 9330 |
| `danmu_api` | 弹幕聚合 | `DANMU_API_PORT` | 30012 → 容器 9321 |

## `.env` 关键项

| 变量 | 作用 | 默认 |
|---|---|---|
| `MEOW_VERSION` | 镜像 tag | compose 兜底值，随发版更新 |
| `APISERVER_BIND` | 后端监听地址 | `127.0.0.1`（只给本机反代用） |
| `DANMU_BIND` | 弹幕服务监听地址 | `127.0.0.1` |
| `MEOW_AUTH_TOKEN` | 前端调后端时带的令牌 | 空 |
| `MEOW_CORS` | 跨域策略：`*` / `none` / 白名单 | `*` |
| `MEOW_JS_RUNTIME` | drpy 地址 | `http://drpy:9330` |
| `MEOW_DANMAKU_API` | 弹幕聚合地址；**置空写 `MEOW_DANMAKU_API=`** | `http://danmu_api:9321` |

容器内的 `MEOW_DATA` 固定为 `/data`，不通过 `.env` 改；宿主上的实际目录由编排文件的 bind mount 决定（`./data` 或 `../../data`），要换位置就编辑编排文件。

::: warning `MEOW_DANMAKU_API=` 与不写不一样
不写会回退到默认值 `http://danmu_api:9321`；显式写空串才表示「不用聚合服务」。
没起 `danmu_api` 又没置空时，每个弹幕请求都会先等一次超时才降级。
:::

## 局域网访问

默认 `apiserver` 与 `danmu_api` 只绑 `127.0.0.1`，外部只能通过 `web` 的 nginx 反代访问。
如果别的设备（TV、手机）要直连后端：

1. 把 `APISERVER_BIND` 改成 `0.0.0.0`
2. **同时设置 `MEOW_AUTH_TOKEN`**，否则同一网段任何人都能清空你的收藏与配置
3. 设了令牌后，**浏览器端也要在「设置 → 连接 → 写操作令牌」填同一个值**——令牌只注入后端，web 容器不转发它，不填的话导入配置 / 收藏 / 保存设置都会 401
4. 只在可信网络里这么做，公网暴露请走反向代理 + HTTPS

## 从源码构建

```bash
cd deploy/docker
docker compose -f docker-compose.build.yml up -d --build
```

三个镜像都支持 amd64 + arm64，Docker 按本机架构自动选。

## 排障

| 症状 | 先查什么 |
|---|---|
| 页面白屏、静态资源 404 | 镜像的 `base` 必须与访问路径一致（子路径部署时尤其常见） |
| 页面能开但接口 503 | `web` 的 `MEOW_APISERVER` 指向的容器名/端口；重建容器时**必须带 `--network-alias apiserver`**，否则 nginx 解析不到 |
| 接口 403 / 跨域 | `MEOW_CORS` 与 `MEOW_AUTH_TOKEN`；写门禁与下发白名单必须一致 |
| 后端起来了但站点全红 | 容器内能不能访问源包地址；`127.0.0.1` 在容器里指容器自己 |
| drpy 站全部不可用 | `drpy` 容器是否在跑，`MEOW_JS_RUNTIME` 是否可达 |
| 弹幕一直转圈 | `danmu_api` 是否健康；不想要就显式置空 `MEOW_DANMAKU_API=` |
| 播放卡顿 / 转码失败 | `apiserver` 里有没有 ffmpeg；看后端日志的 `hopError` / `playError` |

看日志：

```bash
docker compose logs -f apiserver
docker compose logs -f web
```

## 升级

```bash
cd deploy/docker        # 方式二就进编排文件所在目录
docker compose pull
docker compose up -d
```

**升级要先把版本号换掉**：镜像 tag 由 `MEOW_VERSION` 决定，而 `.env.example` 与下载的编排里都是**钉死的具体版本**——不改版本号时 `pull` 拉到的还是同一个 tag，命令成功但版本没变。两种做法任选：

- 改 `.env` 的 `MEOW_VERSION=<新版本>` 再 `pull`；
- 或者重新下载最新编排文件（里面的兜底版本随发版自动更新）。

数据在宿主编排文件旁的 `./data`（仓库版是仓库根的 `data/`），bind mount，升级不覆盖。跨大版本前建议先备份该目录。

## 相关文档

- 容器细节与完整排障：开发文档 [Docker 部署](/dev/docker)
- 端口、令牌与反代：`.env.example` 的注释是最终依据
