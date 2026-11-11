# TV 端接入与 Fongmi 手册

> **2026-11-09 纯壳剥离**：公开壳的 `/config.json` 与 `/spider-latest.jar` 只有在
> 私有全量构建或导入源包后才带真实站点与 dex jar；仓库不内置。
>
> **2026-11-11 源包规范**：统一入口 `config.all.json`，顶层 `spider` 是 dex。
> 站点级 `jar` 可选；没有时 TV 回退顶层 `spider`（已实测），不再要求每个
> `csp_` 站重复写 jar。规则见 [`deploy/source-pack/`](https://github.com/upchr/meow/blob/main/deploy/source-pack/README.md)。

> 版本：v1（2026-10-21）
> 定位：**TV 端接入的唯一施工依据**。
> 核心结论：**TV 端零代码改造**，只需我们输出正确的 `/config.json`。
> 配套：`docs/26`（API 契约）、`docs/25`（架构）。源码参照：（私有开发资料）。

---

## 自研 TV 壳（client/apps/tv）

除了用 Fongmi 官方包指向我们的 `/config.json`，仓库里还有一个**自己的 TV 应用**：

- 形态：Android WebView 壳，加载自研 Web 前端 → **UI 与 Web 同源即对齐**
- 遥控：注入 `tv-nav.js`，方向键做几何最近邻选焦、确认键点击（WebView 默认只认 Tab）
- 产物：`app-release.apk` 约 **11.2MB**（内嵌前端产物 + ExoPlayer/OkHttp/Gson）；`minSdk 26`
- 设置页：内置 `SetupActivity`（局域网扫描 / 扫码推送 / 连接校验 / 远程调试）
- 实测：`meow_tv`（android-35 模拟器）首页渲染、焦点移动、tab 点击全部通过；**播放也验过**：debug 构建开启 WebView 远程调试后，经 CDP 驱动到 `AppGet/南洋秘术2`，`readyState=4`、`duration=228.2s`、`play()` 后 `currentTime=2.8s`
- 换后端：`adb shell am start -n com.meow.tv/.MainActivity --es url http://192.168.1.2:30010`

两种 TV 路线并存：要"生态源全覆盖"用 Fongmi（吃 `/config.json` + jar）；
要"界面和网页版一致"用我们的壳（吃 Web 地址）。详见 `client/apps/tv/README.md`。

## 第零章 一句话说清 TV 端要做什么

**我们已经做的**：后端输出 `/config.json`（CatVod 十项）+ `GET /spider-latest.jar`
托管（带 `;md5;` 与 ETag/304）。实测十项齐全，见 §1.3。

**现在两条路并存**（2026-10-23 用户定）：

| | 用谁 | 我们做什么 |
|---|---|---|
| **兼容上游** | 官方 Fongmi / TVBox / 影视仓 | 只维护 `/config.json` + jar，**不 fork 官方 Fongmi** |
| **我们自己的发行版** | `motao123-webtv` 二开（GPL-3.0） | 改样式/交互；**仍吃同一份 `/config.json`**，不另造私有协议 |

> 也就是说：**不 fork Fongmi 官方**这条没变（它是我们配置的消费者，保持兼容即得分发渠道）；
> ~~改的是"我们不做自己的 TV 壳"这条——现在要基于 `motao123-webtv` 做~~（2026-11-04 核对：已改为 `client/apps/tv` 自研壳，见 §1；§7.3 的二开路线废弃）。

```
我们后端 ──/config.json（十项 + spider;md5）──> Fongmi / webtv / TVBox
          ──/spider-latest.jar（ETag/304）──┘
                                                   │
                                    ┌──────────────┴──────────────┐
                                    │ 客户端自己：                 │
                                    │  DexClassLoader 加载 jar     │
                                    │  ParseJob 处理 parse=1       │
                                    │  四路运行时（含 drpy）        │
                                    │  proxy 四级路由              │
                                    └──────────────────────────────┘
```

**客户端是完整的宿主**，它不需要我们帮它跑 spider。
我们只要给它"配置 + jar"两样东西。

---

## 第一章 现状与目标

### 1.1 现状（2026-10-23 实测：出口 A 已落地）

| 项 | 现状 | 实测证据 |
|---|---|---|
| **`GET /config.json`** | ✅ **已实现**，输出 CatVod 十项 | `curl` 200 / 11557 B；`sites 40 / parses 4 / lives 1 / rules 14 / ads 1 / proxy 17 / hosts 5 / doh 5 / headers 1`，与 `config.sites.json` 逐项一致 |
| **`spider` 字段**（私有全量构建） | ✅ `{base}/spider-latest.jar;md5;{真实md5}` | md5 与构建时的 dex jar 一致；公开壳不内置 dex jar 时该端点不可用 |
| **`GET /spider-latest.jar`** | ✅ 流式托管 + ETag + Last-Modified + Cache-Control（需注入 dex jar） | 200 / 1728688 B / `application/java-archive`；`If-None-Match` 命中返回 **304** |
| `/api/config` | 保留不动（给自家前端的能力协商，形状不同） | 实测仍只输出 `{sites:[...]}` |
| ~~TV 配置托管~~ | 不再需要 `serve_tv.py` | 后端直接提供 |

**兼容性**：Fongmi 的 `VodConfig.checkJson` 用 `Json.safeString` / `fetchArray` /
`initWall` 读所有字段，**缺失一律返回空而不是报错**，所以少 `wallpaper`/`logo`/
`danmaku`/`notice` 不影响加载。

**容器部署**：私有全量构建的 `Dockerfile.apiserver` 内置真实 `config.sites.json`
并在 entrypoint 首次启动时播种到 `/data`；**公开壳**只带 `config.sites.example.json`
（44 个静态站），真实站点由源包导入。

> ⚠️ 端口约束见 `docs/36` §0.6：jar 内 `Proxy.a()` 只扫 9978–9999，端口越界会让
> Bili/Hxq 的地址退化成 `127.0.0.1:-1`。容器内固定 9979，天然安全。

### 1.2 目标

| 端点 | 内容 |
|---|---|
| `GET /config.json` | CatVod 完整九项，`spider` 指向我们的 jar |
| `GET /config-upstream.json` | 同结构，`spider` 指上游（后备） |
| `GET /depot.json` | 多仓列表 |
| `GET /spider-latest.jar` | jar 本体（带 ETag / Last-Modified） |

---

## 第二章 `spider` 字段：最容易错的一处

### 2.1 格式

```
"spider": "<jar-url>;md5;<md5-of-that-exact-file>"
```

### 2.2 MD5 语义（硬约束）

Fongmi 的校验逻辑（`catvod/.../Crypto.java:55`）：

```java
public static boolean equals(File file, String expected) {
    return expected != null && !expected.isEmpty()
        && expected.equalsIgnoreCase(md5(file));
}
```

调用方（`JarLoader.parseJar`）：

```java
if (!md5.isEmpty() && Crypto.equals(Path.jar(jar), md5)) load(key, Path.jar(jar));
else if (jar.startsWith("http")) load(key, Download.create(jar, Path.jar(jar)).get());
```

**行为解读**：
- MD5 **一致** → 用本地缓存，不下载
- MD5 **不一致** → **重新下载**（不报错，但白下载一次）
- MD5 **为空/不写** → 每次都可能重新下载

**三条必须遵守**：

| 规则 | 说明 |
|---|---|
| **1. MD5 必须是我们实际提供的那份 jar 的** | 当前 `<md5>`（1,728,688 B，2026-10-26 `md5sum` 实测） |
| **2. 不能用上游的 `<upstream-md5>`** | 我们重打包的产物与上游不同（用户已明确否定"逐字节对齐"） |
| **3. jar 更新后 MD5 必须同步更新** | 否则用户永远拿不到新版（会用旧缓存） |

**第 3 条是最容易漏的**：重新打包 jar 后忘了改 config 里的 MD5，
Fongmi 会认为本地那份是对的，**永远不下载新的**。

### 2.3 实现建议

不要手写 MD5，**启动时算**：

```java
String jarPath = "dist/spider-latest.jar";
String md5 = Crypto.md5(new File(jarPath));   // 或自写 MD5
String spider = "http://" + host + ":" + port + "/spider-latest.jar;md5;" + md5;
```

`/config.json` 每次请求时现算（成本 <10ms，1MB 文件），或者启动时算一次缓存起来。

---

## 第三章 九项配置逐个说明

### 3.1 `sites`（必需）

**来源**：`artifacts/config.json` 的 `sites`（40 条 / 28 唯一 api）

**每条必须包含**（详见 `docs/26` §4.2）：

```json
{
  "key": "干饭",
  "name": "干饭",
  "type": 3,
  "api": "csp_AppDrama2",
  "ext": "com.juechufsh.android.xpg1",
  "searchable": 1,
  "changeable": 1,
  "hide": 0,
  "indexs": 1,
  "timeout": 20
}
```

**关键点**：
- `api` 必须以 `csp_` 开头（Fongmi 靠 `isCsp()` 判断，见 `BaseLoader.java:53`）
- `key` 必须唯一（`Bili` 的 6 个 ext 需要 6 个不同 key）
- `type: 3` 是 CatVod 约定，虽然 Fongmi 实际靠 `api` 前缀判断，但保持一致

**现状**（2026-10-26 实测，0.9.15）：`GET /config.json` 的 `sites` 已有 **40 条**
（`sites` 表原样输出；`/api/sites` 里 `Bili`、`Bili#2` … `Bili#6` 六个 key 都在）。
原写的「只有 28 条、`Bili` 塌缩成 1 个」是旧缺陷，已修。

### 3.2 `parses`（必需）

**来源**：`artifacts/config.json` 的 `parses`（实测 4 条）

```json
[
  {"name": "Json聚合",   "type": 3, "url": "Demo"},
  {"name": "Web聚合",    "type": 3, "url": "Web"},
  {"name": "qiyi[官源]", "type": 1, "url": "http://39.104.230.177:1122/lxjx/myyk.php?url="},
  {"name": "示例解析",  "type": 1, "url": "https://example.com/parse?id=2&url=",
   "ext": {"flag": ["qq","腾讯","qiyi","爱奇艺","youku","优酷","mgtv","芒果", "...共 25 个"]}}
]
```

**`type` 语义（Fongmi `ParseJob.doInBackground`）**：

| type | 行为 | 服务端可行性 |
|---|---|---|
| 0 | WebView 嗅探 | ❌（需 Android WebView） |
| 1 | `GET parseUrl + target` | ✅（我们的 `/api/parse` 实现这个） |
| 2 | jar 的 `Json<Key>.parse` | 需 jar 里有对应类 |
| 3 | jar 的 `Mix<Key>.parse` | 同上 |
| 4 | 超级解析（并发） | ✅ |

**`ext.flag` 的作用**：限定该解析器只对哪些线路标识生效。
**这是必须原样透传的**，否则 TV 端会用错解析器。

### 3.3 `lives`（直播）

**来源**：config 的 `lives`（实测 1 条）

```json
[{"name": "Gather「果」", "type": 3, "url": "https://tv.tmxk.kdns.fr/yplrnuc7",
  "epg": "https://material.1989.click/epg.xml.gz",
  "ua": "okhttp/3.8.1", "timeout": 10, "playerType": 2}]
```

**字段**：`name` / `type` / `url` / `epg` / `ua` / `timeout` / `playerType`

**注意**：`type: 3` 表示走 spider（需要 jar 里有 `Live` 类）；`type: 0` 表示纯 M3U。

### 3.4 `rules`（HLS 分片广告过滤）

**来源**：config 的 `rules`（实测 14 条）

```json
[{
  "name": "♻️量非",
  "hosts": ["lz", "vip.lz", "v.cdnlz", "hd.lz", "ffzy", "vip.ffzy", "hd.ffzy"],
  "regex": ["#EXT-X-DISCONTINUITY\\r*\\n*#EXTINF:6.666667,[\\s\\S]*?#EXT-X-DISCONTINUITY"]
}]
```

**语义**：当播放的 m3u8 的 host **包含** `hosts[]` 任一项时，
用 `regex[]` 从清单里删掉匹配的片段。

**注意**：`hosts` 是**子串匹配**（不是精确相等）。`"lz"` 会匹配 `hd.lz.xxx.com`。

### 3.5 `ads`（整域屏蔽）

**来源**：config 的 `ads`（实测 1 条）

```json
["static-mozai.4gtv.tv"]
```

**语义**：请求命中这些域直接拒绝。

**注意**：实测多个源的 `ads` 高度重合（`static-mozai.4gtv.tv` / `vip.ffzyad.com` /
`iqiyi.hbuioo.com` / `wan.51img1.com`），这是**行业共享库**，可以直接合并多份。

### 3.6 `proxy`（强制代理的 host 列表）

**来源**：config 的 `proxy`（实测 17 条）

```json
["raw.githubusercontent.com", "googlevideo.com", "cdn.v82u1l.com", "...", ".*nivod.*"]
```

**语义**：命中（支持正则，如 `.*nivod.*`）的请求**强制走客户端代理**。

**这条对我们特别重要**：TV 端由 Fongmi 自己代理；Web/PC 端由我们的后端代理。
**两边读同一份表**，行为才一致。

### 3.7 `hosts`（DNS 改写）

**来源**：config 的 `hosts`（实测 5 条）

```json
[
  "hlsztemgsplive.miguvideo.com=hlsztemgsplive.miguvideo.com.b.cdn.chinamobile.com",
  "cache.ott.fifalive.itv.cmvideo.cn=cache.ott.fifalive.itv.cmvideo.cn.e.cdn.chinamobile.com",
  "cdn9.163189.xyz=gcore.jsdelivr.net"
]
```

**语义**：`<原域名>=<替换域名>`，用于
- 咪咕/移动这类**限区域源**（改到 CDN 域名）
- 绕墙（`cdn9.163189.xyz` → `gcore.jsdelivr.net`）

**注意**：这是**域名改写**，不是代理。请求仍直连，只是 DNS 结果被换掉。

### 3.8 `doh`（DNS over HTTPS）

**来源**：config 的 `doh`（实测 5 条）

```json
[{"name":"Google","url":"https://dns.google/dns-query","ips":["8.8.4.4","8.8.8.8"]}]
```

**注意**：`ips` 是 DoH 服务的**引导 IP**（避免"解析 DoH 域名本身需要 DNS"的循环）。

### 3.9 `headers`（按 host 注入请求头）

**来源**：config 的 `headers`（实测 1 条）

```json
[{"host": "hlsztemgsplive.miguvideo.com", "header": {"User-Agent": "okHttp/Mod-1.5.0.0"}}]
```

**语义**：请求该 host 时附加指定头。用于某些源校验特定 UA。

---

## 第四章 Fongmi 侧消费路径（便于排查）

> 以下为 （私有开发资料） 源码实证，用于理解"为什么我的配置没生效"。

### 4.1 配置加载流程

```
用户填配置地址
  → VodConfig.load(config)
  → Decoder.getJson(url)                      ← 拉 JSON（支持加密/压缩）
  → checkJson()
      ├─ if (has "urls")  → parseDepot()      ← 多仓：只取 urls[0]
      └─ else             → parseConfig()
              ├─ initList()    → headers/proxy/rules/doh/flags/hosts/ads
              ├─ initLive()    → lives
              ├─ initWall()    → wallpaper
              ├─ initSite()    → spider（!!）→ sites
              └─ initParse()   → parses
```

**关键**：`initSite()` 里第一件事就是 `BaseLoader.get().parseJar(spider, true)`。
**如果 `spider` 字段缺失或无效，sites 全部失效**。

### 4.2 站点实例化流程

```
Site.spider()
  → BaseLoader.getSpider(key, api, ext, jar)
      ├─ isCsp(api)  → jarLoader.getSpider()
      │     → parseJar(md5校验/下载)
      │     → DexClassLoader(file, cache, cache, parentLoader)
      │     → invokeInit(): 反射调 Init.init(context)
      │     → Class.forName("com.github.catvod.spider." + api.substring(4))
      │     → spider.siteKey = key
      │     → spider.net = new Net(...)
      │     → spider.init(context, ext)
      ├─ isJs(api)   → JsLoader
      ├─ isPy(api)   → PyLoader
      └─ isNode(api) → NodeLoader
```

**排错要点**：
- `api` 少了 `csp_` 前缀 → 走 `SpiderNull`（静默失败！）
- `ext` 为空 → `init(context, "")`，多数 spider 会失败
- jar 的 MD5 不对 → 重新下载（慢，但会成功）

### 4.3 `parse=1` 处理流程

```
playerContent 返回 {"parse":1, "url":"https://site.com/v/123.html"}
  → ParseJob.setParse()
      有 "json:" 前缀 → Parse.get(1, url)
      有 "parse:" 前缀 → 按名字找解析器
      否则用 config 默认 parse
  → doInBackground() switch(type)
      type 0 → startWeb()          WebView 嗅探
      type 1 → jsonParse()         GET parseUrl+url
      type 2 → jsonExtend()        调 jar 的 Json<Key>
      type 3 → jsonMix()           调 jar 的 Mix<Key>
      type 4 → superParse()        并发所有 type1 + type0
```

**这是 TV 端能播而 Web/PC 不能播的根因**：
TV 有 WebView（type 0）和完整的 ParseJob，我们的后端只有 HTTP。
所以 `docs/25` 的 B4 要求我们至少实现 type 1 和 type 4。

---

## 第五章 配置托管方案

### 5.1 推荐方案：后端直接提供（阶段 1 的核心）

**不再用 `serve_tv.py`**，改为后端输出：

```
GET /config.json              → 九项完整（spider 指我们的 jar）
GET /config-upstream.json     → 同结构（spider 指上游）
GET /depot.json               → 多仓
GET /spider-latest.jar        → jar 本体
```

**实现要点**：

```java
// CatVodExport.java（新增）
public static String build(String baseUrl, boolean upstream) {
    JSONObject root = new JSONObject();
    root.put("spider", upstream
        ? UPSTREAM_SPIDER                                    // "https://example.com/spider.php;md5;<md5>"
        : baseUrl + "/spider-latest.jar;md5;" + md5Of(jarFile));
    root.put("sites",   sitesAsCatVod());                    // 40 条，不是 28 条
    root.put("parses",  configTables.parses());
    root.put("lives",   configTables.lives());
    root.put("rules",   configTables.rules());
    root.put("ads",     configTables.ads());
    root.put("proxy",   configTables.proxy());
    root.put("hosts",   configTables.hosts());
    root.put("doh",     configTables.doh());
    root.put("headers", configTables.headers());
    // 可选
    root.put("wallpaper", configTables.wallpaper());
    root.put("logo",      configTables.logo());
    return root.toString();
}
```

**jar 托管要点**：

```
GET /spider-latest.jar
  ETag: "<md5>"
  Last-Modified: <mtime>
  Content-Type: application/java-archive
  → 支持 304（Fongmi 的 Download 会带 If-None-Match）
```

### 5.2 过渡方案：保留 `serve_tv.py`

如果阶段 1 还没做完，可以继续用 `serve_tv.py`，但要注意：

```bash
python 私有开发资料 --prepare          # 准备 jar + config
python 私有开发资料 --host 172.30.160.1
```

**它的问题**：手工、不常驻、与 `/api/config` 不一致。
**仅作过渡**，阶段 1 完成后废弃。

### 5.3 局域网访问

TV 需要能访问到后端。三种情况：

| 场景 | 做法 |
|---|---|
| 同机（模拟器） | `http://127.0.0.1:9979/config.json` |
| 同局域网 | `http://<本机内网IP>:9979/config.json`（如 `192.0.2.10`） |
| 跨网络 | 需反向代理 + HTTPS + 鉴权（**不要直接暴露**） |

**获取内网 IP**：Windows `ipconfig`，或后端启动时打印。

**注意**：`docs/07` 里提到的 `172.30.160.1` 是某个虚拟网卡的地址，不通用。

---

## 第六章 在 Fongmi 里怎么填

### 6.1 填配置

```
Fongmi → 设置 → 配置地址 → 输入 http://<host>:9979/config.json
```

**如果是首次**：可能要先进「数据配置」/「快捷配置」再填地址（版本不同菜单名不同）。

### 6.2 验证加载成功

| 现象 | 含义 |
|---|---|
| 首页出现分类 Tab + 海报 | ✅ 成功 |
| 提示"配置解析失败" | `/config.json` 不是合法 JSON，或九项结构错 |
| 站点列表为空 | `spider` 字段无效（jar 拉不到）或 `sites` 为空 |
| 站点有但点进去报错 | 该站的 `ext` 错 / spider 类不存在 |
| `parse=1` 的站能播 | Fongmi 的 ParseJob 工作正常 |

### 6.3 排错顺序（按命中率）

1. **先看 `spider` 字段**：浏览器直接访问那个 URL，确认能下载到 jar
2. **确认 MD5**：`md5sum spider-latest.jar` 与 config 里的是否一致
3. **确认 `api` 前缀**：必须是 `csp_Xxx`
4. **确认 `ext`**：与 `artifacts/config.json` 里该站点的 `ext` 完全一致
5. **看 logcat**：`BaseLoader` / `JarLoader` 会打 `printStackTrace`

---

## 第七章 编译 Fongmi（仅在需要改它时）

> **默认不需要**。只有以下情况才编译：
> - 要改 UI 主题/图标/应用名
> - 要调试它的 catvod 模块
>
> **日常使用直接装官方 release APK 即可。**

### 7.1 构建变体

`app/build.gradle` 实测：

```gradle
flavorDimensions = ["device"]
productFlavors {
    leanback { dimension "device" }    // TV
    mobile   { dimension "device" }    // 手机
}
splits {
    abi {
        enable = true
        include "arm64-v8a", "armeabi-v7a"
        universalApk = false
    }
}
```

**命令**：
```bash
cd 上游参考项目
./gradlew :app:assembleLeanbackRelease    # TV 版
./gradlew :app:assembleMobileRelease      # 手机版
```

**产物**：`app/build/outputs/apk/leanback/release/`（按 ABI 拆分，无 universal）

### 7.2 注意事项

| 项 | 说明 |
|---|---|
| **GPL-3.0** | 分发修改版必须开源 |
| **最低 Android 7.0（API 24）** | — |
| **不要动 `catvod` 模块** | 那是核心加载器，改了就失去上游兼容 |
| **主题/图标改动** | 在 `app/src/main/res/`，与 `catvod` 无关 |

### 7.3 基于 motao123-webtv 构建（2026-10-23 全程实测）

> **该二开路线已废弃（2026-11-04 核对）**：现行 TV 客户端是 §1 的 `client/apps/tv` 自研壳，
> 不再从 （私有开发资料） 复制副本。本节仅保留当时的构建环境记录。

**本机环境实测通过的完整链路**（10 个 APK 全部产出）：

| 依赖 | 要求 | 本次实测值 / 踩坑 |
|---|---|---|
| JDK | 17+ | Temurin 17.0.20.1 |
| **Gradle** | **9.6.1**（wrapper 指定） | 直连 `services.gradle.org` 超时；用 `https://mirrors.cloud.tencent.com/gradle/gradle-9.6.1-bin.zip` |
| **compileSdk** | **37** | 本机原本只有 34/35。`sdkmanager` 12.0 的清单里**没有 android-37**，报 `Failed to find package`；改为直接下 `https://mirrors.cloud.tencent.com/AndroidSDK/platform-37.0_r02.zip` 解到 `$ANDROID_HOME/platforms/android-37`，**并手写 `source.properties`**（缺它 Gradle 认不出） |
| **build-tools** | **36.0.0** | 同上，下 `build-tools_r36_windows.zip`，解压后内容在 `android-16/` 子目录里，要摊平到 `build-tools/36.0.0/`，同样要手写 `source.properties`（`Pkg.Revision=36.0.0`） |
| **chaquo Python** | **3.10 绝对路径** | 报 `Couldn't find Python 3.10`——chaquo 17 **不查 PATH**。必须在 `chaquo/build.gradle` 的 `python {}` 块里写 `buildPython = [...列表...]`；**类型是 List 不是 String**，传字符串报 `Cannot cast ... to java.util.List` |
| **maven 镜像** | 阿里/华为 | 直连 `google()` / `gradlePluginPortal()` 在境内不可达。`settings.gradle` 的 `pluginManagement` 与 `dependencyResolutionManagement` **两处都要加**镜像 |
| **local.properties** | 路径双写反斜杠 | 写 `sdk.dir=C:\Android` 会被 properties 解析成 `C:Android`，报"文件名、目录名或卷标语法不正确" |

**命令**：

```bash
cd tv && export JAVA_HOME=/path/to/jdk17
$GRADLE_HOME/bin/gradle :app:assembleDebug --no-daemon
```

**产物**：`tv/app/build/outputs/apk/{leanback,mobile}{Full,Lite}{Arm64_v8a,Armeabi_v7a,Universal}/debug/`，
实测 10 个 APK（70–132 MB；Leanback=TV 版，Mobile=手机版，Lite 不含 Full 的额外内核）。

**装到设备**：
```bash
adb install -r tv/app/build/outputs/apk/leanbackFullArm64_v8a/debug/app-leanback-full-arm64_v8a-debug.apk
```
TV 模拟器/真机在 Android Studio 的 Device Manager 里起，或直接连真机。

> ⚠️ `tv/` 是复制出来的构建目录（146MB + 产物），**已加进 `.gitignore`**，
> 不入库。需要重建时按上面两条命令再复制一次。

---

## 第八章 TV 参与三端统一的能力边界

### 8.1 TV 能做的（我们不需要管）

| 能力 | Fongmi 实现 |
|---|---|
| DexClassLoader 加载 jar | `JarLoader` |
| `parse=1` 全套（含 WebView 嗅探） | `ParseJob` |
| drpy / Python / Node 运行时 | `QuickJsRuntime` / `PythonRuntime` / `NodeRuntime` |
| proxy 四级路由 | `BaseLoader.proxy` |
| 直播 + EPG + 回看 | `LiveConfig` / `LiveParser` |
| 弹幕 | `DanmakuApi` |
| 片头尾跳过 | 读 `skips` |
| DLNA 投屏、网页遥控 | 独立模块 |

**所以 TV 端的源覆盖率取决于"Fongmi 能跑什么"，不是"我们后端能跑什么"。**

### 8.2 TV 不能做的（需要我们）

| 能力 | 为什么 |
|---|---|
| **跨端状态** | Fongmi 的状态在它自己的 Room DB 里，Web/PC 拿不到 |
| **统一的能力声明** | Fongmi 的 `Site` 字段与我们的 REST 契约不同 |
| **服务端 parse** | Fongmi 在客户端做，对 Web/PC 无帮助 |

### 8.3 跨端状态的三条路径（Q1 待验证）

| 方案 | 做法 | 成本 | 评价 |
|---|---|---|---|
| **A. 各自独立** | TV 状态不进后端 | 0 | ❌ 不满足三端统一 |
| **B. 解析 Fongmi 备份** | 逆向 `Backup` JSON 格式，双向转换 | 中 | 可行，格式可能变 |
| **C. 只同步进度** | 在 `play` 返回里注入 `position` | **低** | **优先验证** |

**C 的验证方法（必须实机做）**：

1. 手工构造 `play` 返回，带 `"position": 600000`（10 分钟）
2. Fongmi 播放该片
3. 观察是否从 10 分钟开始

**依据**：`CatVodSpider/docs/development.md` 里 `Response.position(long)` 存在，
说明协议支持；但 Fongmi 是否真的读取，**未验证**（`docs/25` Q1）。

如果 Fongmi 不读 → 只能走 B（解析备份文件）。

---

## 第九章 验收清单

### 9.1 后端侧（阶段 1 验收）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | `GET /config.json` | 九项齐全，JSON 合法 |
| 2 | `spider` 字段 | 浏览器能下载到 jar；MD5 与实际文件一致 |
| 3 | `sites` 数量 | **40 条**（不是 28）；`Bili` 出现 6 次 |
| 4 | `parses` | 4 条，`ext.flag` 完整透传 |
| 5 | `rules`/`ads`/`proxy`/`hosts`/`doh` | 与 `artifacts/config.json` 逐条一致 |
| 6 | jar 托管 | 支持 ETag，304 生效 |

### 9.2 TV 侧（人工验收）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 填配置 | 无报错 |
| 2 | 首页 | 出现分类 Tab + 海报网格 |
| 3 | 站点数 | 与 config 的 `sites` 数一致 |
| 4 | 播放 | 至少 3 个源能播 |
| 5 | `parse=1` 源 | 至少 1 个能播（证明 ParseJob 生效） |
| 6 | 弹幕 | 有弹幕的片能显示 |
| 7 | **源码零改动** | 用官方 release APK，未编译 |

**第 7 条是 `docs/25` 的 V5，也是最重要的验收项**——
它保证我们不会掉进"fork Fongmi 然后维护两份"的坑。

### 9.3 模拟器实机验证（2026-10-23 已跑通，可复现）

真机/模拟器都行，下面是模拟器的一套完整命令（`emulator-5556` 是本机的设备号）。

**环境准备**（本机原本只有 SDK 34/35，`sdkmanager` 12.0 的清单里没有 37，见 §7.3）：

```bash
# system-image + emulator 只能从镜像下；官方 sdkmanager 拉不到清单
curl -L -o emu.zip https://mirrors.cloud.tencent.com/AndroidSDK/emulator-windows_x64-16632760.zip
curl -L -o sys.zip https://dl.google.com/android/repository/sys-img/google_apis/x86_64-35_r09.zip
# 解到 $ANDROID_HOME/emulator 与 $ANDROID_HOME/system-images/android-35/google_apis/x86_64
# avdmanager 会报 "emulator package must be installed!" —— 缺 package.xml，手写一个即可
avdmanager create avd -n meow_tv -k "system-images;android-35;google_apis;x86_64"
emulator -avd meow_tv -no-snapshot-load -no-audio -gpu swiftshader_indirect &
```

**APK 必须带 x86_64**：真机 APK 只有 `arm64-v8a`/`armeabi-v7a`
（`app/jniLibs` 里的 mpv/ijk 只有 arm），x86_64 模拟器装不上。为此在
`app/build.gradle` 的 `abi` flavor 里加了 `x86_64`，只构建 **Lite**
（Lite 不带 mpv/python，所以能跑；它证的是"配置能加载 + 能出分类"，不代表真机播放表现）：

```bash
gradle :app:assembleLeanbackLiteX86_64Debug --no-daemon
adb -s emulator-5556 install -r app/build/outputs/apk/leanbackLiteX86_64/debug/*.apk
```

**让模拟器访问宿主后端**：用 `10.0.2.2`（模拟器里的宿主机别名）。
`spider` 字段由 `baseUrlFor(ex)` 按请求的 `Host` 头生成，所以 TV 用 `10.0.2.2:9979`
访问时，`/config.json` 里的 `spider` 自动变成 `http://10.0.2.2:9979/spider-latest.jar;md5;...`
——**不需要额外配置**（用 `curl` 验证时要显式 `-H 'Host: 10.0.2.2:9979'`，
否则看到的是 `127.0.0.1`，那是正常的）。

**注入配置地址**（比走 UI 可靠）：Fongmi 把配置存 **Room 数据库** `databases/tv` 的
`Config` 表 + `Prefers` 的 `config_0`。设备上有 `sqlite3`，用 `run-as` 直接改：

```bash
DB=/data/data/com.fongmi.android.tv/databases/tv
adb shell "run-as com.fongmi.android.tv sqlite3 $DB \
  \"INSERT INTO Config (type,time,url,name) VALUES (0, $(date +%s)000, 'http://10.0.2.2:9979/config.json', 'meow');\""
# 同时写 prefs，否则应用启动仍读旧值
cat prefs.xml | adb shell "run-as com.fongmi.android.tv sh -c 'cat > /data/data/.../shared_prefs/...xml'"
```

**实测结果（两台现象都要知道）**：

| 观测 | 结果 | 说明 |
|---|---|---|
| 后端 `[req] GET /config.json` | ✅ 收到（多次） | 客户端确实来拉我们的配置 |
| 后端 `[req] GET /spider-latest.jar` | ✅ 收到 | jar 地址也对 |
| 首页标题 | ✅ 显示 `meow` | 配置名已生效（原本是内置的"🐼QQ频道：肥猫宝贝"） |
| **出分类** | ✅ **TV / Movie / Variety 三组正常渲染** | 后端同期收到 `POST /api/Douban/home` + `POST /api/Douban/category` |
| jar 缓存落盘 | ❌ `cache/jar/` 没被创建 | 见下方注意事项 |

> ⚠️ **踩过的坑：模拟器里 jar 下载成功但缓存目录没创建**（`cache/` 属主是
> `u0_a209_cache` 组，写入被拒），表现是"配置名生效但站点全空"。
> 绕法是把 jar 用 `adb push` + `run-as cp` 放进
> `/data/data/com.fongmi.android.tv/files/TV/spider.jar`，再把 config 的
> `spider` 改成这个绝对路径（Fongmi 支持本地路径），站点立刻出来。
> **真机一般没有这个权限问题**；遇到"配置名对了但没站点"先查这里。

**参考**：`D` 键调试面板、`window.__meowDm` 只对 Web 端有效，TV 端看
`adb logcat --pid=$(adb shell pidof com.fongmi.android.tv)`。

---

## 第十章 常见问题

| 现象 | 原因 | 解法 |
|---|---|---|
| 配置加载成功但站点全空 | `spider` 字段无效 | 浏览器访问 jar URL 确认可下载 |
| 部分站点点进去报错 | 该站 `ext` 与上游不一致 | 逐条比对 `artifacts/config.json` |
| 所有站点都报"类不存在" | jar 没下下来，或 MD5 永远不匹配 | 手工 `curl` jar，算 MD5 比对 |
| jar 更新了但 TV 还是老版本 | **MD5 没同步更新** | 改 config 里的 MD5 |
| 换了 jar 后全崩 | 新 jar 缺 CatVod 基类 | 用 `dist/spider-complete-latest.jar`（886 类，带基类兜底） |
| 直播空白 | config 缺 `lives`，或 `type` 不对 | 检查 `lives[].type`（3=spider，0=纯 M3U） |
| `parse=1` 的源播不了 | Fongmi 的 WebView 不可用（TV 盒子精简系统） | 换有 WebView 的设备，或该源无解 |

### 10.1 极米 Z6X Pro：聚合搜索把进程打崩（2026-10-29 定位到根因，属设备 ART 缺陷）

**设备**：XGIMI TV / Android 9 / API 28 / **armeabi-v7a**（zygote32，原厂固件无 root）

#### 一、崩溃线程与栈（8 份 tombstone 完全一致）

```
signal 6 (SIGABRT), 线程名 HeapTaskDaemon
HeapTaskDaemon → ConcurrentCopying::MarkNonMoving
  → Verification::LogHeapCorruption → art::Runtime::Abort
Abort message: dalvik-main space (region space) 范围被打印
```

这是 **32 位 ART 并发拷贝 GC 在标记非移动区（Class 对象所在区域）时
判定对象图不一致**，运行时内部直接 abort。**不是 Java 异常，应用层捕获不到**
（已装 `Thread.setDefaultUncaughtExceptionHandler` + `crash.log`，从未被触发；
只能从 `/data/tombstones/` 取栈——dropbox 与 logcat 在这台机上均不可用）。

#### 二、变量控制（同 APK + 逐字节相同的 270 站配置）

| # | 实验 | 结果 | 排除了 |
|---|---|---|---|
| 1 | MuMu(x86_64) vs 投影仪 | MuMu **5/5 全成**（36条/10源）；投影仪 **0/5**（第1轮必崩） | 配置、源站、代码逻辑 |
| 2 | 换**肥猫官方 jar** | 投影仪仍第1轮崩 | 我们的 jar 与 spider 实现 |
| 3 | 投影仪壳连 **OECT 后端** | **5/5 全成**（144–150条/16–17源） | 设备网络、WebView、进程健康 |
| 4 | 单站 Bili 连调 40 次 | 全成 | 调用量 |
| 5 | 并发压到 4 / 串行单站零并发 | 仍崩，崩点随机漂移 | 并发是唯一诱因 |
| 6 | 去掉 `android:largeHeap` | 仍崩 | 堆上限声明 |
| 7 | 应用退后台（WebView 停渲染） | 仍崩 | WebView 抢堆 |
| 8 | **只加载类、不发请求**（预热 44 类） | 加载到第 14 个仍存活，进程未崩 | 类加载单独不致病 |
| 9 | 加载 14 类后开始搜索 | **秒崩** | —— |
| 10 | 设备全部 10 份 tombstone | **全部是 `com.meow.tv`**，Fongmi 一份都没有 | 设备普遍性缺陷 |

第 8+9 条合起来定性：**"已加载的 dex 类" + "活跃的网络/JSON 对象"同时存在时必崩**，
只有其中一样时正常。这正是 `MarkNonMoving` 的触发面。

**实测稳定边界**（单轮同时活跃的源数）：3 源×5 轮全成、6 源×3 轮全成、
10 源第 2 轮崩。32 位设备因此把并发封顶 6。

#### 三、与「Fongmi 不崩」的关系

Fongmi 在这台机上确实 0 份 tombstone，但它的源是**首页驱动、点哪个加载哪个**，
从不需要一次把 44 个类全激活；我们的一次聚合搜索正是要全部激活。
它自己的 prefs 里也有 `crash_*` 源级失败标记（FeiMaoUC / Duopan），
说明这台机上它同样会遇到源级失败。

#### 四、处置

- **32 位 Android 自动降级**：并发封顶 6（判据 `dalvikHeapLimitMB>0 && is32Bit()`），
  且走**单级执行**（不套 `SITE_TIMEOUT_POOL`，避免对象跨线程同时进入两个线程的
  本地标记栈）。`/api/health` 新增 `heapMaxMB / dalvikHeapLimitMB /
  searchConcurrency / searchConcurrencyCapped` 四个字段，设置页可据此提示用户。
- **正常设备完全不受影响**：JVM 取不到 dalvik 属性、64 位 Android region space
  从 4GB 起，两条路径都不进降级分支；并发**完全按用户在设置页选的档位**。
- **根治需要执行进程隔离**（`android:process=":spider"`，崩了只崩子进程）。
  工作量约 1–2 天，本轮未做。

### 10.1.1 ★ PC 插件丢源：fat jar 大小写冲突（2026-10-29 已修）

**症状**：同一份配置，MuMu 出 10 个源，PC 插件只出 7 个；缺的固定是
**Bili / SP360 / Duopan / SaoHuo**。单站调用报

```
NoClassDefFoundError: com/github/catvod/spider/merge/N/F
(wrong name: com/github/catvod/spider/merge/n/f)
```

**根因**：`server/host/libs/spider.jar` 里有只差大小写的三条同名路径

```
com/github/catvod/spider/merge/N/F.class   (1477B)
com/github/catvod/spider/merge/N/f.class   (2145B)
com/github/catvod/spider/merge/n/f.class   ( 478B)
```

这在 Linux/macOS 打包的 zip 里合法，但 `build-plugin.ps1` 用
`jar xf` **解压到 Windows 磁盘再重新打包**，Windows 不区分大小写 ——
实测 883 个 class 解出来只剩 **571 个**，fat jar 里 `merge/n/f` 直接消失。

**修法**：`build-plugin.ps1` 打包 fat jar 时**排除 spider.jar**
（它本来就该由 manifest 的 `-cp "apiserver.jar;dist/spider.jar"` 单独挂载，
合并进 fat jar 既违背设计又必然踩大小写冲突）。修复后 fat jar 里 spider 类数为 0，
Bili 从 `n=0` 恢复为 `n=20`。

**判据**：`unzip -l apiserver.jar | grep -c spider/` 必须是 **0**。

### 10.1.2 搜索线程池的最终形态（2026-10-30 定稿）

```
SEARCH_POOL（进程级共享，core=max=本轮 effThreads，allowCoreThreadTimeOut）
  ↑ 每轮只调 setCorePoolSize/setMaximumPoolSize，线程对象永久复用
信号量 gate（许可数 = effThreads）
  ↑ 真正限制"同时跑几个源"，与池大小解耦
单级执行（spider 直接在池线程里跑，不套第二层池）
  ↑ 见下面「★ 为什么删掉两段式」
收尾 drainTo(队列)（丢弃未开始的任务，但不关闭池）
  ↑ 池要留给下一轮复用，所以不能 shutdownNow
```

**踩过的三个反向坑**（都会让正常设备变慢，改的时候别退回去）：

1. `ThreadPoolExecutor(core=2, max=32, 无界队列)` + 只设 max 不设 core ——
   **线程数永远到不了 core 以上**（任务先入队、队列不满不扩容），
   实测把 docker 原本的 12 并发压成 **2**。
   必须 `core == max == 本轮并发`。
2. 无条件 `min(用户设置, memBound)` —— 用户设置页选 24 线程，实际只跑 16
   （192MB/3/4MB），界面上看不出差别，用户只会觉得"选了没用"。
   规则改为：**请求带了 threads 就完全按用户的**，memBound 只在没传值时兜底。
3. **每轮 `new ThreadPoolExecutor` + `shutdownNow`** —— 为了躲跨轮残留把线程复用
   也一起牺牲了。真正的病根不是池复用，是"慢源占死槽位"（见下一节）。

#### ★ 为什么删掉两段式（`SITE_TIMEOUT_POOL`）

原来非 32 位设备走 `searchPool 线程 → SITE_TIMEOUT_POOL 线程`，外层
`inner.get(8s)` 掐表。问题不在超时，在**取消**：

> `Future.cancel(true)` 只是 `Thread.interrupt()`。
> OkHttp 的同步 `execute()` 阻塞在 `socket.read()` 上，**Java Socket 读不检查中断标志**
> ——所以到点 cancel 只是"外层不等了"，内层任务继续跑到 spider 自己的 30 秒。

实测证据（OECT，`ls /proc/1/task`）：`meow-site-to` **24 个线程全被占满**，
`meow-search` 只剩 4 个。下一轮 270 个源提交进去只能排队、8 秒全超时 → 整轮 0 结果。
这正是用户看到的「第一次能搜、第二次全空」。

**Fongmi 同样受此限制**（它的 `FluentFuture.withTimeout` 也只是 cancel），
它没暴露是因为线程池固定 20 个、且源表小（通常几十个）。

#### ★ 脚本源自适应降级（治"运行时整层坏了"）

`jsRuntimeAvailable()`（`/health` 探测）+ `jsRuntimeBadUntil`（真实结果学习）
两层判断。判据**不用 `/health`**：实测 OECT 上 drpy 容器 unhealthy，但 `/health`
仍会偶尔返回 `{"ok":true}`（它只是忙），而搜索请求全部卡住。

触发条件（需 ≥5 个脚本源样本）：
- 回来的脚本源一半以上返回空，或
- **提交的脚本源一半以上根本没回来**（这才是 OECT 的实际情况）

命中后跳过 5 分钟；某轮多数脚本源有内容则立即清零恢复。

**已知不足**：这是"整类跳过"，粒度比影视仓的"只排序不跳过"粗。
更好的做法是**排序 + 只提交前 K 个**（K 按槽位与预算动态算），
既让好源永远在窗口内，又不丢任何源。**这一项尚未实现。**

### 10.2 多形态搜索差异：设备时钟是唯一根因（2026-10-29 已修）

**问的问题**：同一份配置，不同形态各搜一遍，源的结果不一样，要判断是什么原因。

#### 四形态设计

| 形态 | spider 跑在哪 | 时间/网络出口 | 用途 |
|---|---|---|---|
| ① docker@本机 | 容器 | 宿主时间 / 宿主 IP | 基准 |
| ② PC 插件@本机 | JVM | 宿主时间 / 宿主 IP | 排除容器因素 |
| ③ **TV 网关@设备** | **电视** | **设备时间 / 电视 IP** | 被测对象 |
| ④ TV→OECT 后端 | OECT 容器 | OECT 时间 / OECT IP | **对照组**：TV 只当客户端，分离"设备环境"与"网络出口" |

④ 是关键——它让"电视的 IP 被源站拦"和"电视自己的运行环境有问题"变成可以分开验证的两件事。

#### 单站对照（绕开聚合搜索的干扰）

`POST /api/{site}/search`，关键词「我不是大师」：

| 源 | docker | OECT | TV 网关 |
|---|---|---|---|
| Jpys | 8.8s n=8 | 30.1s n=0 | **0.6s n=8** |
| Gulu | 0.1s n=3 | 0.6s n=3 | 2.4s n=3 |
| Gz360 | 16.1s n=2 | 6.5s n=2 | 2.0s n=2 |
| AppDrama2 | 0.1s n=1 | 0.0s n=0 | 0.5s n=1 |
| AppRJ | 0.2s n=1 | 0.2s n=1 | 0.2s n=1 |
| SaoHuo | 5.0s n=0 | 6.3s n=1 | 2.8s n=1 |
| SP360 | 0.9s n=0 | 2.0s n=1 | 2.1s n=1 |
| Bili | 0.5s n=20 | 0.5s n=20 | 0.6s n=20 |

**TV 网关 12 个源里 11 个正常**，Jpys 甚至比 docker 快 14 倍（0.6s vs 8.8s）。
所以"TV 搜不到源"不是设备能力问题。

#### 聚合对照（时钟校准后，三轮）

| 形态 | 耗时 | 条目 | 源 |
|---|---|---|---|
| ① docker@本机 | 4.1–9.0s | 29–32 | 8 |
| ② PC 插件 | 5.3–6.5s | 43–50 | 8–10 |
| ③ **TV 网关** | **4.4–4.9s** | **36** | **11（三轮完全一致）** |
| ④ TV→OECT | 4.4–5.4s | 22–25 | 3–6 |

**TV 网关在四形态里源数最多**（11 个），比 docker 多 3 个。

#### A/B 对照：只改时钟

同一台设备、同一个进程、同一份配置、同一个关键词，只 `adb shell date -s @<epoch>` 改设备时间：

| 设备时钟 | 源数 | 条目 | 丢掉的源 |
|---|---|---|---|
| 正确（误差 0.1 分钟） | 11 | 36 | — |
| **慢 10 小时** | **5** | 22 | AppDrama2, AppRJ, Gulu, Gz360, Jpys, SP360 |
| 复位 | 10 | 35 | —（SP360 为并发抖动） |

丢的正好是**请求里带 `System.currentTimeMillis()` 签名/时间戳**的那批：
`Jpys.searchContent` 用 `sha1(...+ currentTimeMillis())` 做签名头；
`Gulu.callApi` 把 `currentTimeMillis` 写进 protobuf 第 1、7 号字段。
服务端拒掉偏差过大的请求 → 返回错误结构 → spider 抛 `JSONException` → 宿主兜成空 list。

**为什么三种形态只有 TV 中招**：docker / PC / OECT 的 spider 跑在服务端，用服务端时间；
TV 网关的 spider 跑在设备上，用设备时间。真机上用户改错时区、主板电池损坏是同一类故障。

#### 修了什么

1. **`GET /api/health` 新增 `now` 字段**（服务器毫秒时间），客户端据此算偏移，不必额外端点。
2. **TV 壳启动时核对**（`TvBridge.checkClockSkew`）：拉 `health` 算 `mid - server`，
   超 5 分钟写一条可读告警。实测在 MuMu 上正确报出 `-592min`：
   `设备时钟与后端相差 592 分钟（设备慢），签名类源（Jpys/Gulu/Gz360/MiSou 等）会静默搜不到结果。`
   - 指向**本机网关时跳过**：同进程里 `now` 就是设备自己的时钟，`skew` 恒为 0（踩过，
     第一版没跳过，测出 0 分钟以为修错了）。
   - 探测要**等网关端口可连之后**再做：`core.LogBuffer` 是 `ApiServer.boot()` 里初始化的，
     早于它写入的告警在 `/api/logs` 里查不到（也踩过）。
3. **搜索失败日志记到站点名 + 最内层 cause**：原来只记 `t.toString()`，得到的是
   `java.lang.reflect.InvocationTargetException`，TV 上几十条一模一样的记录等于没记。
   现在解包 cause 并带上站点：`2-arg failed Jpys: JSONException — No value for data`。
   **这条日志是定位本节全部结论的前提**——没有它，只能看到"TV 少了几个源"。

#### 顺带查清的三个干扰项（都会让人误判成"TV 有问题"）

1. **`degraded` 状态各形态不一致**。docker 270 个源里 244 已降级（几乎全是 drpy_js），
   OECT 56 个里 33 降级（含 `PanSearch`/`SP360`/`Bili#2`），TV 网关 243。
   降级源在后续搜索里**被直接跳过**，于是"同一关键词两次结果不同"。
2. **聚合搜索有 `SEARCH_IDLE_MS = 2500` 提前收尾**：有结果后静默 2.5 秒就返回，
   未返回的慢源被截掉。TV 单站更快，反而更容易在慢源回来之前收尾。
   判断信号看耗时：`~2.5s` 是空闲收尾，`~20s` 是总预算到点，接近最慢单站才是跑完。
3. **源站按 IP/UA 拦截**。`pansearch.me` 对电视所在 IP 返回 **403**，docker 宿主 IP 放行
   → `PanSearch` 在 TV 上稳定 `IndexOutOfBoundsException`（它 `.get(0)` 取 token 列表，
   拿到空数组就抛）。这是源站侧限制，应用层无解。

### 10.3 聚合搜索的三处抖动源与收尾策略（2026-10-29 已改）

用户报的现象：同一个关键词搜两次，结果不一样。

#### 抖动的真身：慢源被收尾截掉，不是源不稳定

逐站量同一关键词三次（TV 网关）：

| 源 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| Jpys | 0.2s | 0.1s | 0.1s |
| AppGet | 0.2s | 0.1s | 0.1s |
| Bili | 0.6s | 0.5s | 0.4s |
| **Gz360** | **17.9s** | 0.8s | 0.8s |
| **SaoHuo** | **32.5s** | 0.7s | 1.7s |

首轮慢是 **DNS + TLS 建连**，之后同一个站就快了。而老的收尾逻辑只有一条：

```java
if (merged.size() > 0) {                 // 有结果就行
    if (idle 超过 2.5s) break;           // 静默 2.5 秒就返回
}
```

快源 0.6 秒全部回来 → 2.5 秒时收尾 → 首轮要 17.9 秒的源永远赶不上。
实测连打 6 轮，`Gz360` 只出现 **1 次**、`SP360` 4 次。

#### 改法：收尾要三条同时成立

```java
boolean longEnough   = 已跑满 waitBudget;                    // ① 给慢源起步时间
boolean mostReturned = returned * 10 >= totalTargets * 9;    // ② 九成站已返回
if (merged.size() > 0 && (longEnough || mostReturned)) {     // ③ 且已有结果
    if (idle 超过 SEARCH_IDLE_MS) break;
}
```

**`waitBudget` 按站表里已知最慢源自适应**：`min(10s, max(8s, slowest + 3.5s))`。
站点历史耗时由 `HealthRoutes.record(..., costMs)` 在**成功时**写入
（失败不写——超时值会把预算拉歪），聚合入口用 `HealthRoutes.lastCost()` 读。

为什么不用固定值：站表规模在各形态差一个量级（PC 插件 44 站 / TV·docker 270 站），
慢源波动也大（0.8s ~ 32.5s）。固定值要么让所有搜索都慢，要么继续截慢源。
为什么上限是 10 秒：实测 12 秒上限下最长一次搜索花 15.6 秒，用户已经在怀疑卡死。
超过 10 秒的源本就该由降级机制处理，不该每次搜索都等它。

注意 **`mostReturned` 单独不可靠**：`returned` 统计的是"完成数"，
超时和异常的空返回也算完成，比例门槛会很快满足。所以它只能和 `longEnough` 取或。

#### 效果（6 轮，关键词「我不是大师」）

| 源 | 改前 | 改后 |
|---|---|---|
| Gz360 | 1/6 | **6/6** |
| SP360 | 4/6 | 5/6 |
| 其余 8 个 | 6/6 | 6/6 |
| 单次耗时 | 2.4–4.6s | 2.2–6.0s |

#### ★ 对比测法本身的一个坑：形态间版本必须一致

第一轮四形态对比得出的"TV 最稳/最差"结论都**不成立**，因为四个形态跑的不是同一份代码：

| 形态 | 当时版本 | 含收尾修复 |
|---|---|---|
| docker@本机 | 0.9.28 | ❌ |
| PC 插件 | 0.9.21 | ❌ |
| TV 网关 | 0.9.29 | ✅ |
| OECT | 0.9.27 | ❌ |

拿新代码和旧代码比，量到的是版本差不是能力差。**跨形态比搜索前先对齐版本**
（`/api/health` 的 `version` 字段），否则结论一定是错的。

对齐后（用 `Dockerfile.apiserver` 现场构建 0.9.29 镜像、共用同一份 270 站配置）：

「我不是大师」，各 4 轮：

| 形态 | 耗时 | 条目 | 4 轮全中的源 |
|---|---|---|---|
| 新码 docker(宿主) | 6.2–14.5s | 34–35 | 9（SP360 抖动 3/4） |
| **新码 TV 网关(设备)** | **4.9–8.3s** | **36/36/36/36** | **11（无抖动）** |
| 旧码 docker(宿主) | 3.9–8.0s | 24–35 | 4（6 个源抖动） |

「庆余年第二季」：新码 docker 7 个全中 / TV 7 个全中，条目 30–33 / 22–25。

结论：**同版本下 TV 网关与 docker 持平甚至更全**，且条目数四轮完全一致（36/36/36/36）
说明收尾修复在设备侧效果最好（设备上单站更快，反而更依赖稳定的收尾策略）。

`Duopan` 是唯一稳定的源级差异，但根因是**降级状态不同**（docker 上 fail=10 已降级、
TV 上 fail=0 健康），同一份 ext、不同出口路径的可用性不同 —— 不是代码问题。

#### 三处必须知道的干扰项

1. **`degraded` 各形态不一致**。docker 270 源里 244 已降级（几乎全是 drpy_js），
   OECT 56 源里 33 降级（含 `PanSearch`/`SP360`/`Bili#2`），TV 网关 243。
   降级源在后续搜索里**被直接跳过**，于是"同一关键词两次结果不同"。
   跳过机制本身合理（连续 3 次失败 → 30 分钟窗口 → 任意成功即复亮），
   但**跨形态比结果前必须先对齐这个状态**，否则量出来的是降级差异不是能力差异。
2. **"空结果"不算失败**（这一点容易反直觉）。`call()` 判的是
   `raw == null || raw.trim().isEmpty()`，`{"list":[]}` 是非空字符串 → 记成功。
   这是对的：搜一个冷门词返回空是源站正常行为，记失败会让热门词也跟着被降级。
   实测连搜 4 次冷门词，`fail` 始终为 0。
3. **源站按 IP 拦**。见 §10.4。

#### 四形态同源结果（2026-10-29 最终，同版本口径）

口径说明：只统计**四形态站点表的交集**（44 个），额外源（干饭/一碗/潮流等）算变量外。

「我不是大师」：

| 形态 | 全中源数 | 抖动 | 条目 |
|---|---|---|---|
| 新码 docker | 9 | SP360(3/4) | 34–35 |
| 新码 TV 网关 | **11** | 无 | 36×4 |
| 旧码 docker | 4 | 6 个源 | 24–35 |

四形态都稳定命中的只有 `AppRJ`、`Bili` —— 这两个是最"皮实"的源，任何环境下都通。

「庆余年第二季」：

| 形态 | 全中源数 | 条目 |
|---|---|---|
| 新码 docker | 7 | 30–33 |
| 新码 TV 网关 | 7 | 22–25 |

两个关键词的差异源及原因：

| 源 | 现象 | 原因 |
|---|---|---|
| Duopan | docker 无 / TV 有 | docker 侧 fail=10 已降级，TV 侧 fail=0（出口不同） |
| PanSearch | 只有 OECT 有 | TV 出口被 CDN 重置（§10.4）；docker 侧本轮 4/4 有 |
| Jianpian | 只有 PC 插件(OECT栈)有 | PC 插件版本 0.9.21，站点表/代码不同 |
| SP360 | 各形态都抖 | 首轮慢 + 失败后重试，属源本身特性 |
| Jpys/Gz360/SaoHuo | 时钟错时全丢 | 见 §10.2，已在时钟校准后恢复 |

### 10.4 PanSearch 在 TV 上永久失败：出口 IP 被 CDN 重置（应用层无解）

| 目标 | docker | TV 网关 |
|---|---|---|
| `www.pansearch.me` | 200 / 200 / 200 | **502 / 502 / 502** |
| `www.google.com` | 超时 / 200 / 200 | **502 / 502 / 502** |

`502` 的正文是 `java.net.SocketException: Connection reset` —— **TLS 建连被重置**，
不是 HTTP 层的 403。换 UA（桌面 Chrome / 电视 UA）无效；TCP 层 `nc` 能连通，
说明是握手阶段被中间设备切断。

**原因**：TV 与宿主虽然同一个网关（`192.168.1.1`）、无代理，
但运营商 CGNAT 给它们分了**不同的出口**：

```
TV 出口    117.149.203.79      （另一条链路）
宿主出口   223.104.42.196      （移动，北京）
```

同一个源站对这两个出口的处置不同。这解释了为什么"同一个 APK、同一份配置，
TV 不行而 docker 行"——不是应用缺陷。

**应用层能做的两件事**（已做）：

1. 失败要快。`PanSearch` 在 TV 上 0.27 秒就失败（`IndexOutOfBoundsException`——
   它 `.get(0)` 取 token 列表，拿到空数组就抛），不会拖慢整体搜索。
2. 失败要能看见。日志现在是 `2-arg failed PanSearch: IndexOutOfBoundsException`，
   带站点名和最内层 cause（见 §10.2 第 3 条修复）。

**做不到的**：让 TV 访问被其出口封掉的站点。可选的外部手段是给 TV 配代理，
但那属于用户网络环境，应用不替用户改。

**补充**：`SP360` 也是"首轮慢 + 偶发失败"，但它在失败后会自动重试并成功，
所以结果是 5/6 而不是 0/6 —— 与 PanSearch 的"永久失败"要分开看。

### 10.5 源健康分类与聚合收尾的最终形态（2026-10-29 重构）

#### 问题：`/api/health` 报 "270 站 / 244 降级"

实测查清这 244 个的构成：

| 类型 | 数量 | 真实原因 |
|---|---|---|
| drpy 脚本源 | 222 | `jsRuntime 未配置`——TV 上没接 Node 运行时 |
| jar 源 | 22 | 19 个 `ext` 为空或指向不存在的相对路径（`./json/douban.json`） |

它们在任何环境都不会成功，被当成"源站故障"累计 streak 后进降级。于是那个
数字看起来像全线故障，实际一个都没坏。

更麻烦的是**30 分钟失活窗口的逻辑矛盾**：降级期间源根本不参与搜索，
就不可能"任意一次成功立即复亮"——唯一恢复路径是用户手动点设置页的"探活"。

#### 改法

**1）新增 `unsupported` 状态，与"反复失败"分开**

`HealthRoutes.classify(error)` 分五类，按"最能决定动作"的顺序判：

| Kind | 判据 | 动作 |
|---|---|---|
| `UNSUPPORTED` | `jsRuntime 未配置` / `ClassNotFoundException` / `ext 为空` | 跳过，**不计入 fail** |
| `TIMEOUT` | `timeout` / `Timed out` | 参与搜索，排后面 |
| `DNS` | `UnknownHost` / `Host resolution` | 可重试 |
| `TLS` | `SSL` / `certificate` | 多为中间设备拦截 |
| `ERROR` | 其余（HTML 当 JSON、字段缺失…） | 计入 fail |

`/api/health` 现在报 `degradedCount` 与 `unsupportedCount` 两个数。
实测结果：**`degraded=15` / `unsupported=229`** —— 229 个是配置问题，15 个是真失败。

**2）删掉 30 分钟失活**

`isSkipped()` 只剩两种：手动停用、环境不支持。**两者都不用时间窗**。

理由（每条都有实测数据）：
- 逻辑上自相矛盾（降级后不搜它，永远不可能复亮）
- 实测不需要它挡任何东西：270 站全量 2.14s，跳过降级（26 站）反而 2.70s，
  结果完全持平（36 条 / 11 源）。降级源平均 **0.025 秒**就失败（`ext` 为空，
  根本没发网络请求），留着不花钱
- 真慢源已由收尾策略消化：把 4 个 10~12 秒的慢源强制加入，
  搜索反而只要 **1.77 秒**
- 上游三家都不这么做：Fongmi 只有手动开关；影视仓 `SiteHealthStore`
  有健康分但**明确只排序、从不过滤**；CatVodSpider 完全没有健康概念

**3）健康分只排序不过滤**

```
score = 60 * (ok - fail) / (ok + fail + 4)     // 成功率，+4 平滑
      + min(lastCount, 20) * 1.2               // 能出结果的加分
      - min(lastCostMs, 8000) / 1000.0         // 慢的扣分（封顶 8 分）
```

沿用影视仓的公式。`lastCount` / `lastCostMs` 是新加的字段——影视仓的
`recordSearch(site, success, count, cost, error)` 本来就带 count，我们之前没有。
排序只影响提交顺序，不改变结果集。

**4）线程池改有界**

`Executors.newCachedThreadPool` → `ThreadPoolExecutor(32, 32, 队列 2048, AbortPolicy)`。
270 个源会一次性 submit，cached 池会同时创建 270 个线程（每线程约 0.5~1MB 栈），
TV 上瞬时几十到上百 MB。

**为什么不用 `CallerRunsPolicy`**：它会让聚合主线程去跑 spider 调用，
那段时间它本该做收尾判断，结果整个搜索被单个慢源卡住。被拒绝的任务
按"本轮没返回"处理（`RejectedExecutionException` → `continue`）。

**为什么不学 Fongmi 的 per-task timeout**：它的 `withTimeout` 从 **submit 时刻**
开始计时，线程池只有 20 个，站点超 20 时后面的任务还没跑就已经在倒计时。
我们用共享的 `searchDeadline` + 收尾判据，排队中的任务不会"还没开始就失败"。

#### 收尾：补上"全部返回即退出"

踩过：18 个快源最慢 0.90s 全部返回，但聚合耗时稳定在 4.2~5.0s。
原因是循环多进了一次——`returned` 已等于 `totalTargets`，但还会再 `poll`
一个 3.5 秒空闲窗口。加 `if (returned >= totalTargets) break;` 后消失。

#### 最终实测（5 轮，TV 网关）

| 关键词 | 中位耗时 | 区间 | 条目 | 源 |
|---|---|---|---|---|
| 我不是大师 | 4.47s | 1.7–6.8s | 34/36/35/36/35 | 9/11/10/11/10 |
| 庆余年第二季 | 2.48s | 1.9–5.8s | 21/24/24/21/24 | 7/8/8/7/8 |
| 繁花 | 2.71s | 1.9–6.0s | 158×5 | 12×5 |

#### 出结果逐步显示：改用「后台任务 + 轮询快照」（2026-10-29 已实现）

**分批请求的方案否掉了**（下面保留过程记录），改用更彻底的做法：

```
POST /api/search {async:true}   → 建后台任务，0.02s 返回 taskId
GET  /api/search/task/{id}      → 读快照，毫秒级
```

**为什么必须这么做**（实测数据）：`POST /api/search` 原来在**请求线程**里跑完整个
聚合（2~20 秒），而请求线程池只有 12 个（`POOL`，`ApiServer:277`）。
12 个并发搜索就把池占满，`/api/health` 的延迟从毫秒级涨到 **9.1 秒** ——
用户看到的是"整个应用崩了"。

改后同一场景：

| | 同步（改前） | 异步（改后） |
|---|---|---|
| 12 并发搜索时 `/api/health` | **9.1s** | **0.02s** |
| 搜索启动耗时 | 2~20s（阻塞） | **0.02s** |
| 首屏可见结果 | 4.5s | **0.78s（8 条）** |

**实测逐步显示的时间线**（TV 网关，关键词「我不是大师」，41 个源）：

| 时间 | 界面上看到 |
|---|---|
| 0.01s | 搜索中… |
| **0.78s** | **8 条**（可以开始点） |
| 1.29s | 27 条 |
| 2.31s | 32 条 |
| 2.86s | 34 条 |
| 3.85s | 35 条（完整） |

docker 形态同样生效（264 个源）：0.32s 出 1 条、2.16s 出 23 条。

**配套调整**：因为首屏不再需要"一次等够"，把 `SEARCH_MIN_MS` 从 8 秒降到 **3 秒**、
总预算从 20 秒放大到 **30 秒**（异步任务不占请求线程，放宽不拖累别的接口）。
用户从详情页返回后，任务还在跑，能看到更多结果。

**实现要点**：
- `SearchTask` 持有一个 `merged` map，聚合循环每收一个源就往里写（加锁）
- 轮询端点读同一份 map → "搜到一个源用户就能看到一个"
- 任务 5 分钟 TTL，`pruneSearchTasks()` 在建新任务时顺手清理
- 轮询路由**必须放在 `/api/{site}/{action}` 兜底之前**，否则被当成 site=search
- 不带 `async` 时仍走原来的同步路径（老客户端/自动化脚本继续可用）

**轮询周期 500ms** 是量出来的：首批结果 0.3~1.0 秒回来，3 秒轮询会错过
"边出边看"的最佳时机；300ms 请求量又多一半。

#### 试过并放弃：前端分批请求（保留过程记录）

用户问"搜索是不是收尾完成才显示"——**是的**。现状是单请求：后端聚合循环跑完才
返回整个 JSON，前端 `groups.value = r.groups` 一次赋值，期间只有一行"搜索中…"。

试过的方案：按健康分把站点切快/慢两批，第一批回来就渲染，第二批追加。
**实测后放弃**，因为数据不支持：

| 批 | 源数 | 耗时 | 条目 |
|---|---|---|---|
| 快批（健康分前 70%） | 29 | 2.24s | **35** |
| 慢批 | 12 | 0.22s | **0** |

慢批那 12 个是 `ext` 为空的死源（Push/WangPan/AppYsV2/Xlys…），0.22 秒返回 0 条。
**第一批已经拿到全部 35 条结果**，第二批没有任何增量贡献 —— 分批只多了一次
HTTP 往返和 0.3 秒延迟。

也试过按耗时阈值（500ms / 1000ms）切，同样失败：源耗时随负载大幅波动
（Bili 510→715ms、Gulu 未记录→3668ms），阈值切法会让第一批有时候**一条结果都没有**
（实测 t+7.19s 时 `found=-1`，唯一能出 20 条的 Bili 被划进了慢批）。

**结论**：在当前数据形态下（41 个可用源、能出结果的都很快），分批没有价值。
真正让搜索变慢的是**收尾预算**（`SEARCH_MIN_MS=8s`），不是数据到达顺序。

要真正做流式，只能改传输层（SSE / chunked），但：
- TV 网关的 `SocketHttpServer` 靠 `Content-Length` 一次性写出，注释明写"不需要 chunked"
- `platform.HttpExchange` 只有 9 个方法、两端实现都得同步改 ——
  正是我们花整轮消除的"一码两份"风险

**保留的改进**：`runSeq` 请求序号。连续点两次搜索、或第一批没回来就改关键词时，
旧响应仍会到达并覆盖新结果（实测表现为"搜索框是新词、列表是旧词的结果"）。

#### 六项收尾修复（2026-10-29 晚）

| # | 问题 | 改法 |
|---|---|---|
| 1 | `unsupported` 标记跨进程保留 | `load()` 时清空——它表达的是"上次这个环境不支持"，重启往往正是因为改了配置 |
| 2 | 搜索任务失败时误报成"没搜到" | 读 `snapshot.error`，分成"搜索失败"与"部分结果已返回但任务出错" |
| 3 | AI 工具层走同步搜索，占请求线程 5–8 秒 | 新增 `fetchSearchAllWait`（起异步任务 + 轮询到 done），`meowSearch` 改用它 |
| 4 | 同步路径没人调也没测 | 保留并加契约测试（老客户端/自动化脚本仍可用） |
| 5 | `Jiaozi` 慢空结果无标记 | 新增 `slowEmpty`（0 条 且 耗时 ≥5s），健康分里额外扣 10 分；**不降级**——它连得上 |
| 6 | **DoH 失败不回退系统 DNS** | `OkDns.lookup` 补回退：DoH 异常或返回空 → 落系统 DNS |
| 8 | 不知道"还有多少源在跑" | 前端显示 `已搜 N/M 个源` |

**第 6 项是这轮的重点，它推翻了之前的结论。** 原来 `dohEnabled()` 默认 `false`，
理由是"开 DoH 后 11 站全空"。真实根因不是 DoH 有害，而是：

```java
// 原来的一行
return (doh != null ? doh : Dns.SYSTEM).lookup(get(hostname));
```

有 DoH 就只用 DoH，它抛 `UnknownHostException` 直接向上抛 —— **一次解析失败 = 整站不可用**。
`okhttp-dnsoverhttps` 在该 ROM 上会被 reset，于是全部源一起挂。

补上回退后同一环境实测：

| | 改前 | 改后 |
|---|---|---|
| DoH 开启 | 11 站全空（0 条） | **3 轮均 36 条 / 11 源，中位 5.4s** |
| DoH 关闭 | 5/11 可用 | 同左 |

所以 **`dohEnabled()` 现在默认 `true`**：DoH 能用就绕开污染，不能用就退回系统 DNS，两头都不吃亏。

能力边界要说清楚：系统 DNS 本身是被污染的那个，回退只保证"没被污染的域名照常可用"，
绕开污染仍然依赖 DoH 真的可用。

#### 一个已知的"慢空结果"（已加标记）

`Jiaozi` 首轮 30.8s、之后 0.2s，返回 `{"list":[]}`。因为空结构记成功，
它 `ok=141 fail=0 degraded=false`——每次都可能卡 30 秒却没有任何机制标记它。
现在会在日志里留 `slow-empty Jiaozi 30800ms`，并把耗时记进健康表
（收尾预算按最慢源算，超预算就先返回）。**没做成降级**：它确实连得上、
也确实没结果，降级语义不对。

**没修的部分**：DoH。`LocalDns` 已把配置的 `hosts`/`doh` 表接到 `OkHttp.dns()`
（`hosts` 走 `OkDns.addAll`，不依赖 DoH 库），但 `okhttp-dnsoverhttps` 在该 ROM 上
**开了比不开更糟**：

| | AppGet | SaoHuo | SP360 | 结论 |
|---|---|---|---|---|
| 开 DoH | 0.1s n=0 | 0.1s n=0 | 0.9s n=0 | 11 站全空 |
| 关 DoH | 0.4s n=1 | 3.9s n=1 | 2.0s n=1 | 5/11 可用 |

bootstrap IP 补齐后无改善；页面内直接 fetch 阿里 DoH 是 200 —— 问题在库。
所以 `dohEnabled()` 默认返回 `false`，代码保留（换 ROM 可能是唯一解法，改一行就能开）。

---

### 10.6 搜索缓存、慢源跳过与"中途换词"（2026-10-30 落地，含插桩实测）

这一节回答两个反复被问到的问题，并记录一次**用 -javaagent 拿到的硬证据**。

#### 10.6.1 插桩实测：`cancel()` 对 jar 源的 HTTP 根本无效

之前一直假设"外层 8 秒超时 → `Future.cancel(true)` → 线程释放"。为了确认，
写了一个最小 agent（`tmp/2026-10-29-samesrc/probe/`，ASM 改写 `okhttp3.RealCall`），
只挂 `execute()` 入口记录，不改行为。

**结论一：jar 源的网络调用确实都走 OkHttp，没有绕过路径。**

静态扫描 883 个类的常量池 + 运行时插桩双向确认：

| 统计 | 值 |
|---|---|
| 引用 `okhttp3/*` 的类 | 38 个（其中 14 个含 `newCall`） |
| 引用 `HttpURLConnection` 的类 | 3 个（`AppDrama`/`AppDrama2`/`merge/f0/c`，非搜索主路径） |
| 同时混用两套栈的类 | **0 个** |
| `RealCall.execute()` 实跑次数（44 站一轮） | 96 次，来自 **25 个源类** |

`Bili` 这类"静态看零 OkHttp 引用"的源也在列表里（2 次调用）——
它的 HTTP 走 `merge/n/c.m(String, Map)` 这个中转，不在自己类里。

**结论二：8 秒超时后 Call 仍然活着，`cancel` 碰不到它。**

| 采样时刻 | 存活 Call | 存活 >8s |
|---|---|---|
| 搜索结束后 1s | 32 | 6~11 |
| 结束后 10s | 32 | 13 |
| 结束后 20s | 32 | 20 |

最长存活 **36.2 秒**，`canceled=false`。根因是 `java.net.Socket` 的阻塞读
**不检查中断标志**，而 spider 把 OkHttp 的 `readTimeout` 写死成 30 秒
（`merge/n/c` 与 `merge/q/d0` 里的 `ldc2_w 30l`）。

**所以：不做 `cancel()`。** 真正兜住并发的是
`SITE_TIMEOUT_POOL = effThreads + 8` —— 那 8 个位置专门容留
"已放弃但还没退出的残骸"。

> 插桩本身踩了三个坑，都记在 `CallInstrumenter.java` 里：
> ① `Class.forName("okhttp3.RealCall")` 必须在 `addTransformer` **之后**，
> 否则类提前加载、插桩永不触发（表现是"搜索真跑了但 enter=0"）；
> ② `COMPUTE_FRAMES` 会解析 okhttp 父类链，而 spider 用独立 ClassLoader，
> 抛 `TypeNotPresentException` 后 transformer 返回 null，**静默失效**；
> ③ 手写栈帧局部变量表对不上 → `VerifyError: Bad local variable type`，
> 后果是 44 个源 128ms 全返回、一个请求都没发出去。

#### 10.6.2 缓存写在 worker 里，不写在聚合循环里

**用户报的场景**：搜「我不是大师」跑到 4~5 秒时改搜「庆余年」，
再搜回「我不是大师」—— 缓存是否也生效？是否只能靠强刷才能完整？

**首次实现确实有这个缺陷**，而且是"永远补不上"的僵局：

1. 缓存原本写在聚合循环里，而循环会因 `epoch` 作废（换词）或
   `mostlyCached` 提前 `break`；
2. `break` 之后那些任务还在池里跑，但**没人 poll 它们的 Future** → 不写缓存；
3. 于是每轮都是「命中 80% + 真跑 20%」，那 20% 永远进不了缓存，
   下一轮命中率还是 80% —— 只能强刷。

两处修正：

| 改动 | 位置 | 效果 |
|---|---|---|
| 缓存写移到 `SITE_TIMEOUT_POOL.submit` 的 lambda 里 | `ApiServer.searchAll` | 与"是否被 poll"解耦，任务拿到 spider 返回就落缓存 |
| 冷源（未命中）优先提交 | 同上，submit 前重排 | 冷源在 `break` 之前跑完，命中率逐轮爬升 |

**实测（干净实例，148 源配置）**：

```
第1轮 打断 4.5s   sites=140 groups=35 cacheHits=0
第2轮 庆余年      sites=128 groups=20 elapsed=30.0s
第3轮 搜回        冷热重排 cold=228 warm=34  → sites=176 groups=36 cacheHits=34
第4轮 再搜        冷热重排 cold=54  warm=37  → sites=54  groups=36 cacheHits=37
```

缓存 34 → 37，冷源 228 → 54，**结果 35 → 36 且不需要强刷**。
第 4 轮仍真跑 54 个源，说明它还在继续补齐（不是僵在某个值）。

**空串不缓存**：那是超时/异常的返回值，不是源站的真实答复；
缓存了会在 3 分钟内让该源看起来一直"没结果"。

#### 10.6.3 慢源硬跳过必须带 TTL，否则是死锁

`isTimeoutSkipped` 的判据是"连续 2 次超时就本轮不提交"。问题在于：
**跳过之后就没有调用，也就没有"成功一次就清零"的机会** → 源站恢复了也回不来。

实测踩到：跑完一轮后参与源从 **161 掉到 39**，一小批慢站被永久拉黑。

修法是加 `TIMEOUT_SKIP_TTL_MS = 60s`：超时时间戳 + 60 秒后自动放行一次。
真恢复了就清零，还慢就再记两次超时重新拉黑。代价是每源每分钟多等一次 8 秒。

`lastTimeoutAt` 必须一起落盘（`site-health.json`），否则重启后
`timeoutStreak` 还在但没有基准时间 → 无限跳过。

#### 10.6.4 当前三个阈值

| 常量 | 值 | 作用 |
|---|---|---|
| `SITE_TIMEOUT_POOL` 上限 | `effThreads + 8` | 并发槽 + 残骸缓冲（原来是 96，与并发无关） |
| `TIMEOUT_SKIP_STREAK` / `_TTL_MS` | 2 次 / 60s | 慢源临时拉黑，到期自动放行 |
| `SCRIPT_RUNTIME_FAIL_THRESHOLD` | 1 次 | drpy 全局熔断（同容器 = 同故障域） |

---

**变更记录**

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-21 | 初版。基于 `refs/Fongmi-TV/` 源码实证（BaseLoader/JarLoader/ParseJob/VodConfig/Crypto）与实际 config schema |
| v2 | 2026-10-29 | §10.2 多形态搜索差异：根因确认为**设备时钟慢 592 分钟**导致签名类源静默失败，A/B 对照 11 源→5 源→10 源；`/api/health` 加 `now`、TV 壳时钟核对、搜索失败日志记站点名+cause |
| v3 | 2026-10-29 | §10.3 聚合搜索抖动（慢源被空闲收尾截掉 → 三条门槛 + 按历史耗时自适应预算）；§10.4 PanSearch 出口差异（订正：不是 CDN 风控，docker 走日本节点、TV 走北京移动）；★ 订正：跨形态对比必须先对齐版本 |
| v4 | 2026-10-29 | 新增 §10.5：源健康分类（`unsupported` 与 `degraded` 分开，实测 229 vs 15）+ 删 30 分钟失活（实测跳过不省时间：全量 2.14s vs 跳过 2.70s）+ 健康分只排序（借影视仓公式）+ 线程池改有界 + 收尾补"全部返回即退出"；★ 逐步显示试过后放弃（快批已含全部结果，慢批 0 条），保留 `runSeq` 防旧响应覆盖 |
| v5 | 2026-10-30 | 新增 §10.6：**-javaagent 插桩实测**（jar 源全部走 OkHttp，25 类 96 次；8 秒超时后仍有 11~20 个 Call 存活，最长 36s，`canceled=false` → **不做 `cancel()`**，改用池冗余 effThreads+8）；缓存写移到 worker + 冷源优先提交（修"中途换词后 20% 永远补不上"的僵局，实测 35→36 且不需强刷）；`isTimeoutSkipped` 加 60s TTL（修死锁：参与源 161→39） |
