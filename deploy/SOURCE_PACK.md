# 源包服务部署与维护（OECT / NAS / 任意 Linux）

> **规范版本：`meow-source-pack/1`**
>
> 目标：源包以 **CatVod dex 为主**，一份 `config.all.json` 同时服务
> Fongmi/TVBox、猫窝 TV 和猫窝 JVM。猫窝 JVM 不要求单独的 class 源包：
> 它在导入时用 `Dex2Jvm` 把 dex 转成 class 并缓存；`spiderJvm` 只是可选的
> JVM 优化/旧版兼容字段。
>
> 规则与校验脚本在 [`deploy/source-pack/`](source-pack/README.md)，本文只讲部署。

## 一、目录与唯一入口

```text
sources/
├── config.all.json       # 唯一入口（Fongmi / 猫窝 TV / 猫窝 JVM 都填它）
├── source-pack.json      # 机器可读清单：entry / artifacts / hash / profiles
├── spider-dex.jar        # 主产物：ZIP 内 classes.dex
├── spider.jar            # 可选：class 形态，仅旧 JVM / config.jvm.json
├── config.jvm.json       # 可选：旧 JVM 兼容 profile（deprecated）
├── config.tv.json        # 可选：显式 TV 兼容 profile（deprecated）
└── SHA256SUMS.txt
```

**新部署只需要 `config.all.json + source-pack.json + spider-dex.jar`。**

`config.jvm.json` / `config.tv.json` 是兼容产物，不再手工维护。`config.all` 已实测
可被猫窝 TV 直接导入（站点不写 `jar`，回退顶层 `spider`），所以不需要为了 TV
再生成一份逐站 `jar` 的配置。

## 二、硬规则

| 规则 | 要求 |
|---|---|
| 顶层 `spider` | 必须是绝对 `http(s)` URL，指向 **dex** jar（ZIP 内 `classes.dex`） |
| 站点 `jar` | 可选；省略时用顶层 `spider`；写了就必须是 dex |
| `spiderJvm` | 可选；class jar，仅 JVM 优化/旧版兼容；Fongmi/TV 会忽略 |
| jar URL | 必须带 `;md5;<32位小写hex>`，或使用版本化文件名；推荐 md5 |
| 地址 | 绝对 URL；禁止 `file:`、相对路径、`127.0.0.1`、`localhost` |
| 更新 | 换 jar 必须同时换 md5（或文件名），否则客户端会继续用旧缓存 |
| 编码 | UTF-8，无 BOM |
| 缓存 | `config.all.json` 用 `Cache-Control: no-cache`；jar 用 md5/版本号破缓存 |

### 三端怎么读

| 端 | 读取 | 加载 |
|---|---|---|
| Fongmi / TVBox | `spider` + 可选站点 `jar` | Android `DexClassLoader` |
| 猫窝 TV | 同上；站点无 `jar` 时回退顶层 `spider` | `DexClassLoader`，不转换 |
| 猫窝 JVM | 优先 `spiderJvm`；没有则 `spider` | `URLClassLoader`；dex 由 `Dex2Jvm` 导入期转换 |

因此 **`spiderJvm` 不是必需产物**。推荐 `config.all.json` 不写它，让 JVM 走统一
的 dex2jvm 链路；只有在明确要优化 JVM 冷导入时才加。

## 三、OECT 上的独立服务

源文件放在 `/vol2/1000/meow-sources`，端口 `18080`。当前用 Docker：

```bash
cd /vol2/1000/docker-data/meow

# .env 至少要有：
#   MEOW_SOURCES_DIR=/vol2/1000/meow-sources
#   （可选）MEOW_SOURCES_PORT=18080

# 开源版：只保留这个 compose，使用官方 nginx + 内联配置，直接启动
docker compose -f docker-compose.sources.yml up -d

# 私仓版：保留 Dockerfile.sources / nginx.sources.conf，可构建自定义镜像
# docker compose -f docker-compose.sources.yml up -d --build
```

文件归属：

| 文件 | 开源版 | 私仓版 |
|---|---|---|
| `docker-compose.sources.yml` | ✅ 唯一保留文件，官方 nginx + 内联配置 | ✅ 可为 build 版本 |
| `Dockerfile.sources` | ❌ gitignore | ✅ 构建资源 |
| `nginx.sources.conf` | ❌ gitignore | ✅ 构建资源 |
| `.dockerignore` | ❌ gitignore | ✅ 构建资源 |

官方镜像（多架构 amd64/arm64，只含 nginx 配置，不含任何源包）：

```bash
docker pull chrplus/meow-sources:1.1.0
docker run -d --name meow-sources \
  -p 18080:8080 \
  -v /vol2/1000/meow-sources:/usr/share/nginx/html:ro \
  chrplus/meow-sources:1.1.0
```

要点：

- **不要把源包 COPY 进镜像**：nginx 配置与 jar/config 分离，源包通过
  `MEOW_SOURCES_DIR` 只读挂载；公开镜像不含第三方内容。
- 健康检查同时要求 `source-pack.json` 和 `config.all.json` 可读；只有旧
  `config.all.json`、没有规范清单的目录会被判未规范化。
- 找不到文件必须 404，不能回落 `index.html`（否则客户端把 HTML 当 JSON/jar）。
- 开源版改 nginx 规则要改 compose 里的 `configs.content`；私仓版改
  `nginx.sources.conf` 后 `up -d --build`。
- 只换源包文件不需要重启 nginx。
- 源包服务与主栈 `meow` 完全独立；重建 `meow-web` 不影响它。

systemd 仅作无 Docker 环境备用，启动 `python3 -m http.server 18080` 即可；生产推荐
上面的 nginx 容器。

## 四、生成/更新源包

### 1. 取 dex jar

CatVod 生态的主产物是 dex jar。若手里只有 class jar，用 Android build-tools 的
`d8` 生成：

```bash
mkdir -p dexout
d8 --min-api 21 --output dexout spider.jar
(cd dexout && jar cf ../spider-dex.jar classes.dex)
```

### 2. 生成 `config.all.json`

以现有 CatVod 配置为底，只保留一个顶层 spider：

```json
{
  "spider": "http://<HOST>:18080/spider-dex.jar;md5;<spider-dex.jar 的 md5>",
  "sites": [
    { "key": "示例", "name": "示例", "type": 3, "api": "csp_Example" }
  ]
}
```

- 站点不写 `jar`，由顶层统一提供。
- 只有站点确实需要**另一个 dex jar** 时才写站点级 `jar`，同样带 md5。
- 不要写 `spiderJvm`（除非明确要 JVM 优化）。
- 删掉 `127.0.0.1` 的弹幕/解析模板；远端客户端用不了。

### 3. 生成清单与哈希

```bash
md5sum sources/spider-dex.jar
sha256sum sources/config.all.json sources/spider-dex.jar > sources/SHA256SUMS.txt
```

`source-pack.json` 模板：

```json
{
  "schema": "meow-source-pack/1",
  "entry": "config.all.json",
  "primaryRuntime": "dex",
  "generatedAt": "2026-11-11T06:00:00Z",
  "profiles": {
    "all": { "config": "config.all.json", "runtimes": ["fongmi", "android", "jvm"] }
  },
  "artifacts": [
    {
      "name": "spider-dex.jar",
      "role": "dex-spider",
      "bytes": 820924,
      "md5": "<md5>",
      "sha256": "<sha256>"
    }
  ]
}
```

### 4. 校验

```bash
python3 deploy/source-pack/validate.py \
  --dir /vol2/1000/meow-sources \
  --base-url http://192.168.1.20:18080
```

校验会检查：

- `source-pack.json` schema/entry/artifact hash；
- `config.all.json` 的 `spider`、站点 `jar` 是否绝对 URL、是否 dex；
- `;md5;` 是否存在且与本地文件一致；
- `spiderJvm`（如果存在）是否 class jar；
- `SHA256SUMS.txt`；
- Fongmi 兼容性 warning。

退出码非 0 即不通过。

## 五、客户端怎么用

| 客户端 | 填写的配置地址 |
|---|---|
| **Fongmi / TVBox** | `http://<HOST>:18080/config.all.json` |
| **猫窝 TV（本机执行）** | `http://<HOST>:18080/config.all.json` |
| **PC / Web / Docker / 自建 JVM** | `http://<HOST>:18080/config.all.json` |
| 旧版猫窝 JVM（不认 dex2jvm） | `http://<HOST>:18080/config.jvm.json`（class 兼容 profile） |

Fongmi 导入 `config.all.json` 后会下载顶层 dex jar；猫窝 JVM 导入同一地址，
若没有 `spiderJvm` 就调用 dex2jvm 转成 class 并使用本地缓存。

## 六、Fongmi 兼容性

- `spider`、`sites`（`key/name/api/type/ext/jar/searchable`）、`lives`、`parses`、
  `headers`、`hosts`、`ads`、`rules`、`doh`、`wallpaper`、`logo` 按 CatVod 标准。
- `spiderJvm` 是未知字段，Fongmi 忽略；不会影响 dex 导入。
- 猫窝自定义 `proxy` 是字符串数组，Fongmi 期望对象数组，会忽略；给第三方用时
  可以删掉。
- `parses` 里的 `Demo`/`Web` 是猫窝内置名，Fongmi 不认识；给第三方用时删掉或
  改成标准解析 URL。
- 站点级 `jar` 必须是 dex；class-only 站点 jar 在 Fongmi/TV 上无法加载。

## 七、更新与排障

```bash
# 换 dex jar 后
md5sum sources/spider-dex.jar
# 更新 config.all.json 的 spider 里的 md5（站点级 jar 同理）
python3 deploy/source-pack/validate.py --dir sources --base-url http://<HOST>:18080
curl -fsS http://<HOST>:18080/source-pack.json
curl -fsS http://<HOST>:18080/config.all.json
```

| 现象 | 原因 |
|---|---|
| Fongmi 导入后没站点 | `spider` 不是 dex / 地址不可达 / 站点无 api |
| 改了 jar 但客户端还用旧版 | jar URL 没换 md5 或版本文件名 |
| 猫窝 TV 跳过所有 `csp_` 站 | 站点既无 `jar` 也无顶层 `spider` |
| 猫窝 JVM 报 `NoClassDefFoundError` | 旧配置里 `spider` 指向 class jar，且无 `spiderJvm`；重新导入 dex 配置 |
| 含 native `.so` 的 jar 在 JVM 不可用 | dex2jvm 跳过 native jar；这是已知边界 |
| 源服务 200 但内容像 HTML | nginx 配了 SPA fallback；必须 `try_files $uri =404` |

## 八、兼容 profile（不推荐新部署）

- `config.jvm.json`：顶层 `spider` 指向 class jar，供不认 dex2jvm 的旧 JVM。
- `config.tv.json`：顶层 dex + 每个 `csp_` 站点显式 `jar`，供旧 TV/第三方工具。
- 两者由 `config.all.json` 派生，不要手工改；新客户端统一用 `config.all.json`。
