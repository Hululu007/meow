# Docker 构建与部署手册

> **2026-11-09 纯壳剥离**：公开镜像不再内置 `spider.jar` / 真实 `config.sites.json`；
> 首启播种 `config.sites.example.json`（空壳，44 个静态站），jar 站由用户在应用内
> **导入源包**恢复。私有全量构建才把 jar 放回 `libs/`、真实配置作为 seed。
> 源包规则见 README「源包」。

> **面向**：要自己部署一份 Meow 后端 / 换机器重建 / 出问题排查的人。
>
> **代码位置**：全部在 `deploy/docker/` —— `Dockerfile.web`、`Dockerfile.apiserver`、
> `Dockerfile.drpy`、`docker-compose.yml`、`docker-compose.build.yml`、
> `nginx.conf.template`、`.env.example`。
> （弹幕服务用官方镜像，没有自己的 Dockerfile。）
>
> **源包静态服务是独立编排**：`Dockerfile.sources`、`nginx.sources.conf`、
> `docker-compose.sources.yml`，不包含在下面的四个容器里，部署见
> [`SOURCE_PACK.md`](../deploy/SOURCE_PACK.md)。
>
> **★ 所有 `docker compose` 命令都要先在 `deploy/docker/` 下执行**：两个 compose 的
> `context: ../..` 与 `volumes: ../../data` 都相对该目录，在仓库根目录跑会报
> `open ...\docker-compose.yml: The system cannot find the file specified`（实测）。
>
> **实测环境**：Windows 10 + Docker Desktop（Engine 28.5.2 / Compose v2.40.3）。
> 本文所有数字与报错都是**本机实跑出来的**，不是推演。

---

## 一、部署形态：四个容器

> **2026-10-24 更正**：此前是三个，`drpy` 是后加的（0.9.x 起）。
> 镜像体积那一列也重测过——`apiserver` 因为内置 ffmpeg 从 566MB 涨到 1.33GB；
> **0.9.15 实测是 1.05GB（amd64）/ 279MB（arm64）**，1.33GB 是 0.9.4–0.9.6 的值。

```
                    ┌──────────────────────────────┐
   浏览器 ──30010──▶ │ web          nginx + 静态文件 │  ← 不含 JVM
                    │              反代 /api        │
                    └───────────────┬──────────────┘
                                    │ http://apiserver:9979
                    ┌───────────────▼──────────────┐
   PC / TV ──30011─▶│ apiserver  JRE+spider+ffmpeg  │  ← 不含 nginx
                    │              /data 持久化     │
                    └──────┬────────────────┬──────┘
                           │                │ http://danmu_api:9321
        http://drpy:9330   │                │
                    ┌──────▼───────┐  ┌─────▼────────────┐
                    │ drpy         │  │ danmu_api        │
                    │ Node 运行时  │  │ 官方镜像（拉取）  │
                    └──────────────┘  └──────────────────┘
```

| 容器 | 来源 | 内容 | 宿主端口（默认） | 镜像体积 |
|---|---|---|---|---|
| `web` | `deploy/docker/Dockerfile.web` 本地构建 | nginx 1.27 + 前端构建产物 | `0.0.0.0:30010` | **98.9MB**（0.9.15 实测） |
| `apiserver` | `deploy/docker/Dockerfile.apiserver` 本地构建 | JRE 17 + `classes/` + `libs/`（公开依赖，**不含 spider.jar**）+ **ffmpeg** | `127.0.0.1:30011` | **1.05GB**（0.9.15 amd64 实测；arm64 279MB；不装 ffmpeg 时 ~566MB） |
| `drpy` | `server/drpy` 本地构建 | Node 运行时，跑 `.js`/drpy 源 | `0.0.0.0:30013` → 容器内 9330 | 341MB |
| `danmu_api` | `logvar/danmu-api:1.21.6` 官方镜像 | 上游 Node 服务 | `127.0.0.1:30012` | 685MB |

**`drpy` 为什么不能省**：配置里 200+ 个源是 drpy/`.js`，没有这个运行时它们会被判
"不可用"（`apiserver` 通过 `MEOW_JS_RUNTIME` 指向它）。`DRPY_STRIP_REMOTE=1` 默认开，
会拒绝执行真实生态里那些从第三方 CDN 拉的混淆脚本（供应链风险）。

**`apiserver` 为什么带 ffmpeg**：浏览器内核（Chromium/WebView2）没有 HEVC 解码器，
NAS 上的 MKV（H.265）在 Web 端放不了；带 ffmpeg 才能按需转 HLS。
代价是镜像从 566MB 涨到 1GB 量级（0.9.15 amd64 实测 1.05GB）——只要能播 Web，这个代价值得付。

拆开的理由：

1. **可只跑后端**（给 TV / 别的 PC 用，不占 30010）
2. **可只跑前端**（`MEOW_APISERVER` 指向别的后端，静态页面不依赖本地 JVM）
3. **互不拖累**：后端崩了前端不 unhealthy；前端一天多次改，后端很少改

弹幕服务用官方镜像，不从本仓库构建——上游源码不在本仓库（`research/` 不入 git），
自建会让使用者 clone 后起不来。版本固定 `1.21.6` 而非 `latest`，升级改
`DANMU_API_IMAGE` 一个变量。

### 1.1 四条不能改的架构约束（改了就坏）

这四条都是踩过坑之后才成的形状，**动之前先读完理由**：

**① `web` 与 `apiserver` 之间刻意没有 `depends_on`**

加了之后 `docker compose up -d web` 会把后端一起拉起来，就失去"只起前端连远端后端"
的能力（那是刻意保留的部署方式）。代价是后端缺席时 web 也能起来——这正是想要的。

**② nginx 的上游必须用变量，不能写死地址**

```nginx
set $meow_backend "${MEOW_APISERVER}";
resolver 127.0.0.11;
proxy_pass http://$meow_backend;
```

写死字面地址时 nginx 在**启动时**解析上游，apiserver 不在就整个 web 容器起不来。
用变量则延迟到请求时，后端缺席只让 `/api` 返 503（带中文说明），静态页面照常加载。

**③ 停单个服务用 `stop/start`，不要用 `down <服务名>`**

`down` 是"拆整个项目"语义，会删掉共享的 `meow` 网络，让其他活着的容器失去网络。
详细症状与替代做法见 §6.1。

**④ `${VAR-默认}` 不能写成 `${VAR:-默认}`**

后者把空串也当"未设置"，所以 `.env` 里写 `MEOW_DANMAKU_API=`（禁用弹幕）会失效——
它会被当成没设置而回落到默认值。

---

## 二、前置条件

### 2.1 软件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Docker Engine | ≥ 20.10（要 BuildKit） | `docker version` |
| Docker Compose | **v2**（`docker compose`，不是 `docker-compose`） | `docker compose version` |
| 磁盘 | 约 **2.1GB**（web 98.9MB + apiserver 1.05GB 含 ffmpeg + danmu 685MB，另加构建缓存）；`apiserver` 不装 ffmpeg 时约 566MB | `docker system df` |
| 内存 | 建议 ≥ 2GB 可用（JVM 上限 512MB） | `docker info \| grep Memory` |

Windows 用 Docker Desktop 即可，不需要 WSL 里另装一套。

### 2.2 仓库里必须存在的文件

| 路径 | 说明 | 是否入库 |
|---|---|---|
| `server/host/src/` | 后端 Java 源码，镜像里编译 | ✅ |
| `server/host/libs/` | **10 个公开依赖 jar**（`android-json` / `asn-one` / `bcprov` / `gson` / `mbassador` / `okhttp` / `okio` / `slf4j-api` / **`smbj 0.13.0`**）。`spider.jar` **不入库**，由源包导入 | ✅ |
| `client/apps/web/` | 前端源码 | ✅ |

**没有额外的源码前置**：弹幕服务用官方镜像，不需要 `research/` 下那份上游源码。

检查：

```bash
ls server/host/libs/                     # 10 个公开依赖，不应有 spider.jar
ls server/host/config.sites.example.json # 公开壳的 seed
```

---

## 三、构建与启动：两个 compose 文件

编排拆成两个**完整且独立**的文件，**二选一，不是叠加**：

| 文件（都在 `deploy/docker/`） | 作用 | 镜像来源 |
|---|---|---|
| `docker-compose.yml` | 启动 | 从 Registry 拉 |
| `docker-compose.build.yml` | 构建 + 启动 | 本地源码构建 |

两个文件的端口、环境变量、卷、网络、`name: meow`、`container_name` 完全一致，
唯一差别是前者的 web/apiserver 没有 `build:` 段、后者有。
所以切换时是接管同一组容器，不会产生两套实例。

### 3.1 直接用发布镜像（推荐给使用者）

```bash
cd deploy/docker
cp .env.example .env          # 首次
docker compose up -d
```

实测：清空本地镜像后 9 秒拉完并启动（danmu 层已在本地缓存）。

默认镜像来自 `chrplus/meow-web:0.9.15` 和 `chrplus/meow-apiserver:0.9.15`
（amd64 + arm64 双架构，Docker 自动选）。要用别人的镜像改 `.env`：

```ini
WEB_IMAGE=yourname/meow-web:0.9.15
APISERVER_IMAGE=yourname/meow-apiserver:0.9.15
```

### 3.1.1 升级已部署的实例

改 `.env` 里的 `MEOW_VERSION`，然后**必须显式 `pull`**——

```bash
cd deploy/docker
sed -i 's/^MEOW_VERSION=.*/MEOW_VERSION=0.9.15/' .env
docker compose pull web apiserver drpy
docker compose up -d
```

`docker compose up -d` 发现本地已有同 tag 镜像就不会再拉，所以只改 `.env`
不 `pull` 会静默继续跑旧版。验证：

```bash
curl -s localhost:30011/api/health | grep -o '"version":"[^"]*"'
```

### 3.1.2 离线升级（目标机拉不动 Docker Hub，用 tar 导入）

OECT / NAS 这类设备常常拉不动 Docker Hub（实测 `docker pull` 报
`short read: expected N bytes but got M`，重试多次仍失败）。走离线包：

```bash
# 1) 在有网的机器上构建目标架构镜像（OECT 是 aarch64）
docker buildx build --platform linux/arm64 -f deploy/docker/Dockerfile.apiserver \
  -t chrplus/meow-apiserver:0.9.38-arm64 --load .
docker buildx build --platform linux/arm64 -f deploy/docker/Dockerfile.web \
  -t chrplus/meow-web:0.9.38-arm64 --load .

# 2) 导出 + 压缩 + 传过去
docker save chrplus/meow-apiserver:0.9.38-arm64 chrplus/meow-web:0.9.38-arm64 \
  -o meow-0.9.38-arm64.tar
gzip -6 meow-0.9.38-arm64.tar
scp -P <port> meow-0.9.38-arm64.tar.gz root@<host>:/tmp/

# 3) 目标机上导入，并打成 compose 用的 tag
gunzip /tmp/meow-0.9.38-arm64.tar.gz
docker load -i /tmp/meow-0.9.38-arm64.tar
docker tag chrplus/meow-apiserver:0.9.38-arm64 chrplus/meow-apiserver:0.9.38
docker tag chrplus/meow-web:0.9.38-arm64      chrplus/meow-web:0.9.38

# 4) 改版本并重建（本地已有该 tag，pull 会失败但 up 会用本地镜像）
sed -i 's/^MEOW_VERSION=.*/MEOW_VERSION=0.9.38/' .env
docker compose up -d --force-recreate apiserver web
```

**★ tag 要打两遍**：`docker save` 带的是 `-arm64` 后缀那个 tag，而 compose
引用 `chrplus/meow-apiserver:${MEOW_VERSION}`。漏打表现为"拉取失败、容器起不来"。

**★ 判断升级成功看 `/api/health` 的 `version`**，不要看镜像 tag —— 同 tag 镜像
可能没换（compose 会静默复用）。

### 3.1.3 ★★ 手工替换 jar 的陷阱：容器加载的是 `classes/`，不是 `jar`

镜像启动命令是：

```
java -cp 'classes:libs/*' ApiServer        # 工作目录 /app
```

**它加载 `/app/classes/*.class`，不加载 `/app/apiserver.jar`。** 排查
"改了代码但行为没变"时踩过：连续 4 次 `docker cp apiserver.jar` 全部无效，
因为那个 jar 根本不在类路径上。

临时验证改动可以用（覆盖 `classes/` 目录）：

```bash
tar czf /tmp/classes.tgz -C server/host/classes .
docker cp /tmp/classes.tgz meow-apiserver:/tmp/
docker exec meow-apiserver sh -c 'cd /app && tar xzf /tmp/classes.tgz'
docker restart meow-apiserver
```

**解压必须在 `/app` 下**：`-C` 写错成 `/` 会把文件落到 `/classes`，容器照样跑旧代码
（同一次排查里也踩了）。

**`docker cp` 是临时的**：容器重建（`--force-recreate` / `up -d`）就没了。
正式发版必须重建镜像。

### 3.1.4 ★ 三个会让"服务在跑但搜不到"的环境坑

| 症状 | 根因 | 修法 |
|---|---|---|
| danmu_api 局域网/域名访问不通，容器内 `127.0.0.1:30012` 正常 | `.env` 的 `DANMU_BIND=127.0.0.1` 只绑本机 | 改 `DANMU_BIND=0.0.0.0` 后重建容器 |
| 227 个 drpy 源各卡 8~30 秒，搜索第 2 次起全空 | `meow-drpy` 容器 unhealthy（卡在拉取 GitHub 规则），但 `MEOW_JS_RUNTIME` 仍指向它 | `docker restart meow-drpy`；确认容器能访问规则托管站 |
| 单站直调正常，一聚合就大面积 `UnknownHostException: Temporary failure in name resolution` | 并发解析压垮 docker 内嵌 DNS（`127.0.0.11` 转发上游排队超时） | 偶尔发生可忽略；持续失败可在 compose 给 apiserver 加 `dns:` 指向公共 DNS |

第二个是**最容易误判**的：`/health` 会返回 `{"ok":true}`（容器只是忙、不是死），
但真实搜索请求全部卡住。后端 0.9.38 起会用"脚本源的实际回收率"做自适应降级
（提交数 vs 回来数），不再只信 `/health`。

### 3.2 从源码构建（推荐给改代码的人）

```bash
cd deploy/docker && docker compose -f docker-compose.build.yml up -d --build
```

只需要指定一个文件。构建产物按 image 名打 tag（默认 `chrplus/meow-web:0.9.15`），
构建完成后即使改用 `docker-compose.yml` 启动，也会命中本地已构建的镜像
（`cd deploy/docker && docker compose up -d` 发现本地有同 tag 镜像就不拉取）。

冷构建实测耗时（`--no-cache`，本机 x64）：

| 镜像 | 耗时 | 说明 |
|---|---|---|
| `meow-web` | **22s** | pnpm install + vite build + nginx |
| `meow-apiserver` | **32s** | javac 全量编译 ~100 个源文件 |

有缓存时增量重建通常 2–5 秒。

### 3.3 只重建某一个

```bash
cd deploy/docker
docker compose -f docker-compose.build.yml build web       && docker compose up -d web
docker compose -f docker-compose.build.yml build apiserver && docker compose up -d apiserver
```

### 3.4 不想跑弹幕服务

```bash
cd deploy/docker && docker compose up -d web apiserver
```

同时把 `.env` 里的 `MEOW_DANMAKU_API` 置空（`MEOW_DANMAKU_API=`），
否则每次弹幕搜索要白等一次超时才降级（实测约 5.1 秒）。

### 3.5 彻底重建

```bash
cd deploy/docker
docker compose -f docker-compose.build.yml build --no-cache
docker compose -f docker-compose.build.yml up -d
```

### 3.6 构建上下文与 `.dockerignore`

两个 Dockerfile 的 context 都是**仓库根目录**，靠 `.dockerignore` 裁剪：

1. **`**/node_modules/` 必须排除**。不排的话 `COPY` 会把本地依赖目录带进镜像，
   覆盖容器内刚装好的依赖，报 `ERR_MODULE_NOT_FOUND: @vitejs/plugin-vue`。
2. **`research/` 与 （私有开发资料） 整目录排除**（648MB，镜像用不到）。
3. **排除 `data/` 与 `.env`**：运行时数据不进镜像，配置走 compose 注入。

### 3.7 多架构镜像发布

compose 不做 manifest list（一个 tag 下多架构）。要发布 arm64 支持请用
`build-push-docker.ps1`，见 §7。

---

## 四、配置：`.env` 与 compose 的分工

这是最容易搞混的地方，先说清楚**谁读什么**。

### 4.1 `deploy/docker/.env` 只给 docker compose 用

| 谁 | 实际读什么 |
|---|---|
| `docker compose` | **`deploy/docker/.env`**（唯一读者；compose 从它所在目录读同名 `.env`） |
| 前端 Vite | `client/apps/web/.env*`（本项目没有） |
| 后端 Java | **系统环境变量**（不解析 .env 文件） |
| danmu_api | 容器内 `/app/config/.env`（即宿主 `data/danmu/.env`） |
| PC 客户端 | `%APPDATA%\com.meow.player\` |

所以这个 `.env` 不是"应用的配置文件"，是 **compose 的变量覆盖层**。
它不入库（`.gitignore` 的 `.env` 规则），模板是同目录的 `.env.example`。

### 4.2 默认值在 compose，`.env` 只做覆盖

```yaml
# docker-compose.yml —— 默认值的唯一来源
MEOW_DANMAKU_API: ${MEOW_DANMAKU_API-http://danmu_api:9321}
```

```ini
# deploy/docker/.env —— 只写要改的项；全注释 = 全用默认值
MEOW_DANMAKU_API=http://danmu_api:9321
```

改默认行为 → 改 `deploy/docker/docker-compose.yml`；改本机部署 → 改
`deploy/docker/.env`。查当前生效值：`cd deploy/docker && docker compose config`。

> **语法坑**：`${VAR-默认}` 与 `${VAR:-默认}` 不同。后者把空串也当"未设置"，
> 因此"置空 `MEOW_DANMAKU_API` 来禁用弹幕"会失效。本项目用 `-`。

### 4.3 两组变量

| 组 | 变量 | 是否进容器 |
|---|---|---|
| **A 宿主侧** | `MEOW_VERSION`、`WEB_PORT`、`APISERVER_BIND`、`APISERVER_PORT`、`DANMU_BIND`、`DANMU_API_PORT`、`DANMU_API_IMAGE` | ❌ |
| **B 容器内** | `MEOW_APISERVER`、`MEOW_DANMAKU_API`、`MEOW_AUTH_TOKEN`、`DANMU_SOURCE_ORDER`、`APISERVER_JAVA_OPTS` | ✅ |

### 4.4 变量全表

| 变量 | 默认 | 组 | 什么时候改 |
|---|---|---|---|
| `MEOW_VERSION` | `0.9.39`（compose 兜底，**不是**代码版本） | A | 版本号；即 `meow/{web,apiserver,drpy}` 的镜像 tag |
| `DANMU_API_IMAGE` | `logvar/danmu-api:1.21.6` | A | 升级弹幕服务 |
| `DRPY_IMAGE` | `chrplus/meow-drpy:${MEOW_VERSION}` | A | 升级 drpy 运行时 |
| `WEB_PORT` | `30010` | A | 端口冲突时 |
| `APISERVER_BIND` | `127.0.0.1` | A | 给 TV / 局域网直连改 `0.0.0.0`（见 §10） |
| `APISERVER_PORT` | `30011` | A | 端口冲突时 |
| `DANMU_BIND` | `127.0.0.1` | A | 想从别的机器看 danmu UI 时 |
| `DANMU_API_PORT` | `30012` | A | 端口冲突时 |
| `DRPY_PORT` | `30013` | A | 端口冲突时 |
| `MEOW_APISERVER` | `http://apiserver:9979` | B | web 连外部后端时改绝对地址 |
| `MEOW_JS_RUNTIME` | `http://drpy:9330` | B | 不启动 drpy 时置空（`.js` 源会全部不可用） |
| `MEOW_DANMAKU_API` | `http://danmu_api:9321` | B | 不启动 danmu_api 时置空 |
| `MEOW_AUTH_TOKEN` | 空（关闭鉴权） | B | 后端不只监听本机时设（见 §4.6） |
| `DANMU_SOURCE_ORDER` | 8 个来源 | B | 调整来源优先级；不配只有 3 个来源 |
| `APISERVER_JAVA_OPTS` | `-Xms64m -Xmx512m …` | B | 小内存机器降 `-Xmx256m` |

> **★ `MEOW_VERSION` 的兜底值必须与代码版本同步**（当前 `0.9.39`）。没建 `.env` 时
> `cd deploy/docker && docker compose up -d` 会去拉兜底版本的旧镜像——表现是"代码是新的、跑起来是旧行为"。
> 改版本时要么一起改 compose 的兜底，要么确保 `.env` 存在（`.env.example` 里是当前版本）。
>
> **★ `MEOW_JS_RUNTIME`、`MEOW_DANMAKU_API`、`MEOW_AUTH_TOKEN` 用的是 `${VAR-默认}` 而不是 `${VAR:-默认}`。**
> 后者把空串也当"未设置"，所以想禁用/关闭时写 `MEOW_JS_RUNTIME=` 之类的空值只有前者生效。

> 容器内的 `MEOW_DATA=/data`、`MEOW_PORT=9979`、`DANMU_API_PORT=9321` 是固定值，
> 由网络拓扑决定，不暴露给 `.env`。

### 4.5 四种典型配置

**A. 单机自用（默认，什么都不用改）**

```bash
cd deploy/docker && docker compose up -d --build
# http://localhost:30010
```

**B. 局域网给 TV / 手机 / 别的 PC**

```ini
APISERVER_BIND=0.0.0.0
```

```bash
cd deploy/docker && docker compose up -d apiserver     # 重建容器让端口生效
# 客户端填 http://<本机IP>:30011
```

**C. 只跑后端（不要网页）**

```bash
cd deploy/docker && docker compose up -d apiserver danmu_api
# PC 端「设置 → 后端地址」填 http://<IP>:30011
```

**D. 只跑前端，后端在别的机器**

```ini
MEOW_APISERVER=http://192.0.2.10:30011
```

```bash
cd deploy/docker && docker compose up -d web
```

实测这条路径可用：把 `MEOW_APISERVER` 指到宿主上的后端
（`http://host.docker.internal:30011`）也能正常反代。

> 改了 `.env` 的 `MEOW_APISERVER` / 端口后必须 `up -d <服务>` **重建容器**，
> `restart` 不会重新读环境变量。

### 4.6 数据目录

| 宿主路径 | 容器路径 | 内容 | 删了会怎样 |
|---|---|---|---|
| `./data/` | `/data`（apiserver） | `policy.json`（弹幕地址/DNS/WebDAV）、`config.sites.json`、缓存 | 设置全丢；`config.sites.json` 由 ENTRYPOINT 重新播种，公开壳回到 **44** 个静态站（example seed）；私有全量构建的真实 seed 实测 56 个 |
| `./data/danmu/` | `/app/config`（danmu_api） | `.env`（首次自动从 `.env.example` 生成，503 行） | 回到默认配置，`TOKEN` 重置 |

两者都是 **bind mount**，容器删除/重建不影响；备份直接拷目录：

```bash
tar czf meow-data-$(date +%F).tar.gz data/
```

恢复：

```bash
docker compose down
tar xzf meow-data-2026-10-22.tar.gz
cd deploy/docker && docker compose up -d
```

### 4.7 导入源包 / 换 spider jar

公开壳镜像**不含** `spider.jar`。推荐在应用内导入源包：

1. 把 JVM 源包放在容器**可达**的地址（NAS / 宿主 LAN IP / `host.docker.internal`）。
   **不能写 `127.0.0.1`**：容器里的回环是容器自己，实测报 `Connection refused`。
2. 设置 →「配置源」填 config URL（顶层 `spider` 指向 **class 形态** jar，可带 `;md5;`）；
   导入时勾选「用这份配置的顶层 spider 覆盖本地」（API 传 `replaceSpider:true`）。
3. `Jars.reload()` 挂载后，`/api/health` 的 `sites` 从 44 涨到导入后的数量（如 56），
   jar 站可搜。

私有全量构建要内置：把 class jar 放到 `server/host/libs/spider.jar` 再 build，
或在 compose 里挂载（文件必须存在；Docker 遇到不存在的 bind 源会创建空目录，
`/app/libs/spider.jar` 变目录 → `ClassNotFoundException`、容器 unhealthy）。

### 4.8 写操作令牌（`MEOW_AUTH_TOKEN`）

**保护什么**：所有**改状态**的端点。GET/HEAD 永不拦，所以搜索、详情、播放、
首页这些读操作完全不受影响。

| 路径 | 影响 |
|---|---|
| `/api/state/*` | 收藏、进度、历史 |
| `/api/config/import` | 导入站点配置 |
| `/api/policy` | 改运行时策略 |
| `/api/webdav` | WebDAV 同步 |
| `/api/library*` | 片库（含删除文件） |
| `/api/cache*` | 离线缓存清理 |
| `/api/health/*` | 停用源、重置健康、探活 |
| `/api/transcode` | 转码任务 |

**什么时候需要设**：后端不只监听 `127.0.0.1` 时。典型场景是把本机当家庭共享
后端（`APISERVER_BIND=0.0.0.0`，见 §10），同一 WiFi 下任何人都能访问 30011。
不设令牌的话，别人能清空你的收藏、删缓存、通过片库删 NAS 上的文件。

**只监听 `127.0.0.1` 的单机自用不需要设**，这也是默认值留空的原因。

```bash
# .env
MEOW_AUTH_TOKEN=换成你自己的长随机串
```

```bash
docker compose up -d --force-recreate apiserver
```

**生效判据**（不需要回显令牌，看这两个字段就够）：

```bash
curl -s http://127.0.0.1:30011/api/health | python -m json.tool | grep auth
#   "authRequired": true,
#   "authSource": "env"        ← env / policy / none
```

`authSource` 能区分"环境变量生效了"和"还在读 policy.json"，排查时不用猜。

**客户端要填同一个值**：设置 → 连接 → 写操作令牌。它只存在客户端本机
localStorage（`meow.authToken`），**不参与跨端同步、也不进备份**。

**忘了令牌**：改 `.env` 重启，或进容器改 `/data/policy.json`。

```bash
docker exec meow-apiserver sh -c 'cat > /data/policy.json <<EOF
{"authToken":""}
EOF'
docker restart meow-apiserver
```

**读取优先级**：`MEOW_AUTH_TOKEN` → `policy.json` 的 `authToken`。
两处都空才关闭鉴权。所以设了环境变量后，policy.json 里那份会被忽略——
想临时关闭时把 `.env` 里的置空即可（`-` 语法保证了空串有效）。

> **★ 一旦开了鉴权，`/api/policy` 自己也在保护列表里** ——改策略要带令牌。
> 这容易把自己锁在门外，`authSource` 字段就是为排查这个加的。

---

## 五、启动与验证

### 5.1 启动

```bash
cd deploy/docker && docker compose up -d
cd deploy/docker && docker compose ps
```

期望（启动后约 25 秒，等 `/api/health` 通过）：

```
NAME             STATUS                    PORTS
meow-apiserver   Up 25 seconds (healthy)   127.0.0.1:30011->9979/tcp
meow-danmu-api   Up 25 seconds (healthy)   127.0.0.1:30012->9321/tcp
meow-drpy        Up 25 seconds (healthy)   0.0.0.0:30013->9330/tcp
meow-web         Up 25 seconds (healthy)   0.0.0.0:30010->8080/tcp
```

> 少了 `meow-drpy` 未必立刻报错——`/api/health` 的 `ok` 不看它。
> 表现是配置里那些 `.js`/drpy 源在搜索和分类里静默消失。
> 判断方法：`curl -s localhost:30011/api/health` 之后随便搜一部片，
> 若只有 csp_ 开头的源有结果，就是 drpy 没起来。

就绪顺序不一样：`web` 约 6 秒 healthy（不等后端），`apiserver` 约 20–25 秒
（要编译期加载的类 + 站点表），`danmu_api` 约 12–20 秒。

### 5.2 验证清单

| # | 命令 | 期望 |
|---|---|---|
| 1 | `curl -s localhost:30010/healthz` | `{"ok":true,"role":"web"}` |
| 2 | `curl -s localhost:30010/api/health` | `"ok":true`、`"version":"0.9.15"`、`"sites":56`、`"spiderJar":true`、`"capabilities"` 7 项（`danmaku/search/proxy/webdav/dns/state/parse`，实测） |
| 3 | `curl -s localhost:30011/api/health` | 与 #2 相同（直连后端） |
| 4 | 浏览器开 `http://localhost:30010` | 首页出海报（实测 21 张）、豆瓣 7 个分类 |
| 5 | 搜索「庆余年」 | 出结果（实测 50 部，12 个源标签） |
| 6 | 点进任意影片 | 详情页有简介 + 剧集列表 |
| 7 | `curl -s "localhost:30012/87654321/api/config"` | JSON，`SOURCE_ORDER` 是 8 项 |

全过就说明：前端 → nginx → apiserver → danmu_api 四段都通。

### 5.3 确认连的是哪一版（重要）

`/api/health` 里的 `version` 是**唯一可靠**的版本标识。历史上踩过：
本机还跑着旧后端时，Vite/nginx 会静默连到旧版本（源数量对不上才发现）。

```bash
curl -s localhost:30010/api/health | grep -o '"version":"[^"]*"'
curl -s localhost:30011/api/health | grep -o '"version":"[^"]*"'
```

两个必须一致。前端设置页显示的源数量也应与 `sites` 对得上。

---

## 六、日常操作

### 6.1 启停（★ 别用 `down <服务名>`）

```bash
docker compose stop web            # 只停前端，后端继续跑
docker compose start web

docker compose stop apiserver      # 只停后端
docker compose start apiserver
```

**不要用 `docker compose down web`**。`down` 是"拆整个项目"语义，
会把这个项目共享的 `meow` 网络一起删掉，另外两个还活着的容器立即失去网络：

```
Error response from daemon: failed to set up container networking:
network 5c565e931323... not found
```

实测踩过：之后 `up` 也起不来，必须 `docker compose down` 整体重建。
真要删单个容器用 `rm -sf`：

```bash
docker compose rm -sf web          # 安全，不动网络
```

### 6.2 日志

```bash
docker compose logs -f                 # 三合一
docker compose logs -f apiserver       # 后端
docker compose logs --tail 50 web      # 最近 50 行 nginx
```

`apiserver` 启动成功的关键日志：

```
[data] root = /data
[api] multi-instance sites: 56
[api] 0.9.15 listening on http://127.0.0.1:9979
[api] sites: 56 | ext: 28
[api] danmaku api: configured
```

> 上面是**播种了 `config.sites.json` 之后**的形状（本机实测 0.9.15，
> 数据目录放仓库那份 40 条配置 → `sites:56 / ext:28`）。没有该文件时是
> `sites:44 | ext:11`（硬编码 `SITES.put("…")` 44 处、`EXT.put("…")` 11 处，
> 实测 0.9.15 无配置启动日志）。

### 6.3 升级（改了代码之后）

```bash
# 改了前端
docker compose build web && cd deploy/docker && docker compose up -d web

# 改了后端 Java
docker compose build apiserver && cd deploy/docker && docker compose up -d apiserver

# 改了版本号（.env 的 MEOW_VERSION）
docker compose build && cd deploy/docker && docker compose up -d
```

旧镜像会留着（新 tag 生成新镜像）。清理：

```bash
docker image prune -f              # 清悬空镜像
docker rmi meow/web:0.7.0          # 清指定旧版本
```

### 6.4 回滚

镜像是按 `.env` 的 `MEOW_VERSION` 打 tag 的，回滚就是改回旧版本号再起：

```bash
# .env 里 MEOW_VERSION=0.7.0
cd deploy/docker && docker compose up -d              # 镜像已存在时不会重建
```

前提是旧镜像没被 prune 掉。

### 6.5 完全卸载

```bash
docker compose down               # 删容器 + 网络（不动 data/）
rm -rf data/                      # ⚠️ 这一步才删配置与缓存
docker rmi meow/web:0.9.15 meow/apiserver:0.9.15
docker builder prune -f           # 清构建缓存（可选）
```

---

## 七、ARM 架构与多架构镜像发布

### 7.1 支持情况

**代码和基础镜像都支持 arm64**，实测在 x64 机器上交叉构建出的 arm64 镜像可以正常启动：

| 镜像 | 基础镜像架构 | arm64 实测 |
|---|---|---|
| `web` | `node:22-alpine` + `nginx:1.27-alpine` | 构建 157s，容器起得来，首页 200 |
| `apiserver` | `eclipse-temurin:17-jdk/jre` | 构建 130s，JVM 启动、监听 9979 正常 |
| `danmu_api` | `logvar/danmu-api` | 官方镜像原生带 amd64 + arm64 |

前端依赖里唯一的原生模块是 `sharp`，只用于 `client/brand/build-icons.mjs`（图标生成），
**不在 Web 构建链路上**，所以不影响跨架构构建。

### 7.2 为什么本机 `docker build` 出来的镜像到 ARM 上用不了

普通 `docker build` 只产出**当前机器架构**的镜像。在 x64 上构建的镜像拷到
树莓派 / M 系列 Mac 上会报：

```
exec format error
```

要让"一条 `docker pull` 在两种架构上都能用"，必须构建**多架构清单**
（manifest list / OCI image index）：一个 tag 下挂多份架构镜像，
客户端按自己的架构自动选。

### 7.3 用脚本构建并推送

仓库根有 `build-push-docker.ps1`，一次产出 `linux/amd64` + `linux/arm64`：

```powershell
# 1. 登录（只需一次）
docker login

# 2. 演练：只构建不推送，检查有没有问题
./deploy/scripts/build-push-docker.ps1 -User yourname -DryRun

# 3. 真正推送到 Docker Hub
./deploy/scripts/build-push-docker.ps1 -User yourname
#   → yourname/meow-web:0.9.15 + :latest
#   → yourname/meow-apiserver:0.9.15 + :latest
```

常用参数：

| 参数 | 作用 |
|---|---|
| `-User` | **必填**，Docker Hub 用户名（或 `registry.example.com/ns`） |
| `-RepoPrefix` | 仓库名前缀，默认 `meow-` → `meow-web`；传 `""` 得 `yourname/web` |
| `-Platforms` | 默认 `linux/amd64,linux/arm64`；只想要一个架构就传 `linux/amd64` |
| `-Version` | 默认读 `client/package.json` 的 `version` |
| `-NoLatest` | 不打 `latest` 标签 |
| `-DryRun` | 只构建，产物导出到 `.tmp/*-oci.tar`，不推送 |
| `-SkipBuild` | 跳过构建，直接重推已有镜像 |

脚本自己会检查：`docker buildx` 是否存在、arm64 QEMU 模拟器是否注册、
推 Docker Hub 时是否已登录。

### 7.4 前置条件

| 项 | 说明 |
|---|---|
| `docker buildx` | Docker Desktop 自带；Linux 需装 buildx 插件 |
| QEMU 模拟器 | 跨架构构建需要。脚本检测到缺失会自动 `tonistiigi/binfmt --install arm64` |
| Docker Hub 账号 | https://hub.docker.com 注册即可，免费账号可建公开仓库 |
| 首次推送前 | 在 Hub 上**手动创建** `meow-web` 和 `meow-apiserver` 两个仓库（或脚本推送时自动创建，取决于账号设置） |

> **第一次跑会比较慢**：跨架构构建走 QEMU 模拟，实测 web 157s、apiserver 130s
> （本机 x64，缓存空的情况下）。之后有层缓存会快很多。

### 7.5 用别人发布的镜像（不构建）

镜像推上去之后，其他人不需要源码就能跑：

```ini
# .env
WEB_IMAGE=yourname/meow-web:0.9.15
APISERVER_IMAGE=yourname/meow-apiserver:0.9.15
```

```bash
cd deploy/docker && docker compose up -d        # 不再 --build，直接拉
```

`DANMU_API_IMAGE` 同理（默认已经是官方镜像）。

### 7.6 验证镜像是多架构的

```bash
docker buildx imagetools inspect yourname/meow-web:0.9.15
```

期望看到两行 `Platform:`：

```
Platform:    linux/amd64
Platform:    linux/arm64
```

只有一行说明是单架构（多半是没用 buildx）。

---

## 八、实测基准（2026-10-22）

改动 Docker 资产后应能复现，用于回归。

> **2026-10-26 复核**：下表是**内置 ffmpeg 之前**的数字（apiserver 448MB）。
> 现在 apiserver 镜像含 ffmpeg，`docker images` 实测
> `meow-apiserver:0.9.15-amd64` = **1.05GB**、`meow-web:0.9.15` = **98.9MB**
> （多架构清单；单架构 amd64 层 76.4MB）。其余功能链路数字未重测。

### 8.1 构建与体积

| 项 | 值 |
|---|---|
| web 冷构建 / 体积 | 22s / **76MB**（现多架构合并显示 98.9MB） |
| apiserver 冷构建 / 体积 | 32s / 448MB（**现含 ffmpeg，约 1.05–1.33GB**） |
| danmu 官方镜像 / 体积 | 拉取 / 685MB（`logvar/danmu-api:1.21.6`） |

### 8.2 独立启停

| 场景 | 结果 |
|---|---|
| 只 `up -d web`（无后端） | 容器 **healthy**，首页 200，`/api` 返 **503 + 中文 JSON** |
| 只 `up -d apiserver danmu_api`（无前端） | 后端 healthy，直连 30011 正常 |
| `stop apiserver` | 首页仍 200，`/api` 503；`start` 后 **web 无需重启**自动恢复 |
| web 指向 `host.docker.internal:30011` | 反代正常（可只起前端连远端后端） |
| `rm -sf web` 后重建 | 网络未受影响，其余容器正常 |

后端重启后 web 自动恢复，是因为 nginx 用变量上游 + `resolver`，
每 5 秒重新解析 Docker DNS，而不是启动时锁定 IP。

### 8.3 功能链路

| 项 | 实测 |
|---|---|
| 首页 | 200，60 个卡片 / 21 张海报 / 豆瓣 7 分类 |
| 搜索「庆余年」 | 50 部影片、12 个源标签（哔哩 20 / 咕噜 17 / 瓜子 12 / 干饭 10 …） |
| 详情页 | 36 集列表 + 简介 + 播放源 |
| 弹幕搜索 | 200 条候选中 199 条来自 danmu_api 容器 |
| 弹幕 XML | **42296 条 / 4.19MB** |
| 停 danmu_api | 5.1 秒降级到官方直连（腾讯源），链路不断 |

### 8.4 Docker vs fpk 的资源口径（2026-11-06 实测）

> **只在功能等价时比**：两边都去掉 drpy / danmu 差异，只留「壳 + Java + 前端」。

| 项 | Docker | fpk（meowd 进程内） | 说明 |
|---|---|---|---|
| 常驻内存（Pss） | **182.8 MiB** | **179.6 MiB** | 差 **1.8%** |
| 容器化固定开销 | **≈28 MiB** | — | 网络命名空间、overlay、容器运行时 |
| 磁盘 | **≈14×** | 1× | 镜像层 + 依赖双份；`docker images` 与实际解包体积对比 |
| 冷启动 | **1.9 s** | **26 ms** | 直接拉起进程，无容器编排 |

**★ 不要写成「2.66×」**：那个数字是把「drpy + 弹幕各自独立 Node 进程」与
「进程内实现」混算出来的——口径不同，不具可比性。按 Pss 同口径实测只差 1.8%，
剩下的是容器固定成本，不是运行时本身的差距。

**复测**：Docker 侧 `docker exec meow-apiserver sh -c 'grep Pss /proc/1/smaps_rollup'`；
fpk 侧对 meowd / java 的 PID 读同一个文件（`smaps_rollup`）。两边先 idle 30 秒再读。
磁盘用 `docker images` 的层大小与 fpk 解包后 `du -sh` 对比。

---

## 九、排障

### 9.1 `/api` 返 503，首页正常

**这不是故障**，是"后端没起"或"后端地址不对"。

```bash
cd deploy/docker && docker compose ps                    # apiserver 是否 healthy
docker compose logs apiserver | tail -20
curl -s localhost:30011/api/health   # 直连后端
```

返回体是刻意设计的中文提示：

```json
{"code":-1,"msg":"apiserver 未连接：请启动 apiserver 容器，或把 MEOW_APISERVER 指向可用的后端地址"}
```

如果直连后端正常、经 web 却 503，检查 `MEOW_APISERVER`：

```bash
MSYS_NO_PATHCONV=1 docker exec meow-web env | grep MEOW_APISERVER
MSYS_NO_PATHCONV=1 docker exec meow-web grep -n 'set \$meow_backend' /etc/nginx/conf.d/default.conf
```

> Git Bash 会把 `/etc/nginx/...` 改写成 `O:/tools/Git/etc/...`，必须加
> `MSYS_NO_PATHCONV=1`。PowerShell / CMD 无此问题。

### 9.2 apiserver 一直 `starting` / `unhealthy`

`/api/health` 的 `ok` 需要**同时**满足三条：HTTP 活着 + `spiderJar=true` + `configLoaded=true`。
逐条看：

```bash
curl -s localhost:30011/api/health
```

| 症状 | 原因 | 处理 |
|---|---|---|
| `spiderJar:false`（仅私有全量构建） | `libs/spider.jar` 没打进镜像，或被空目录挂载覆盖 | 见 §4.7；公开壳不需要内置 jar，导入源包即可 |
| `configLoaded:false` | 站点表为空（正常不会发生，`SITES` 是硬编码 44 条） | 检查 `ApiServer` 静态块是否被改坏 |
| 连不上 | 端口被占 / JVM 起不来 | `docker compose logs apiserver` |

### 9.3 拉不到 danmu 镜像

```
Error response from daemon: error from registry: denied
```

或者卡在 `Pulling` 很久。三种情况：

1. **镜像名写错**。官方仓库是 `logvar/danmu-api`（不是 ghcr 上的地址）。
   可用版本见 [Docker Hub](https://hub.docker.com/r/logvar/danmu-api/tags)。
2. **网络拉不动**。给 Docker 配镜像加速，或用代理手动 pull 一次：
   ```bash
   docker pull logvar/danmu-api:1.21.6
   ```
   拉成功后 `cd deploy/docker && docker compose up -d` 会命中本地缓存。
3. **不想用弹幕服务**。`cd deploy/docker && docker compose up -d web apiserver` 并把
   `MEOW_DANMAKU_API` 置空（§3.3），前端退回内置官方源。

### 9.4 `failed to set up container networking: network ... not found`

你之前执行了 `docker compose down <服务名>`。修法：

```bash
docker compose down
cd deploy/docker && docker compose up -d
```

以后停服务用 `stop`（§6.1）。

### 9.5 端口被占用

```
Error response from daemon: Ports are not available: ... bind: address already in use
```

改 `.env` 里对应的 `*_PORT`，或者先找出占用者：

```bash
# Windows
netstat -ano | findstr :30010
# Linux / macOS
ss -ltnp | grep 30010
```

不要按端口号猜"多余进程"直接 kill——可能是别的会话在测。只停自己启动的。

### 9.6 中文显示成乱码

两种完全不同的情况，别混：

1. **浏览器里乱码** → 响应缺 `charset`。本项目的 503 JSON 已显式带
   `Content-Type: application/json; charset=utf-8`（nginx 的 `charset` 指令只作用于
   `text/*`，JSON 必须自己声明）。
2. **只有终端里乱码** → Git Bash 按 GBK 渲染 UTF-8。用
   `curl -s ... | xxd | head` 看字节，或换 PowerShell。字节对就不是问题。

### 9.7 弹幕很慢 / 每次都要等几秒

`MEOW_DANMAKU_API` 指向了没启动的 danmu_api。两种情况：

- 不打算用弹幕聚合 → 置空（`MEOW_DANMAKU_API=`）
- 要用 → `cd deploy/docker && docker compose up -d danmu_api` 并等它 healthy

实测停掉 danmu_api 后每次搜索固定多等约 5.1 秒才降级。

### 9.8 前端连到了旧后端

`/api/health` 的 `version` 与预期不符。原因通常是本机还跑着旧的 9979 实例，
或浏览器 localStorage 里存了旧地址（`meow.api`）。
清理：设置页清空后端地址，或开发者工具删 `localStorage.meow.api`。

### 9.9 构建 web 镜像时 `pnpm install` 退出码 1

报错末尾只有一句 `process "/bin/sh -c corepack enable && pnpm install ..."
did not complete successfully: exit code: 1`，看不出原因。真实原因是：

```
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
Aborted removal of modules directory due to no TTY
```

容器里没有 TTY，pnpm 一旦判定要重建 `node_modules` 就直接中止。**已在
`deploy/docker/Dockerfile.web` 里加 `ENV CI=true` 修掉**（0.9.14 起）。老分支手工修法：
在 `pnpm install` 前加 `ENV CI=true`，或在 run 命令里带 `-e CI=true`。

> 不要在宿主机上直接 `docker run -v .../client:/b ... pnpm install` 复现——
> 容器会把 Linux 版可选依赖装进你本地的 `node_modules`，回到宿主后
> `vue-tsc` 报 `ERR_PACKAGE_PATH_NOT_EXPORTED: estree-walker`。
> 中了就 `rm -rf client/node_modules client/apps/*/node_modules` 再 `pnpm install`。

### 9.10 drpy 容器 idle 空转吃满 CPU（镜像缺 `worker.js`）

**症状**：`docker stats meow-drpy` 常驻 **376–382% CPU**（约 3.8 核），
但 `/health` 仍然是 `{"ok":true}`，站点也能用——所以只看健康检查发现不了。

**根因**：`server.js` 用 `new Worker(path.join(__dirname,'worker.js'))` 起线程池；
旧 `Dockerfile.drpy` 只 `COPY server.js host.js`，worker 每次报 `CANNOT FIND MODULE` →
线程 retire 再补位 → 无限重启空转。

**判据**：

```bash
docker exec meow-drpy ls -l /app/worker.js     # 不存在就是它
docker stats --no-stream meow-drpy            # CPU% 长期 370+
```

**修法**：`COPY server/drpy/server.js server/drpy/host.js server/drpy/worker.js ./`
（实测修后 idle **0.00%**）。已提交 `6b5e97c`，见
私有库待办 P0-3。

### 9.11 drpy 跨容器连不上（监听默认是 127.0.0.1）

`server.js` 默认绑回环。容器发布的 `30013→9330` 与 `apiserver → http://drpy:9330`
都跨网络命名空间，回环地址收不到。

**判据**：`docker exec meow-apiserver wget -qO- http://drpy:9330/health` 超时；
容器内 `ss -lntp` 显示 `127.0.0.1:9330` 而不是 `0.0.0.0:9330`。

**修法**：`ENV DRPY_BIND=0.0.0.0`（同一提交 `6b5e97c`）。
注意绑 `0.0.0.0` 后**不要**再把它暴露到公网——`/testjs` 能执行任意脚本。

### 9.12 `POST /testjs/search` 恒 403（未决）

`server.js` 的 `authorized()` 判据是：

- 设了 `DRPY_TOKEN`（或 `MEOW_AUTH_TOKEN`）→ 必须带 `X-DRPY-Token` 且值一致
- 没设 → 只允许**回环来源**

Java 侧从不发这个头，容器间调用又不是回环 → **必然 403**。

**判据**：

```bash
curl -s -X POST http://<host>:30013/testjs/search \
  -H 'Content-Type: application/json' -H 'X-DRPY-Api: <站点>' -d '{}'
# {"code":-1,"msg":"drpy: unauthorized"}
```

**⚠️ 方案未定，改前先拍板**：要么 Java 透传 token 且 drpy 侧同步注入
`DRPY_TOKEN`；要么把 `/testjs` 明确限定为本机进程。

---

## 十、安全边界（部署到公网前必读）

| 风险 | 现在的状态 | 建议 |
|---|---|---|
| **`/api/proxy/stream` 转发任意 URL** | 无鉴权 | **绝不要把 apiserver 暴露到公网**；内网也建议保持 `APISERVER_BIND=127.0.0.1` |
| apiserver 无任何鉴权 | 所有 `/api/*` 公开 | 需要公网访问时，前面套一层带 Basic Auth 的反向代理 + HTTPS |
| web 反代同源 | 无 CORS 问题 | 对外只暴露 `WEB_PORT`，让 nginx 做唯一入口 |
| danmu_api 自带 UI | 默认 token `87654321` | 用就改 `data/danmu/.env` 的 `TOKEN` |
| **CORS 来源** | 默认 `*`（不拦） | 公网暴露时设 `MEOW_CORS=none` 或列白名单，见 §10.1 |

`APISERVER_BIND` 默认 `127.0.0.1` 就是为这个：本机与容器网络可达，
局域网和公网都进不来。要开给 TV 时改 `0.0.0.0`，并确认你的局域网是可信的。

### 10.1 CORS 策略：默认不拦，按需收紧（2026-11-02）

`MEOW_CORS` 三档：

| 值 | 行为 | 用在 |
|---|---|---|
| `*`（默认/未设置） | 任意 Origin 都放行，回显该 Origin | 本机自用、局域网、**Tailscale/ZeroTier 组网**、frp/Cloudflare 反代 |
| `none` | 只放行 `localhost`/`127.0.0.1`/`[::1]`/`meow.local`/TV 内置页/`tauri://`/`Origin: null` | 公网暴露且不想维护白名单 |
| `a,b,c` | 只放行列出的 Origin（**完整**写法，含协议与端口） | 固定域名的公网部署 |

**为什么默认不拦**（踩过的坑，别改回去）：
旧实现用 `isPrivateHost()` **猜网段**放行（10/8、192.168/16、172.16/12…），
而 Tailscale 的 `100.x` 属于 CGNAT `100.64/10`、**不在 RFC1918 里** →
用 Tailscale 访问自建部署时，GET 拿不到 `Access-Control-Allow-Origin`，
写请求直接 `403 cross-origin write blocked`。用户症状是
「部署在服务器上的应用全被 cors 了，首页空白」—— 因为首页第一个请求
`/api/Douban/home` 就是 POST。

部署形态根本枚举不完（局域网 / Tailscale / ZeroTier / frp / CF Tunnel / 公网域名），
网络边界该由**部署者**声明，不该由代码猜。

**判据必须单一真源**：`originAllowed()`（写请求门禁）与 `corsAllowedOrigin()`
（下发响应头）共用同一套逻辑。历史上这两份是分开手抄的，必然漂移 ——
旧版写门禁**连 192.168 都没放行**，局域网分端口部署（前端 30010、API 30011）
时自家前端都改不了收藏。门禁测试：`tests/cors-origin.test.ts`。

**注意 CORS 不是访问控制**：它只防"浏览器里的第三方页面"。能直连端口的人
本来就能 `curl`。真正的入口控制是 `APISERVER_BIND` + 防火墙 +（可选）
`MEOW_AUTH_TOKEN`。

---

## 十一、与其他端的关系

```
        spider jar（同一份）
                │
   ┌────────────┼────────────┐
Docker 容器   PC sidecar   远端服务器
   │            │            │
   └────── HTTP /api ────────┘
                │
      Web 浏览器 / PC 客户端 / TV
```

- **PC**：设置页填 `http://<IP>:30011` 即可用容器后端；也可以自己起 sidecar，两者并存
- **TV**：`/config.json` 端点**已实现**（十项 + `spider;md5`，nginx 也反代了它），
  TV 首配页填 `http://<IP>:30010`（Web 地址）+ 可选的 `http://<IP>:30010/config.json` 即可
  （`docs/28` §3）
- **Docker 不替代 PC sidecar**：三种部署形态是并存的，不是替代关系

### 11.1 fnOS 原生包（fpk）：网关同源 + 应用内升级

> 非 Docker 形态。`client/apps/fnos/fpk` 打包，`meowd`（Rust）是壳，
> 内含同一份前端并直连同机 Java。**本节端点只在 meowd 上存在，Docker 上没有。**

**入口是 iframe**：`fpk/app/ui/config` 声明 `type:iframe` + `url:/app/meow` +
`gatewaySocket:meow.sock` + `gatewayPrefix:/app/meow`。飞牛网关把请求**带前缀**
转发到 unix socket。

**前缀必须由壳剥**：`build_gateway_router()` 用 `nest_service("/app/meow/")`
在**路由匹配阶段**剥掉（`/app/meow/api/*` → `/api/*`）。
★ **不要改成 `Router::layer`**——layer 在命中之后才执行，那时
`/app/meow/healthz` 已经落到 `ServeDir` 兜底并返回 `index.html`（踩过）。

**同源是升级的根基**：`/app-center/v1/*` 与页面同源，`credentials:'include'`
就能带 Cookie，不需要自己存 token。

**端口**：fpk 已无 `service_port`，30010 由 `wizard_port` 决定
（`cmd/main` 的 `PORT` 回退链 `wizard_port → MEOW_SHELL_PORT → TRIM_SERVICE_PORT → 30010`）。

**向导端口规则不能用 `min`/`max`**（2026-11-09 踩坑，装 1.1.5 时两个端口框恒红字）：
飞牛应用中心的向导表单是 async-validator，`type:"text"` 的值是**字符串**，`min`/`max`
被判成**字符串长度**而不是数值（源码 `range()` 里 `typeof value === 'string'` 时比较
`value.length`）。写 `{min:1024,max:65535}` 时 `"30010".length = 5 < 1024`，必然报
「端口范围 1024–65535」，`下一步` 被拦死、装不了。正确写法是 `required` + 纯数字
`pattern` + **范围正则**（当前 1024–65535 的正则见 `wizard/install`）。
`build-fpk.sh` 打包前会校验 wizard JSON 合法、且端口规则里不能再出现 `min`/`max`。

**升级端点**：

| 端点 | 作用 | 关键字段 / 约束 |
|---|---|---|
| `GET /api/_shell/info` | 当前 fpk 版本、架构、端口 | `version` / `arch` / `port` / `apiPort`。`arch` 由壳给，浏览器不猜 NAS 架构 |
| `GET /api/_shell/app/detail?app=meow` | 卷号回查 | `installVolumeID` / `installType` / `source`（`app-detail` 或 `env`） |
| `POST /api/_shell/upgrade/fpk` | 浏览器把安装包字节交给壳落盘 | `X-Meow-Filename` 头；返回 `{ok,path,size}`；上限 64MB，非 gzip 头直接 400 |

**为什么下载在浏览器**：meowd 的 `reqwest` 没开 TLS feature（体积优先），只能访问
http，而 GitHub 是 https。浏览器下载还顺带提供真实进度与 sha256 校验。

**为什么必须回查卷号**：`app/installed` 恒缺 `installVolumeID`/`installType`
（跨版本实测），拿 0 顶替会把第三方应用装到**系统分区**——宁可不升级也不能装错地方。

**索引与包的分工（★ 别混）**：

- 索引走 jsDelivr `@main`（小文件，purge 主域名即时生效）
- **包必须走 raw 固定 commit 直链**：jsDelivr 对 ~19MB 文件按**路径**死缓存，
  purge 只清主域名（CF/FY）；`@<sha>`、tag、换新文件名都绕不过（实测全部返回旧字节）

**真机耗时**（1.1.4→1.1.5，默认索引）：下载 ~2s · 停机 ~2.6s · 登记+安装 ~5.3s ·
重启 ~2s，合计 **10–12 秒**。界面只捕到 0% 与完成两态，中间态由日志证明。

**更新源与加速（2026-11-09 定稿，2026-11-11 双通道）**：

- 索引默认 `cdn.jsdelivr.net/gh/upchr/FnDepot@main/fnpack.json`；同时读取主仓镜像 `raw.githubusercontent.com/upchr/meow/fpk-updates/fpk.json`（FnDepot 不可用或没有更高版本时读镜像；分支在下一次 fpk 发版后出现）。设置页仍接受 `owner/repo` 仓库地址。
- 多候选顺序：`raw → gh-proxy.com → ghfast.top → ghproxy.net`；索引可追加 jsDelivr；**安装包 >20MB 时 jsDelivr 不可用**（1.1.5 是 19.6MB，1.1.7 已 21.7MB）。
- 全局「GitHub 加速」列表（设置 → 维护 → GitHub 加速）对所有公开 GitHub 地址生效，支持自定义增删改/排序/测试；私有 token 请求不走代理。
- 应用包不另建镜像仓；开源后主仓 public releases 即资产镜像，`packages.json` 发版时 force push 到 `updates` 分支做静态清单兜底（详见 [33 §10](33-插件系统.md)）。fpk 的主仓镜像在仓库公开后匿名可读；闭源期仍以 FnDepot 为准。
- `fpk-v*` 发版会把包挂到主仓 **prerelease** 并生成 `fpk-updates` 分支的 `fpk.json`；FnDepot 仍是飞牛第三方源正式通道。
- 设置 → 维护 →「更新中心」聚合壳 / 模块 / 插件 / fpk 的检查结果；fpk 行可跳转到本区块执行安装。

**验收**：见 docs/25 与 docs/28 的对应章节。

---

## 附：命令速查

```bash
# 构建 + 启动全部
cd deploy/docker && docker compose up -d --build

# 只起前端 / 只起后端
cd deploy/docker && docker compose up -d web
cd deploy/docker && docker compose up -d apiserver danmu_api

# 重建单个
docker compose build web && cd deploy/docker && docker compose up -d web

# 状态 / 日志
cd deploy/docker && docker compose ps
docker compose logs -f apiserver

# 验证
curl -s localhost:30010/healthz
curl -s localhost:30010/api/health
curl -s "localhost:30012/87654321/api/config"

# 停单个（不要用 down <服务名>）
docker compose stop web
docker compose start web
docker compose rm -sf web

# 整体拆除
docker compose down            # 保留 data/
docker compose down && rm -rf data/   # 连配置一起删

# 备份 / 恢复数据
tar czf meow-data-$(date +%F).tar.gz data/
tar xzf meow-data-2026-10-22.tar.gz
```

---

**相关文档**：[`33-插件系统.md`](33-插件系统.md)（插件系统）、
[`26-接口契约.md`](26-接口契约.md)（`/api/health` 字段语义）。
