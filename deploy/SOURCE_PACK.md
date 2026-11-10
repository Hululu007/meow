# 源包服务部署与维护（OECT / NAS / 任意 Linux）

> 目标：把 **源清单（config）+ class/dex jar** 做成一个常驻 HTTP 入口，
> 让空壳客户端直接填地址导入，不再依赖开发机上的临时 `python -m http.server`。
>
> 这是**独立服务**，不修改现有 Meow Docker compose / 容器。

## 一、产物

```text
sources/
├── config.all.json     # 统一入口：顶层 class jar + 每个 csp_ 站点 dex jar
├── config.jvm.json     # 仅 JVM / PC / Docker：顶层 spider 指向 class jar
├── config.tv.json      # 仅 TV：顶层 spider + 每个 csp_ 站点 jar 指向 dex jar
├── spider.jar          # class 形态（JVM）
├── spider-dex.jar      # dex 形态（ZIP 内 classes.dex，TV）
└── SHA256SUMS.txt
```

- class 与 dex **不能混用**：JVM 读不了 dex，Android 读不了纯 class。
- **`config.all.json` 是唯一可统一给三端的 URL**：顶层 `spider` 指向 class jar（JVM 用），
  每个 `csp_` 站点 `jar` 指向 dex jar（TV 用）。JVM 会顺带下载 dex（约 0.8MB），
  但类查找先命中 class jar，不影响功能。
- `config.tv.json` 里所有 `api` 以 `csp_` 开头的站点都要带 `jar`，否则 TV 会跳过该站。
- 配置里的 `spider` / `jar` 必须是**客户端能访问到的绝对地址**（不要写 `127.0.0.1`，除非客户端就在同一台机器）。

## 二、OECT 上的独立服务（systemd + Python）

以 OECT 为例，源文件放在 `/vol2/1000/meow-sources`，端口 `18080`。

`/etc/systemd/system/meow-sources.service`：

```ini
[Unit]
Description=Meow source pack static server (port 18080)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
WorkingDirectory=/vol2/1000/meow-sources
ExecStart=/usr/bin/python3 -m http.server 18080 --bind 0.0.0.0 --directory /vol2/1000/meow-sources
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

启用：

```bash
systemctl daemon-reload
systemctl enable --now meow-sources
systemctl status meow-sources --no-pager
```

验证：

```bash
curl -I http://<OECT_HOST>:18080/config.jvm.json
curl -I http://<OECT_HOST>:18080/spider.jar
curl -I http://<OECT_HOST>:18080/spider-dex.jar
```

> 端口按环境改；不要与现有 30010–30013 冲突。
> 源包目录只读挂给服务即可；OECT 上 `User=admin` 需能读这些文件。

## 三、首次生成

### 1. 取 class jar

JVM 容器内置的 jar：

```bash
docker cp meow-apiserver:/app/libs/spider.jar ./spider.jar
```

私有全量构建也可以直接从 `server/host/libs/spider.jar` 取。

### 2. 生成 dex jar（TV）

需要 Android build-tools 的 `d8`：

```bash
mkdir -p dexout
d8 --min-api 21 --output dexout spider.jar
(cd dexout && jar cf ../spider-dex.jar classes.dex)
```

### 3. 生成两份 config

以现有 `config.sites.json` 为底：

- `config.all.json`：`spider = http://<HOST>:18080/spider.jar`，并给每个
  `csp_` 站点加 `"jar": "http://<HOST>:18080/spider-dex.jar"`；删除 `danmaku` 的
  `127.0.0.1` 模板。
- `config.jvm.json`：`spider = http://<HOST>:18080/spider.jar`；删除 `danmaku` 里的
  `127.0.0.1` 模板（远端客户端用不了）。
- `config.tv.json`：`spider = http://<HOST>:18080/spider-dex.jar`，并给每个
  `api` 以 `csp_` 开头的站点加 `"jar": "http://<HOST>:18080/spider-dex.jar"`；同样删除
  `danmaku` 的 `127.0.0.1` 模板。

### 4. 校验清单

```bash
sha256sum config.jvm.json config.tv.json spider.jar spider-dex.jar > SHA256SUMS.txt
```

## 四、客户端怎么用

| 客户端 | 填写的配置地址 |
|---|---|
| **PC / Web / Docker / TV 统一** | `http://<HOST>:18080/config.all.json` |
| 仅 PC / Web / Docker / 自建 JVM 后端 | `http://<HOST>:18080/config.jvm.json` |
| 仅 TV 本机执行（dex） | `http://<HOST>:18080/config.tv.json` |

统一入口会多下载一份 dex（约 0.8MB）；要最小下载就按端分开。

### CatVod / Fongmi 兼容性

- **核心字段符合** CatVod/Fongmi 结构：`spider`、`sites`（`key/name/api/type/ext/jar/searchable`）、
  `lives`、`parses`、`headers`、`hosts`、`ads`、`rules`、`doh`、`wallpaper`、`logo`。
- **`config.all.json` 只给猫窝自己的 PC/Docker/TV**：顶层 `spider` 是 class jar，
  Fongmi/TVBox 等 Android 客户端会直接拿它做 `DexClassLoader`，没有 `classes.dex` 会加载失败，
  还没轮到站点级 dex jar。
- 第三方 Android/CatVod 客户端请用 `config.tv.json`（顶层就是 dex jar）；
  JVM 类 CatVod 客户端请用 `config.jvm.json`（顶层是 class jar）。
- 我们的 `proxy` 是字符串数组（猫窝自定义），Fongmi 的 `proxy` 期望
  `{name,hosts,urls}` 对象数组，会被忽略；`parses` 里的 `Demo`/`Web` 也是猫窝内置名，
  不是标准解析 URL。要给第三方客户端用，建议删掉/改写这两项。

- 老数据迁移：导入时勾选「用这份配置的顶层 spider 覆盖本地」/ 请求里带 `replaceSpider=true`，
  否则旧的失效 `spider` 会保留，jar 站仍 `ClassNotFoundException`。
- TV 只导入 `api` 以 `csp_` 开头且带 `jar` 的站点。

## 五、更新维护

OECT / 服务端升级或换 jar 后：

```bash
# 1) 取新 class jar
docker cp meow-apiserver:/app/libs/spider.jar ./spider-new.jar

# 2) 重建 dex
rm -rf dexout && mkdir dexout
d8 --min-api 21 --output dexout spider-new.jar
(cd dexout && jar cf ../spider-dex.jar classes.dex)

# 3) 更新源目录
cp spider-new.jar sources/spider.jar
cp spider-dex.jar sources/spider-dex.jar
cd sources
sha256sum config.jvm.json config.tv.json spider.jar spider-dex.jar > SHA256SUMS.txt

# 4) 重启服务（Python 静态服务无需重启也能读到新文件；重启用于确认健康）
systemctl restart meow-sources
```

注意：

- `config.*.json` 里的 `spider` / `jar` 地址不随文件名变化，换 jar 不需要改配置；
  只有换主机/端口才改。
- OECT 上 `meow-web` 容器重建**不影响**这个独立服务。
- 不要把源包放回 `meow-web` 的 web 根目录；两者解耦。
- 源包入口会暴露真实站点清单与 jar；OECT 若映射公网，需自行加访问控制。
