# Web / Docker

Web 形态把前后端拆成四个容器：一个 nginx 静态前端、一个 JVM 后端、一个 drpy 运行时、
一个可选的弹幕聚合服务。

## 前置

- Docker 24+ 与 Compose 插件
- 一个能长期开着的机器（NAS / 小主机 / 服务器）
- 2 GB 可用内存（apiserver 的 JVM 与 ffmpeg 是主要占用）

## 起服务

```bash
git clone https://github.com/upchr/meow.git
cd meow/deploy/docker
cp .env.example .env
docker compose up -d
```

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
| `MEOW_VERSION` | 镜像 tag | 与应用版本一致 |
| `APISERVER_BIND` | 后端监听地址 | `127.0.0.1`（只给本机反代用） |
| `DANMU_BIND` | 弹幕服务监听地址 | `127.0.0.1` |
| `MEOW_AUTH_TOKEN` | 前端调后端时带的令牌 | 空 |
| `MEOW_CORS` | 跨域策略：`*` / `none` / 白名单 | `*` |
| `MEOW_JS_RUNTIME` | drpy 地址 | `http://drpy:9330` |
| `MEOW_DANMAKU_API` | 弹幕聚合地址；**置空写 `MEOW_DANMAKU_API=`** | `http://danmu_api:9321` |
| `MEOW_DATA` | 后端数据目录 | `/data` |

::: warning `MEOW_DANMAKU_API=` 与不写不一样
不写会回退到默认值 `http://danmu_api:9321`；显式写空串才表示「不用聚合服务」。
没起 `danmu_api` 又没置空时，每个弹幕请求都会先等一次超时才降级。
:::

## 局域网访问

默认 `apiserver` 与 `danmu_api` 只绑 `127.0.0.1`，外部只能通过 `web` 的 nginx 反代访问。
如果别的设备（TV、手机）要直连后端：

1. 把 `APISERVER_BIND` 改成 `0.0.0.0`
2. **同时设置 `MEOW_AUTH_TOKEN`**，否则同一网段任何人都能清空你的收藏与配置
3. 只在可信网络里这么做，公网暴露请走反向代理 + HTTPS

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
cd deploy/docker
docker compose pull
docker compose up -d
```

数据在 `MEOW_DATA` 挂载的目录里，升级不覆盖。跨大版本前建议先备份该目录。

## 相关文档

- 容器细节与完整排障：开发文档 [Docker 部署](/dev/docker)
- 端口、令牌与反代：`.env.example` 的注释是最终依据
