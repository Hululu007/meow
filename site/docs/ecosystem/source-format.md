# 源包与配置格式

源包的核心是一个 `config.all.json`。这一页说明它的字段：哪些必填、哪些只在特定端生效、
写错了会怎样。规范源包以 CatVod **dex** 为主入口。

::: warning 只为排障与自制源包
这里描述的是 CatVod / TVBox / Fongmi 系的通用配置格式。项目不提供任何真实配置，
示例中的域名与令牌都是占位符。
:::

::: tip 只想快速起点源服务？不用自制源包
官方源服务镜像一条命令起（内置 41 站 + Jable），命令与坑位见
[导入源包 · 现成的源服务镜像](/guide/source-pack#现成的源服务镜像)。
本页「[源服务](#源服务-一个静态-nginx-目录)」一节则讲目录结构、字段规则与校验脚本。
:::

## 顶层结构

```json
{
  "spider": "https://example.com/spider-dex.jar;md5;<32位小写hex>",
  "sites": [],
  "parses": [],
  "lives": [],
  "rules": [],
  "ads": [],
  "proxy": [],
  "hosts": [],
  "doh": [],
  "headers": []
}
```

| 键 | 必需 | 作用 |
|---|---|---|
| `spider` | 视源而定 | 爬虫 **dex** jar 地址；格式 `url;md5;<hex>` |
| `spiderJvm` | 否 | 猫窝自定义：可选的 class jar，JVM 优先读它；Fongmi/TV 忽略 |
| `sites` | ✅ | 站点表 |
| `parses` | ✅ | 解析器表 |
| `lives` | | 直播表 |
| `rules` | | HLS 分片广告过滤 |
| `ads` | | 整域屏蔽 |
| `proxy` | | 强制走代理的 host |
| `hosts` | | DNS 改写 |
| `doh` | | DNS over HTTPS |
| `headers` | | 按 host 注入请求头 |

## `spider`

```
"spider": "https://example.com/spider-dex.jar;md5;d41d8cd98f00b204e9800998ecf8427e"
```

- 分号后是**该 jar 文件本身**的 MD5
- 已有同 MD5 缓存时复用，不重复下载
- 下载后 MD5 不匹配**拒绝加载**，不会用半截文件启动
- **规范要求 jar URL 必须带 `;md5;`**（或用版本化文件名）；不写会导致换 jar 后
  客户端继续用旧缓存

## `sites`

```json
{
  "key": "示例站",
  "name": "示例站",
  "type": 3,
  "api": "csp_Example",
  "ext": "com.example.app",
  "searchable": 1,
  "changeable": 1,
  "hide": 0,
  "indexs": 1,
  "timeout": 20
}
```

| 字段 | 说明 |
|---|---|
| `key` | **必须唯一**；同一个 jar 多个 ext 时要起不同 key（如 `Bili`、`Bili#2`） |
| `name` | 展示名 |
| `api` | `csp_XXX` 走 jar；以 `.js` 结尾走 drpy；CMS 接口走直连 |
| `type` | CatVod 约定；`1` 表示 CMS 直连，`3` 表示 jar |
| `ext` | 传给 spider 的扩展参数，单 key 站点也建议写上 |
| `searchable` | 是否参与聚合搜索 |
| `hide` | 是否在列表隐藏 |
| `jar` | 可选：站点级 **dex** jar 地址；省略时由顶层 `spider` 提供 |

::: tip 站点 jar 可以省略
TV/Fongmi 在站点没有 `jar` 时会回退到顶层 `spider`；JVM 则优先 `spiderJvm`，
没有就用 `spider` 走 dex2jvm。只有某站确实需要另一个 dex jar 时才写站点级 `jar`。
:::

## `parses`

```json
[
  { "name": "Json聚合", "type": 3, "url": "Demo" },
  { "name": "Web聚合", "type": 3, "url": "Web" },
  { "name": "示例解析", "type": 1, "url": "https://example.com/parse?url=",
    "ext": { "flag": ["qq", "qiyi", "youku"] } }
]
```

| `type` | 行为 | 后端可行性 |
|---|---|---|
| `0` | WebView 嗅探 | ❌ 需要 Android WebView，Web/PC 后端不支持 |
| `1` | `GET parseUrl + target` | ✅ |
| `2` | jar 的 `Json<Key>.parse` | 需要 jar 里有对应类 |
| `3` | jar 的 `Mix<Key>.parse` | 同上 |
| `4` | 超级解析（并发） | ✅ |

`ext.flag` 限定该解析器只对哪些线路标识生效，**必须原样透传**，否则会用错解析器。

## `lives`

```json
[
  {
    "name": "示例直播",
    "type": 0,
    "url": "https://example.com/live.m3u",
    "epg": "https://example.com/epg.xml.gz",
    "ua": "okhttp/3.8.1",
    "timeout": 10,
    "playerType": 2
  }
]
```

- `type: 0`：纯 M3U / TXT
- `type: 3`：走 spider（jar 里要有 `Live` 类）
- `epg` 可选；当前客户端只用它做节目单展示

## `rules`：HLS 分片广告过滤

```json
[
  {
    "name": "示例规则",
    "hosts": ["lz", "ffzy"],
    "regex": ["#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6.666667,[\\s\\S]*?#EXT-X-DISCONTINUITY"]
  }
]
```

语义：播放的 m3u8 host **包含** `hosts` 任一项时，用 `regex` 从清单里删掉匹配片段。

::: warning `hosts` 是子串匹配
`"lz"` 会匹配 `hd.lz.example.com`。写得太短会误伤正常分片。
:::

另有一层 `ads` 是整域拒绝（`["static-ad.example.com"]`），与 `rules` 语义不同，
不要混用。

## `proxy`：强制代理

```json
["raw.githubusercontent.com", "googlevideo.com", ".*nivod.*"]
```

命中的请求强制走客户端代理：TV 端由 Fongmi 自己代理，Web / PC 由后端代理。
**两端读同一份表**，行为才一致。支持正则（如 `.*nivod.*`）。

## `hosts`：DNS 改写

```json
[
  "hls.example.com=hls.example.com.cdn.example.net",
  "cdn9.example.xyz=gcore.jsdelivr.net"
]
```

格式 `<原域名>=<替换域名>`。注意这是**域名改写不是代理**：请求仍直连，只换解析结果。
常用于限区域源与绕开不可达域名。

## `doh`：DNS over HTTPS

```json
[{ "name": "Google", "url": "https://dns.google/dns-query", "ips": ["8.8.4.4", "8.8.8.8"] }]
```

`ips` 是 DoH 服务的**引导 IP**，避免「解析 DoH 域名本身又要 DNS」的循环。

## `headers`：按 host 注入请求头

```json
[{ "host": "hls.example.com", "header": { "User-Agent": "okHttp/Mod-1.5.0.0" } }]
```

某些源校验特定 UA 或 Referer，在这里补。

## 多仓索引

```json
{ "urls": ["https://example.com/site-a/config.json", "https://example.com/site-b/config.json"] }
```

导入时逐个探测，可用仓库合并成一份站点表。失效仓会被跳过，不阻断其他仓。

## 苹果CMS 直连

站点写成：

```json
{ "key": "示例CMS", "name": "示例CMS", "type": 1, "api": "https://example.com/api.php/provide/vod" }
```

后端按 CMS 协议直接拉 `ac=list` / `ac=detail`，不需要 jar。

两个实测坑：

- `ac=detail` 返回里通常**没有** `vod_play_url` 数组那种结构，播放信息要看具体站实现
- 多数站**静默忽略** `type_id`：请求分类后要校验返回条目的 `type_id` 是否等于请求值，
  不认就只提供「最新更新」

## 源服务：一个静态 nginx 目录

源服务不解析配置，也不改 jar，只做两件事：**按原样提供 JSON，按原样提供 jar**。

```text
sources/
├── config.all.json       # 唯一入口
├── source-pack.json      # 产物清单 / hash / profile
├── spider-dex.jar        # 主爬虫（dex）
├── spider.jar            # 主爬虫 class 版（旧 JVM 兼容，可选）
├── spider-ext-dex.jar    # 站点级扩展爬虫（dex，可选）
├── spider-ext.jar        # 站点级扩展 class 版（旧 JVM 兼容，可选）
├── config.jvm.json       # 旧 JVM 兼容 profile（可选）
├── config.tv.json        # 旧 TV 兼容 profile（可选）
└── SHA256SUMS.txt
```

### 目录/字段规则

| 规则 | 要求 |
|---|---|
| 唯一入口 | `config.all.json` |
| 顶层 `spider` | 绝对 `http(s)` URL，必须是 **dex** jar，带 `;md5;` |
| 站点级 `jar` | 可选；省略用顶层；写了必须是 **dex** |
| `spiderJvm` | 可选 class jar，仅 JVM 优化/旧版兼容；Fongmi/TV 忽略 |
| 地址 | 禁止 `file:`、相对路径、`127.0.0.1`、`localhost` |
| 缓存 | 配置 `Cache-Control: no-cache`；jar URL 带 md5/版本号 |
| 编码 | UTF-8，无 BOM |
| 扩展爬虫 | 独立站点用站点级 `jar`；不要假设它会自动合并进主 jar |

### `api` 与 `jar` 的关系

```text
站点有 jar → 用站点 jar 找 api 对应的类
站点无 jar → 用顶层 spider 主 jar 找
```

`api: "csp_AppRJ"` 映射到 `com.github.catvod.spider.AppRJ`。  
`key` / `name` 只用于展示和唯一标识，**不参与选类**。

### `source-pack.json`

机器可读清单，源服务健康检查和校验脚本依赖它：

```json
{
  "schema": "meow-source-pack/1",
  "entry": "config.all.json",
  "primaryRuntime": "dex",
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

### 源服务镜像

官方镜像（多架构 amd64/arm64，内置 **主爬虫 + Jable 扩展 + 41 站默认源**）：

```bash
docker pull chrplus/meow-sources:1.2.0

docker run -d --name meow-sources \
  -p 18080:8080 \
  -e MEOW_SOURCES_BASE=http://<HOST>:18080 \
  chrplus/meow-sources:1.2.0
```

- `MEOW_SOURCES_BASE` 用来把内置 `config.all.json` 里的 `__SOURCE_BASE__`
  替换成客户端能访问的地址；TV/Fongmi 不能填 `127.0.0.1`。
- 镜像默认源已包含 41 站和 Jable；不挂载即可导入。
- 用自己的完整源包时，把目录挂到 `/mounted-sources`（含 `config.all.json` 时
  整目录覆盖默认源）：

```bash
docker run -d --name meow-sources \
  -p 18080:8080 \
  -e MEOW_SOURCES_BASE=http://<HOST>:18080 \
  -v /path/to/sources:/mounted-sources:ro \
  chrplus/meow-sources:1.2.0
```

compose 分工：

- `docker-compose.yml` / `docker-compose.build.yml`：主栈，**不含 sources**
- `docker-compose.with-sources.yml`：主栈 + sources，一键启动
- `docker-compose.sources.yml`：只启动源服务

```bash
cd deploy/docker

# 主栈 + 源服务
docker compose -f docker-compose.with-sources.yml up -d

# 只启动源服务
docker compose -f docker-compose.sources.yml up -d
```

私仓版保留 `Dockerfile.sources` / `nginx.sources.conf` / `entrypoint.sh` /
`default-sources`，用于构建并推送这个镜像：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f Dockerfile.sources -t chrplus/meow-sources:1.2.0 --push .
```

### 校验与更新

```bash
python3 deploy/source-pack/validate.py --dir /path/to/sources \
  --base-url http://<HOST>:18080
```

更新 jar 时：

1. 替换文件；
2. 重算 md5，更新 `config.all.json` 的 `spider`（及站点级 `jar`）；
3. 更新 `source-pack.json` / `SHA256SUMS.txt`；
4. 跑校验脚本和 `curl` 回验。

只换挂载源包文件不需要重启 nginx；改镜像内置源/nginx 规则要改私仓
`default-sources` / `nginx.sources.conf` 后重新构建推送镜像。

### Fongmi 兼容提示

- `spiderJvm` 是未知字段，Fongmi 忽略，不影响 dex 导入。
- 猫窝 `proxy` 是字符串数组；Fongmi 期望对象数组，会忽略；给第三方用时可以删掉。
- `parses` 里的 `Demo` / `Web` 是猫窝内置名；给 Fongmi 用时改成标准解析 URL。
- 站点级 `jar` 必须是 dex；class-only 站点 jar 在 Fongmi/TV 上无法加载。

## 排障顺序

配置导入后不生效时，按这个顺序查：

1. JSON 本身是否合法（多余的逗号、注释、BOM）
2. `sites[].key` 是否重复
3. `api` 前缀与形态是否匹配（`csp_` / `.js` / CMS URL）
4. `spider` 的 MD5 是否与文件一致
5. 站点级 `jar` 是不是误用了 class（TV/Fongmi 只认 dex）、有没有漏
6. 地址是否是 `127.0.0.1`（在电视/容器里指设备自己）

更细的字段语义与 Fongmi 消费路径见开发文档 [TV 接入与 Fongmi](/dev/tv-integration)。
