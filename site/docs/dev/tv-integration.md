# TV 端接入

TV 有两条并存路线：**兼容上游**（Fongmi / TVBox 系客户端直接吃我们的 `/config.json`
+ spider jar，零改动）与**自研壳**（`client/apps/tv`，Android WebView 壳 +
内嵌网关，界面与网页版一致）。两者吃的是同一份后端出口，本文两条都写，
自研壳部分以 `client/apps/tv/app/src/main/java/` 为唯一事实来源。

| 关注点 | 代码 |
|---|---|
| 内嵌网关（复用 ApiServer）、进程隔离、32 位缓解 | `client/apps/tv/app/src/main/java/com/meow/tv/GatewayServer.java` |
| CatVod 配置与 spider jar 出口 | `server/host/src/shared/ApiServer.java`（`catVodConfigJson` / `sitesForCatVod`） |
| 端上 dex 加载器（对标 Fongmi JarLoader） | `client/apps/tv/app/src/main/java/com/meow/tv/LocalSpiderHost.java` |
| 端上站点表与导入收敛 | `client/apps/tv/app/src/main/java/com/meow/tv/LocalSites.java` |
| WebView 壳、遥控导航、JS 桥、时钟校准 | `client/apps/tv/app/src/main/java/com/meow/tv/MainActivity.java` / `TvBridge.java` |
| 签名与打包 | `client/apps/tv/app/build.gradle` / `build-apk.ps1` / `.github/workflows/_tv.yml` |

配置/弹幕/搜索在三端共享的行为，见 [架构](./architecture.md)、[弹幕](./danmaku.md)、
[播放](./playback.md)；插件侧 jar 形态见 [插件系统](./plugin-system.md)。

---

## 一、两条路线

| | 用谁 | 我们做什么 |
|---|---|---|
| **兼容上游** | 官方 Fongmi / TVBox / 影视仓 | 只维护 `/config.json` + `/spider-latest.jar`，**不 fork 官方 Fongmi**（它是我们配置的消费者，保持兼容即分发渠道） |
| **自研壳** | `client/apps/tv` | WebView 加载自研 Web 前端 + 内嵌网关 + 端上 dex 执行；UI 与 Web 同源即对齐 |

### 1.1 自研壳概况

- 形态：Android WebView 壳，内置前端经本地服务以 `http://meow.local` 提供
  （`MainActivity` 深链与 JS 桥 origin 白名单都锚在这个 host，
  `MainActivity.java:288/933`）
- 遥控：注入 `tv-nav.js`（`MainActivity.java:571`），方向键做几何最近邻选焦、
  确认键点击——WebView 默认只认 Tab 遍历
- 构建：`minSdk 26` / `targetSdk 34` / `compileSdk 34`（`app/build.gradle:63-64`；
  抬到 26 是因为更低的设备进网关就 `NoClassDefFoundError`）；
  播放用 `androidx.media3-exoplayer:1.4.1` + hls/ui/datasource-okhttp，
  OkHttp **固定 4.12.0**（5.x 要求 compileSdk 37，升 AGP/compileSdk 会拖累整个 TV 工程，
  `app/build.gradle:143-146`）
- 设置页：`SetupActivity`——局域网扫描（本机网段 + 常用家用网段，约 5–12 秒）、
  手机扫码推送、连接校验、远程调试（**默认关**，局域网 PC 验收用）
- 换后端：`adb shell am start -n com.meow.tv/.MainActivity --es url http://192.168.1.2:30010`；
  深链 `am start -a VIEW -d 'http://meow.local/index.html#/play/…'` 也能直达播放页
  （intent 的 `#/play/...` 会拼进 loadUrl，`MainActivity.java:925-939`）
- 更新：`AppUpdater` 原生下载/校验/交系统安装器（不走 JS 桥传整包——11MB apk
  base64 后约 15MB 字符串，`AppUpdater.java:32`）

### 1.2 架构

```
后端（docker / PC 插件 / NAS）
  ──/config.json（CatVod 形状 + spider;md5）──> Fongmi / TVBox / 自研壳
  ──/spider-latest.jar（dex，ETag/304）──────┘

自研壳（一个 APK，最多三个进程）：
  主进程    WebView UI（meow.local）+ tv-nav.js + TvBridge
  :spider   GatewayServer = 同一份 ApiServer + LocalSpiderHost(dex)   ← 32 位默认隔离
  :node     NodeService = node 运行时模块（danmu_api，端口探测）      ← 装了模块才有
```

**客户端是完整的宿主**：dex 加载、parse、proxy 都在端上，我们只要给它
"配置 + jar"两样东西。

---

## 二、后端给 TV 的两样东西（CatVod 出口）

### 2.1 `GET /config.json`

`catVodConfigJson`（`ApiServer.java:11536-11557`）输出 CatVod 形状：

- `spider`：`{base}/spider-latest.jar;md5;{md5}`；**拿不到 jar 就不写 md5**——
  空 md5 让客户端走"总是下载"，比写个错的稳
- `sites`：`sitesForCatVod` 转换（`ApiServer.java:11588-11620`）：
  - `type` 用配置原值不硬编码 3——写成 3 会让 TV 端按 `csp_` 类名去 jar 里找类，
    苹果 CMS 直连站（api 是 http 地址）直接整站消失
  - `ext` 原样透传（可能是字符串也可能是对象，转 String 会破坏 `{"json":...}` 结构）
  - `searchable` / `filterable` / `changeable` / `playerType` / `timeout` / `jar` /
    `style` 可选字段透传（丢了表现为"能进站点但搜不到 / 筛选栏空"）
  - `csp_` 站点没写 `jar` 时补 `./spider-latest.jar`（相对路径，客户端按配置地址补全；
    写死绝对地址会在"外网域名 / 内网 IP 访问同一后端"时指错主机）。不补的话
    自研壳导入结果是 `已导入 0/235 站`——LocalSites 只收"配了 jar"的站点
- `parses` / `lives` / `rules` / `ads` / `proxy` / `hosts` / `doh` / `headers`：
  原样透传，表缺席输出**空数组**——TV 端拿到空 parses/ads 仍能播，报错就整份配置加载失败

### 2.2 `GET /spider-latest.jar`

- **必须 dex 形态**（ZIP 里有 `classes.dex`）。判据是读中央目录，不是看文件名——
  仓库 `libs/spider.jar` 是 883 个 `.class` 的 JVM jar，发给 Android 一律
  「jar 里没有类 Xxx」。实测：TV 能导入 39/40 站但每次 play 都失败，换成 dex 后同一批站立刻可用
  （`ApiServer.java:11440-11455`）
- 候选顺序：`spider-complete-latest-patched.jar` → `spider-complete-latest.jar` →
  `spider-latest-patched.jar` → … → classpath 那份（PC 插件仍需要 class 版）
- `ETag` = md5（**带引号**，RFC 7232 要求），命中 `If-None-Match` 回 304 +
  `Cache-Control: public, max-age=0, must-revalidate`（`ApiServer.java:11627-11646`）

```
GET /spider-latest.jar
  → 200, ETag: "<md5>", Content-Type: application/java-archive
GET /spider-latest.jar   (If-None-Match: "<md5>")
  → 304, 无响应体
```
- md5 以「文件最新修改时间 + 长度」为 key 现算缓存（`ApiServer.java:11409-11419`）：
  一致才复用缓存、不一致重新下载——jar 换了缓存必须失效，否则用户永远停在旧 jar

### 2.3 `spiderJvm`：JVM 端优先读的字段

一份配置同时给 TV 和 JVM 用时，顶层 `spider` 必须是 **dex** 形态（Fongmi 系只认它）；
JVM 端优先读自定义字段 `spiderJvm`（class 形态），没有才回退 `spider`
（`server/host/src/shared/core/Jars.java:139-144`）。

| 端 | 读哪个字段 | 说明 |
|---|---|---|
| Fongmi / TVBox / 自研壳 | `spider` | 不认识 `spiderJvm`，当作未知字段忽略 |
| 猫窝 JVM（Web/PC） | 优先 `spiderJvm` | 没有才回退 `spider` |

站点内顺序如果写反（顶层 `spider` 指向 class jar），TV 会直接 `DexClassLoader`
失败且不会回退——它没有第二个字段可读。

### 2.4 地址按请求 Host 生成

`baseUrlFor`（`ApiServer.java:8858`）按请求的 `Host` 头（其次 `X-Forwarded-Host`）
生成 `spider` 等字段里的基地址。模拟器里用 `10.0.2.2:9979` 访问时，配置里的
jar 地址自动变成 `http://10.0.2.2:9979/spider-latest.jar;md5;…`——不需要额外配置。
用 `curl` 验证时要显式 `-H 'Host: 10.0.2.2:9979'`，否则看到的是 `127.0.0.1`，那是正常的。

> 曾计划过的 `/config-upstream.json`、`/depot.json` 没有实现，现行出口只有
> `/config.json` 与 `/spider-latest.jar`；多仓/导入走 `/api/config/import`、
> `/api/config/depot`（`ApiServer.java:1250-1256`）。

### 2.5 一条站点的最小形状

```json
{
  "key": "干饭", "name": "干饭", "type": 3,
  "api": "csp_AppDrama2", "ext": "com.juechufsh.android.xpg1",
  "searchable": 1, "changeable": 1, "timeout": 20
}
```

后端输出时 `csp_` 站会自动补 `"jar": "./spider-latest.jar"`（2.1）。

### 2.6 八张透传表的语义

全部原样透传，这里只记"改配置前要知道"的语义（示例值仅示意）：

| 表 | 语义 | 注意 |
|---|---|---|
| `sites[].api` | `csp_` 前缀 = 走 jar 里的类；http 直连 = 苹果 CMS | 少了 `csp_` 客户端静默退化（拿不到内容但不报错）；`key` 必须唯一（同 api 多 ext 要多 key） |
| `parses[]` | 网页解析器。`type`：0=WebView 嗅探（TV 端可行，服务端不可行）、1=GET `parseUrl+url`（后端 `/api/parse` 实现的就是这个）、2/3=jar 的 `Json*`/`Mix*`、4=超级解析（并发） | `ext.flag` 限定该解析器只对哪些线路标识生效，**必须原样透传**，否则 TV 端用错解析器 |
| `lives[]` | 直播：`type: 3` 走 spider（要 jar 里有 Live 类），`type: 0` 纯 M3U；`epg`/`ua`/`timeout`/`playerType` 可选 | |
| `rules[]` | HLS 分片广告过滤：m3u8 的 host **包含** `hosts[]` 任一项（子串匹配，`"lz"` 会匹配 `hd.lz.xxx.com`）时，用 `regex[]` 从清单删片段 | |
| `ads[]` | 整域屏蔽：请求命中这些域直接拒绝 | 多个源的 `ads` 高度重合，是行业共享库，可直接合并 |
| `proxy[]` | 命中（支持正则如 `.*nivod.*`）的请求**强制走客户端代理** | TV 端由客户端自己代理，Web/PC 端由后端代理，两边读同一份表行为才一致 |
| `hosts[]` | DNS 改写：`<原域名>=<替换域名>`，用于限区域源改 CDN 域名、绕污染 | 是**域名改写不是代理**，请求仍直连 |
| `doh[]` | DoH 服务及其**引导 IP**（避免"解析 DoH 域名本身需要 DNS"的循环） | TV 端从这张表挑国内可达的提供商（`LocalDns`），全是国外服务时改用内置国内源 |
| `headers[]` | 请求该 `host` 时附加指定头 | 某些源校验特定 UA |

> `wallpaper` / `logo` / `danmaku` / `notice` 等可选字段缺失不影响加载——
> 上游客户端对缺失字段返回空而不是报错（上游源码参照，不在本仓库）。

---

## 三、自研壳的配置消费路径

### 3.1 两套站点表，各管一半

| 表 | 存哪 | 管什么 | 谁读 |
|---|---|---|---|
| 网关表 `gateway/config.sites.json` | `filesDir/gateway/` | drpy / CMS / jar 全部站点 | 内嵌 ApiServer 的 `loadConfigSites()` |
| 端上表 `LocalSites` | SharedPreferences `meow_tv_sites` | **只收 `api` 是 `csp_` 且配了 jar** 的子集（本地 dex 能执行的） | `LocalSpiderHost` |

为什么端上要单独一份：后端在别的机器上（甚至不存在），它的站点表 TV 读不到；
端上执行是 TV 独有能力，能执行的子集必须端上维护（`LocalSites.java:19-30`）。

### 3.2 消费路径总览

```
一份 CatVod 配置（后端 /config.json 或外部地址）
  ├─ 网关侧：POST /api/config/import → 写 gateway/config.sites.json
  │     └─ Bridge.notifyConfigImported → 壳侧同步端上表 + LocalSpiderHost.clear
  ├─ 端上侧：meowTv.importLocalConfig → LocalSites.importFrom（只收 csp_+jar）
  │     └─ syncGatewayConfig 反向并进网关表
  ├─ LocalDns.apply：hosts/doh 立即生效（spider 首个请求可能紧跟导入）
  └─ 站点调用：/api/{key}/{action} → ApiServer → LocalSpiderHost.spider()
        → prepare(jar) → DexClassLoader → com.github.catvod.spider.<cls>
```

### 3.3 导入必须收敛到两边

两个入口、两个方向，缺一半就是"导入成功但站点空 / 站点在但一调 ClassNotFound"：

- **网关导入**（`POST /api/config/import`）：ApiServer 写网关表后调
  `Bridge.notifyConfigImported`（`ApiServer.java:12751`）→ 壳侧钩子
  （`GatewayServer.startInProcess` 里注册）→ `LocalSites.importFrom` +
  **`LocalSpiderHost.clear`**（jar 地址可能换了，不清就是"导入成功但跑的还是旧实现"，
  且同类对象在 ART 非移动区再叠一份）。替换模式先 `clearAll`
- **端上导入**（`meowTv.importLocalConfig`）：`LocalSites.syncGatewayConfig`
  反向并进网关表（按 key 合并、同 key 以新导入为准、其余表不动）

### 3.4 jar 字段的读取顺序

`LocalSites.importFrom`（`LocalSites.java:120-202`）：

- **顶层** jar：先 `spider` 再 `jar`。踩过：只读 `jar` 时，拿肥猫真实配置实测
  **0/38 全跳过**（每站被判"没有 jar"）；CatVod 标准顶层字段叫 `spider`，
  外部配置以它为准
- **站点级**：先 `jar` 再 `spider`，都没有才用顶层（站点级写 `jar` 是 CatVod 原生写法）
- `;md5;` 三段在这里拆开（`LocalSpiderHost.splitMd5`），相对 jar 路径按配置地址
  `absolutize` 补全（配置里常见 `./jar/spider.jar`）
- `ext` 可能是对象也可能是字符串，统一 `String.valueOf` 给 spider
- `hosts` / `doh` 表在导入时立即应用到 `LocalDns`——spider 的第一次请求可能
  紧跟着导入发生，晚一步就是一次"搜不到"

### 3.5 DNS 与弹幕接线

- `LocalDns.apply / applyStored`：把配置的 `hosts` / `doh` 表接进 catvod 的
  `OkHttp.dns()`。网关每次启动都要重放一次——`OkHttp.dns()` 是静态单例，
  进程重启后回到"只有系统 DNS"（`GatewayServer.java:598`）。配置文件变了
  `refreshIfChanged` 按文件长度自动重放
- 弹幕两条路：
  - **远端后端模式**：`ensureDanmakuApi` 把 `policy.json` 的 `danmakuApi` 写成
    `{后端}/api/proxy/danmaku?name={name}&episode={episode}`（`GatewayServer.java:901-954`）
  - **本机网关模式**：跳过上面那条，用内置 node 模块里的 danmu_api——
    `Bridge.installDanmakuHost` 的钩子**每次现查**状态文件（模块端口是探出来的，
    19341 被占顺延；崩溃重启也可能换端口，缓存住就是"模块在跑、弹幕不出来"）

---

## 四、加载器（LocalSpiderHost）

对标 Fongmi 的 JarLoader，**不复用其代码但完全照它的契约**（`LocalSpiderHost.java:22-42`）。

### 4.1 `;md5;` 语义与下载

- `url;md5;hash` 用 `indexOf(";md5;")` 拆三段（URL 里可能有 `?`/`&`，不用正则）；
  没有 md5 段 = 不校验
- 缓存命中且 md5 一致不重复下载；**md5 不一致删掉缓存文件**（避免下次又用坏包），
  下次自然重下——效果与 Fongmi 的"重下"一致但不死循环
- 下载：`HttpURLConnection`，连接 15s / 读 30s，UA `meow-tv`，先写 `.tmp` 再
  rename（下到一半被杀不留半个 jar）
- 缓存文件名用 **url hash**（`jar-<hex>.jar`）：不同站点可能都叫 spider.jar，
  用原名会互相覆盖——这个坑在 PC 插件源缓存上踩过同款

### 4.2 Android 10+ 的硬约束

- jar 必须放 **`codeCacheDir/spider-jars/`**，不能放 filesDir：
  `SecurityException: Writable dex file ... is not allowed`（实测踩过）
- 加载前必须 `jar.setReadOnly()`，`canWrite()` 还为 true 就报错——
  这是防代码注入的系统硬限制，唯一办法是 chmod 444，**不设只读一定失败**
- dex 优化目录 `codeCacheDir/spider-opt`

### 4.3 类加载与实例化

- 类名约定 `com.github.catvod.spider.<api 去掉 csp_ 前缀>`；不是 `Spider` 子类、
  类不存在、构造失败都返回可读错误（`InvocationTargetException` 解包 cause）
- `init(ctx, ext)` 失败不放弃：有些 spider 的 init 只做可选配置，不 init 也能跑
  home，真跑不了会在调用时抛
- **`seedJarInit` 必须做**：反射调 jar 内 `Init.get()` 单例、往其字段 `c` 塞
  Application。不做的后果是**整进程崩溃**而不是"某站不可用"——肥猫 jar 在自己的
  线程池里跑 `WangPan`，那条路径读 `Init.context()`，为 null 时 `<clinit>` NPE
  会直接杀进程（实测堆栈见 `LocalSpiderHost.java:404-421`）。字段名在 dex 里且被
  混淆，只能反射；拿不到就只记录不改主流程
- 同内容去重：md5 相同的 jar 复用同一个 `DexClassLoader`（配置里同 jar 换 URL、
  或 bundled 与配置 jar 内容相同时，不复用会让同一批类在 ART 非移动区各存一份）

`call()` 把动作映射到 `Spider` 实例方法（与后端 `/api/{site}/{action}` 同形）：

| action | 调用 |
|---|---|
| `home` | `homeContent(true)` |
| `category` | `categoryContent(id, page, true, {})` |
| `detail` | `detailContent([id])` |
| `search` | `searchContent(wd, true, page)` |
| `play` | `playerContent(flag, id, [])` |
| `live` | `liveContent(url)` |

### 4.4 内置 jar 与零配置

- `assets/spider.jar`（≥1024B 才算拷成功）+ `assets/spider-ext.jar`（≥512B，
  独立一个包方便"删文件即下线"）落 `codeCacheDir` 后走同一条加载链
- `addBundled` 预置三个不依赖 ext 的站：豆瓣 / 豆瓣预告 / 配置中心（`csp_Douban` /
  `csp_YGP` / `csp_Config`）——够验证"jar 能加载 + 能出数据"这条链路
- **踩坑**：内置 jar 传进来的是绝对路径，走 `new URL()` 必然失败，表现为
  "启用本机执行成功、内置站点也在表里，一调就报 jar 下载失败"——本地文件
  （`file:` 前缀或已存在的绝对路径）直接当源文件拷贝

### 4.5 Bridge 钩子：同一份 ApiServer 跑两端

`server/host/src/shared/platform/Bridge.java` 是两端差异的唯一注入点：

| 钩子 | JVM 端 | TV 端 |
|---|---|---|
| `ContextProvider` | 反射造 stub | `appCtx`（spider `init` 用；反射造真 Context 必然 `InstantiationException`） |
| `Logger` | stdout | logcat + `core.LogBuffer` |
| `ClassLoaderHook` | 类路径 `Class.forName` | `LocalSpiderHost.loadClassFromJars`（先 app 类路径——39 个内联 catvod 基类在宿主 APK 里；再遍历所有 dex loader，首个请求时顺手把没准备的 jar 补齐） |
| `DanmakuHostProvider` | 不装（走环境变量与 policy） | 内置 node 模块的 danmu_api |
| `ConfigImportHook` | 不装（空操作） | 同步端上表 + 清 loader |

**`installClassLoaderIfAbsent` 必须是"先装先生效"**：JVM 与 TV 跑同一份 ApiServer，
强制覆盖会让后启动的一方顶掉另一方——TV 上被顶掉就是所有 jar 站点
ClassNotFound，且不报错、只是空。parser 类（`/api/parse` 的 type 2/3，`Json*`/`Mix*`）
与 spider 在同一个 dex 里，走同一个钩子（`ApiServer.java:4792/4821`）。

---

## 五、网关进程与 32 位设备

### 5.1 启动顺序（`GatewayServer.startInProcess`）

顺序有讲究，任何一步提前都会拿到空配置：

1. `replayGcProbeLog`（上一个进程留下的 GC 时间线读回内存日志）
2. 定数据目录 `filesDir/gateway` 并设 `--data-dir`（**必须在第一次碰 ApiServer 之前**，
   它的静态初始化会读）
3. 装 Bridge 钩子（Context / Logger / ClassLoader / ConfigImport / DanmakuHost）
4. `syncConfigFile`（SharedPreferences 端上表 → `gateway/config.sites.json` 落盘）
5. `LocalDns.applyStored` → `LocalSites.load` → `LocalSpiderHost.seedInitNow`
6. 反射 `ApiServer.boot()`（ApiServer 在默认包，具名包不能 import，只能反射；
   顺带把静态初始化推迟到 data-dir 设好之后）→ `listen("127.0.0.1", 9978, 24)`

**端口必须先开、预热一律异步**：同步预热实测要 94 秒（30 个站各等 3 秒 init
超时），期间端口不监听；且预热并不能避免崩溃。崩溃靠看护拉回（冷启动到端口
可连实测约 2 秒）。

**连接线程 24 而不是 12**：实测 12 个连接线程下连续两次全量聚合搜索就会把网关
打死（连接线程要等 handler 返回才释放，同步搜索一次 20–30 秒，前端还在轮询）。

**网关端口固定 9978**：与 jar 内 `Proxy.a()` 的握手约定一致——它扫 9978..9999
找本服务。**端口越界（<9978 或 >9999）会让 jar 源的代理地址退化成 `127.0.0.1:-1`**。

### 5.2 进程隔离（32 位默认开启）

- `GatewayService` 跑在 `android:process=":spider"`：主进程 = UI + WebView（不跑
  spider，崩不了）；服务进程 = 纯 Java + jar，崩了由系统 `START_STICKY` 重建 +
  `gwKeeper` 兜底（退避表 `GW_RETRY_BACKOFF` = 3/6/12/20s，表用完仍按最后一档
  持续重试不放弃，`MainActivity.java:969`；上一版 5/15/45/120s 已废弃——端口先开后
  冷启动只要几秒，45/120s 纯属惩罚用户）。跨进程唯一通道
  就是网关自己的 HTTP，探活判据用"127.0.0.1:9978 能连上"，不能用静态标记
- `isolateMode()`：32 位默认 true，`setprop debug.meow.iso 1/0` 强制切换
- 导入配置后必须 `GatewayServer.restart`（旧 loader / 旧站点表会一直生效）；
  进程内 `start()` 看到 `started` 直接 return——踩过"提示已重启实际什么都没重启"

### 5.3 32 位 ART 缺陷与缓解清单

背景：部分 32 位设备（实测极米 Z6X Pro / Android 9 / armeabi-v7a）的并发拷贝 GC
在标记非移动区时判对象图不一致，`HeapTaskDaemon` 直接 SIGABRT——不是 Java 异常，
应用层捕获不到（`Thread.setDefaultUncaughtExceptionHandler` 从未触发），只能从
tombstone 与自记时间线取证。定性结论来自一组变量控制（同 APK、同一份配置）：

| 实验 | 结果 | 排除了 |
|---|---|---|
| x86_64 模拟器 vs 投影仪，同配置同轮次 | 模拟器全成 / 投影仪第 1 轮必崩 | 配置、源站、代码逻辑 |
| 换上游官方 jar | 投影仪仍崩 | 我们的 jar 与 spider 实现 |
| 投影仪壳连远端后端（spider 不在设备上跑） | 全成 | 设备网络、WebView、进程健康 |
| 单站连调 40 次 / 并发压到 4 | 全成 / 仍崩 | 调用量、并发是唯一诱因 |
| 只加载类不发请求 vs 加载 14 类后开始搜索 | 存活 / 秒崩 | 类加载单独不致病 |
| 8 份 tombstone 全是 `com.meow.tv`，上游客户端一份没有 | — | 设备普遍性缺陷 |

**"已加载的 dex 类" + "活跃的网络/JSON 对象"同时存在时必崩**，只有其中一样正常。
实测稳定边界（单轮同时活跃源数）：3 源全成、6 源全成、10 源崩。

| 手段 | 现状 | 说明 |
|---|---|---|
| 进程隔离 `:spider` | **默认开** | 上面 5.2；崩溃只崩子进程 |
| `relaxHeapLimit`（`clearGrowthLimit`） | 默认开（`debug.meow.growlimit=1`） | 该 ROM 没对 largeHeap 调它，growth limit 被压在 4MB，每分配几 MB 就 GC 一次（实测搜索期 100 秒 34 次） |
| 常驻配重 ballast | 默认 32MB（`debug.meow.ballast`） | 实测只降低 GC 次数、**不降低 abort 概率**（abort 跟标记的总对象量挂钩），只把代价挪到单轮变慢 |
| 启动期主动 GC | 默认关（`debug.meow.pregc`） | 实测它的 24MB 配重反而制造一串 GC |
| GC 闸门 `meow.gcgate` | 默认关 | 42 站 × 10 轮实测有无收益持平 |
| 搜索总预算压到 18s | 32 位自动 | `System.setProperty("meow.searchTimeout","18000")`，**必须在 `Class.forName("ApiServer")` 之前设**（static final 在类加载时读）；设备 `:spider` 存活约 2–3 分钟，按时交出已有结果 |
| 搜索并发封顶 | 32 位走单级执行 | 不套第二层池，避免对象跨线程同时进两个线程的本地标记栈 |

64 位设备完全不受影响：region space 从 4GB 起，全部缓解分支都不进，行为与普通
JVM 一致。

### 5.4 排查通道（部分设备 logcat 不可用时）

- `filesDir/crash.log`：未捕获异常 + 网关启动失败，留最近 64KB，经网关
  `/api/logs` 取——只依赖"应用能写自己目录"，所有设备成立
- `filesDir/gc.log`（`debug.meow.gcprobe 1`）：GC 次数 / AMS importance / 堆用量
  时间线，进程死了文件还在，下一进程启动时读回 `LogBuffer`
- 端上调试开关统一走 `adb shell setprop debug.meow.xxx`（`LocalSpiderHost.dbg` /
  `propInt`）：真机 bisect 时不同取值在**同一个包**里切，否则每换一个假设都要重
  构建重跑，而 32 位崩溃只有概率性复现

排查命令速查：

```bash
# 取崩溃/GC 时间线（logcat 不可用的设备）
adb shell run-as com.meow.tv cat files/crash.log
adb shell run-as com.meow.tv cat files/gc.log          # 需 debug.meow.gcprobe 1
# 调试开关（同一包内 bisect）
adb shell setprop debug.meow.iso 0        # 强制进程内网关
adb shell setprop debug.meow.gcprobe 1    # GC 时间线
adb shell setprop debug.meow.ballast 32   # 常驻配重
adb shell setprop debug.meow.warm 2       # 预热模式（真机 A/B）
adb logcat --pid=$(adb shell pidof com.meow.tv)
```

---

## 六、搜索在 TV 网关上的行为

TV 内嵌网关跑的就是共享的 `ApiServer`，搜索行为与 [架构](./architecture.md)
描述一致；这里只列 TV 上最容易踩的差量。以下常量以
`server/host/src/shared/ApiServer.java` 与 `routes/HealthRoutes.java` 现值为准。

| 常量 | 现值 | 说明 |
|---|---|---|
| `SEARCH_IDLE_MS` | 3500ms | 空闲收尾窗口（早期 2500 已调大） |
| `SEARCH_MIN_MS` | 按堆自适应（3s 起） | 低堆设备（`Runtime.maxMemory()` 小）自动放宽——极米上 3 秒就收尾等于只收到最快 1–2 个源 |
| 收尾预算 | `min(10s, max(SEARCH_MIN_MS, slowest + SEARCH_IDLE_MS))` | 按站表已知最慢源自适应；慢源历史耗时只在**成功**时写入（失败写会把预算拉歪） |
| `SITE_TIMEOUT_POOL` | `effThreads + 8` | 冗余 8 个槽位专门容留"已放弃但未退出的残骸" |
| `TIMEOUT_SKIP_STREAK` / TTL | 2 次 / **10 分钟** | 连续 2 次超时拉黑，TTL 到期自动放行一次（早期 60s 已放宽）；TTL 必须落盘，否则重启后 streak 在、基准时间没了 → 无限跳过 |
| `SCRIPT_RUNTIME_FAIL_THRESHOLD` | 1 次 | drpy 全局熔断（同容器 = 同故障域） |
| 健康分类 | 六类 | `UNSUPPORTED / TIMEOUT / DNS / TLS / CANCEL / ERROR`（`HealthRoutes.java:200`）；UNSUPPORTED 跳过且**不计入 fail**，`/api/health` 分开报 `degraded` 与 `unsupported` |
| 源状态语义 | 四种 | `unsupported`（环境不支持，长期跳过）、`timeout 拉黑`（上面 streak/TTL）、`degraded`（滑动窗口 16 次里 fail streak ≥ `HEALTH_DEGRADE_STREAK=3` 自动降级，**30 分钟窗口后自动给一次机会**；与 disabled 分开存——disabled 是用户意图，只有手动"恢复"才消失）、`slowEmpty`（0 条且耗时 ≥5s，健康分扣分但不降级——它连得上） |

### 6.1 异步搜索任务

`POST /api/search {async:true}` 建后台任务立刻返回 taskId →
`GET /api/search/task/{id}` 轮询快照（`ApiServer.java:1331-1356`）。为什么必须异步：
同步路径在**请求线程**里跑完整个聚合（2~20 秒），12 并发搜索就把 12 线程的
`POOL`（`ApiServer.java:372`）占满，`/api/health` 延迟涨到秒级——用户看到的是
"整个应用崩了"；异步化后同一场景毫秒级返回，首屏结果由轮询在 1 秒内带出。

- 任务保留：**最少 60 秒、最多 3 个**（低内存设备上个数比 TTL 重要——极米上
  5 分钟 TTL 连续搜索会把堆顶爆，`ApiServer.java:4970-4984`）
- 轮询路由必须注册在 `/api/{site}/{action}` 兜底**之前**，否则被当成 site=search
- 不带 `async` 仍走同步路径（老客户端 / 自动化脚本可用）
- 缓存写在 worker 的 lambda 里、**空串不缓存**（那是超时/异常返回值，不是源站答复）、
  冷源（未命中缓存）优先提交——否则"中途换词再换回来"永远补不齐缓存
- **不做 `cancel()`**（插桩实测）：`Future.cancel(true)` 只是 interrupt，OkHttp 同步
  `execute()` 阻塞在 socket 读上、Java Socket 不检查中断标志，spider 又把
  readTimeout 写死 30 秒——8 秒超时后 Call 仍存活最长 36s。并发由池冗余兜住

### 6.2 跨形态对比的三个坑（量出来的结论先过这三关）

四个常用形态——① docker@本机（基准）、② PC 插件@本机（排除容器因素）、
③ TV 网关@设备（被测对象）、④ TV→远端后端（对照组：TV 只当客户端，
分离"设备环境"与"网络出口"）。④ 是关键——它让"电视的 IP 被源站拦"和
"电视自己的运行环境有问题"变成可以分开验证的两件事。

- **版本必须一致**：四个形态（docker@本机 / PC 插件 / TV 网关 / TV→远端后端）跑的
  代码版本不同时，量到的是版本差不是能力差。第一轮四形态对比的"TV 最差"结论
  因此全部作废；用 `Dockerfile.apiserver` 现场构建同版本镜像、共用同一份配置后，
  TV 网关与 docker 持平甚至更全。跨形态比搜索前先对齐 `/api/health` 的 `version`
- **降级/unsupported 状态不一致**：docker 与 TV 的站点表规模、出口、运行时都不同，
  `degraded`/`unsupported` 集合天然不同（实测 docker 270 源里 244 unsupported，
  几乎全是 `jsRuntime 未配置`——TV 上没接 Node 运行时），降级源在后续搜索里被
  跳过，于是"同一关键词两次结果不同"。对比前先对齐这个状态
- **出口 IP 差异**：TV 与宿主同网关也会被运营商 CGNAT 分到不同出口，同一源站
  处置不同（实测 `pansearch.me` 对 TV 出口 TLS 握手被重置、docker 出口 200）。
  应用层能做的是失败要快、失败要可见；换代理属用户网络环境，应用不替用户改

### 6.3 设备时钟校准

签名类源（Jpys / Gulu / Gz360 / MiSou 等）把 `System.currentTimeMillis()` 编进
签名，TV 网关的 spider 跑在设备上用**设备时钟**——设备时间错了这些源会静默
搜不到（实测慢 10 小时：11 源 → 5 源）。三件套：

1. `/api/health` 带 `now`（服务器毫秒时间），客户端算偏移不用额外端点
2. 壳侧 `TvBridge.checkClockSkew`：拉 health 算 `mid - server`，超 **5 分钟**写
   可读告警（`TvBridge.java:1363-1410`）。**指向本机网关时跳过**——同进程里
   `now` 就是设备自己的时钟，skew 恒为 0，比较无意义；探测要等网关端口可连之后
   再做（`core.LogBuffer` 是 `ApiServer.boot()` 里初始化的，早于它写入的告警
   在 `/api/logs` 里查不到）
3. 搜索失败日志记**站点名 + 最内层 cause**（`2-arg failed Jpys: JSONException —
   No value for data`）。这条是定位全部时钟/出口问题的前提——只记
   `InvocationTargetException` 的 TV 日志几十条一模一样等于没记

### 6.4 与设备环境相关、应用层无解的两类

- **出口 IP 差异**：TV 与宿主同网关也会被运营商 CGNAT 分到不同出口，同一源站
  处置不同（实测 `pansearch.me` 对 TV 出口 TLS 握手被重置、docker 出口 200；
  502 正文是 `Connection reset`，是 TLS 建连被中间设备切断，不是 HTTP 层 403）。
  应用层能做的是失败要快（0.3 秒内抛错不拖累聚合）、失败要可见（6.3 的日志格式）；
  换代理属用户网络环境，应用不替用户改
- **DoH**：`LocalDns.dohEnabled()` 现在默认 `true`（`LocalDns.java:87-89`），
  依赖 `OkDns.lookup` 的回退——DoH 异常或返回空就落系统 DNS
  （`OkDns.java:79-92`）。历史版本"有 DoH 就只用 DoH"，一次解析失败 = 整站不可用，
  已修；回退只保证"没被污染的域名照常可用"，绕开污染仍依赖 DoH 真的可用

---

## 七、端上配套组件

| 组件 | 作用 | 关键约束 |
|---|---|---|
| `SetupActivity` | 连接设置：局域网扫描 / 扫码推送 / 校验 / 远程调试 | 远程调试默认关 |
| `LanScan` / `PushServer` | 找局域网里跑着的猫窝后端 / 手机扫码填设置推给电视 | 电视上没有好用的输入法 |
| `DebugServer` | 局域网远程调试（只读状态 / 任意 JS / 截图 / 遥控按键） | 给"没有 adb 开关"的投影仪验收用 |
| `NativePlayerActivity` | ExoPlayer 原生播放页 | WebView 的 MediaCodec 受盒子固件限制，硬解失败类问题走这里 |
| `SniffActivity` | 不可见 WebView 打开播放页拦请求找媒体地址 | 播放地址是 JS 现算的源，服务端抓 HTML 拿不到 |
| `MetaMirror` | 片库元数据与海报的本地只读副本 | NAS 重启 / 断网那几分钟界面不空白 |
| `CacheDownloader` | 缓存导出 U 盘 | targetSdk 34 分区存储，必须走 SAF，不要申请 MANAGE_EXTERNAL_STORAGE |
| `UrlCheck` | `/api/proxy/*` 目标地址校验 | 不校验等于在局域网开开放代理（SSRF） |
| `AppUpdater` | APK 下载 / 校验 / 交系统安装器 | 整包不走 JS 桥（base64 体积膨胀） |

**运行时模块**（`com/meow/tv/runtime/`）：`tv-node` 前缀的模块 zip，
`ModuleInstallReceiver` 安装、`RuntimeModuleHost` 校验。`NodeService` 跑在
`:node` 进程——node 崩是 native 级（libnode + V8），不能和网关同进程；
端口**探出来**（默认 19341，被占顺延），写死会在 listen 阶段 EADDRINUSE 直接退出；
danmu_api 内部还有个写死 5321 的代理服务，TV 上没人用，载荷里已配成 0 关掉——
不关会撞端口把整个 node 带走。状态经文件在 `:node` 与主进程间传递
（SharedPreferences 跨进程有内存缓存，不可靠）。

---

## 八、签名与分发（★ 密钥备份）

TV APK **必须用固定的一份 keystore 签名**，否则用户装不上更新。这份 keystore
**只存在于本机和 GitHub Secrets，绝不能进 git**，丢了就永远发不出可覆盖升级的包。

### 8.1 为什么签名身份必须固定

Android 用签名判断「能不能覆盖升级」：已装 A 签名的应用只能装 A 签名的更新，
换 B 签名会被拒——用户必须卸载重装，登录态、播放记录、收藏、片库配置全丢。

`keytool` 实测（本机 keystore，2026-11-11）：

| 项 | 值 |
|---|---|
| 文件 | `client/apps/tv/meow-release.jks` |
| 配置 | `client/apps/tv/keystore.properties` |
| 别名 | `meow`（CN=Meow TV） |
 | 生效期 | 2026-10-23 → 2054-03-10 |
| 算法 | SHA256withRSA / 2048 位 |
| SHA-256 指纹 | `AD:D7:2E:8D:06:62:DC:BB:EA:D6:9B:7B:B7:04:05:D3:CA:FA:6D:51:2D:44:9E:1D:DE:95:0A:95:1E:8E:CC:83` |

### 8.2 备份与进 git 红线

keystore 只在两处：本机 + GitHub Secrets（同一套账号体系）。**必须再备份到与电脑
和 GitHub 都无关的地方**（密码管理器附件 / 离线介质），且必须连
`keystore.properties` 一起存——只有 `.jks` 没有密码等于有保险箱没钥匙。
泄露（含误提交进 git 历史）只能换 keystore，用户需卸载重装一次。

| 场景 | 后果 |
|---|---|
| keystore 丢失 | 用户必须卸载重装，数据全丢 |
| 密码丢失 | 同上 |
| keystore 泄露 | 别人能签发冒名更新包，需立即换新并公告 |

两个文件都在 `client/apps/tv/.gitignore`（`keystore.properties`、`*.jks`），
发版前可用 `git ls-files client/apps/tv/ | grep -iE 'jks|keystore'` 确认为空。

### 8.3 两种打包方式的签名行为

```gradle
signingConfig ksProps.exists() ? signingConfigs.release : signingConfigs.debug
```

- **本地**（`app/build.gradle:100-117`）：`keystore.properties` 存在 → release
  签名；不存在 → 静默退回 debug。`build-apk.ps1` 在 release 模式下硬校验，
  缺失直接报错，避免误发 debug 包
- **CI**（`.github/workflows/_tv.yml:88-94`）：runner 没有这两个文件，工作流先
  `base64 -d` 还原 `.jks`，再现造 `keystore.properties`。缺 secret 打 warning 出
  debug 包。插件模块工作流 `_tv_plugins.yml` 用**同一个** keystore——debug 签名
  每台 runner 各一份，用户装过旧版就装不上更新

::: warning CI 里的相对路径基准
`storeFile` 相对 `app/build.gradle` 所在目录（`app/`）解析，必须写
`../meow-release.jks`。首版写成 `meow-release.jks` 报
`Keystore file ... not found`，而本地不会——本地 properties 本来就是正确写法。
:::

### 8.4 发版前验证

```bash
apksigner verify --print-certs <apk> | head -3
```

指纹与 8.1 的表一致 = 能覆盖升级；不一致 = 用户装不上。

---

## 九、能力边界与兼容上游

### 9.1 自研壳能做什么、不能做什么

**端上自足**（不需要后端参与）：dex 加载、`parse=1` 处理（type 1 直连 / WebView
嗅探 / jar 的 Json/Mix 解析）、`/proxy` 四级代理、直播 + EPG、内置弹幕模块、
应用自更新。

**必须靠后端或架构解决**：跨端状态（TV 的播放进度 / 收藏在自己文件里，Web/PC
拿不到——统一状态属后端数据面的职责，见 [架构](./architecture.md)）；统一能力
声明（TV 端 `Site` 字段与 REST 契约不同形）。

跨端状态在 TV 上的候选路径（**待确认**，需实机验证）：

| 方案 | 做法 | 评价 |
|---|---|---|
| 各自独立 | TV 状态不进后端 | 不满足三端统一 |
| 解析客户端备份 | 逆向备份 JSON 双向转换 | 可行，但格式随上游漂移 |
| 只同步播放进度 | 在 spider `play` 返回里带 `position` 字段 | 成本最低；协议侧有此字段，但上游客户端是否真的读取**未验证** |

### 9.2 兼容上游 Fongmi 的约束

> Fongmi 侧的加载细节（`VodConfig.checkJson` 缺字段返回空、`ParseJob` 分支、
> `Crypto.equals` 等）依据上游源码参照核对，参照代码不在本仓库；本仓库内可验证的
> 对应物是 `LocalSpiderHost`（照它契约实现）与 `ApiServer` 出口注释里的实测记录。

- **不 fork 官方 Fongmi**：它是我们配置的消费者，保持兼容即分发渠道；
  要改样式/交互用自研壳，不走二开
- 配置契约保持 CatVod 标准：顶层 `spider` 是 dex、`;md5;` 后缀、`csp_` 前缀、
  `type` 原值、`ext` 原样——这些同时是自研壳遵守的约定
- 上游侧排查要点（照 `LocalSpiderHost` 同款契约）：
  - `api` 少了 `csp_` 前缀 → 走 `SpiderNull`，**静默失败**（不报错、没内容）
  - `ext` 为空 → `init(ctx, "")`，多数 spider 会失败
  - jar 的 md5 与本地缓存不一致 → 重新下载（慢但会成功，不报错）
  - `parse=1` 的源在 TV 能播而 Web/PC 不能，是因为 TV 端有 WebView 嗅探与完整
    ParseJob；后端侧只有 HTTP（type 1/4），能力差异属运行时本质，不是缺陷
- 日常使用直接装官方 release APK 即可；改它的 UI/图标才需要编译上游工程，
  且 GPL-3.0 要求分发修改版必须开源、catvod 加载模块不要动

---

## 十、常见问题

| 现象 | 原因 | 解法 |
|---|---|---|
| 配置名生效但站点全空 | jar 拉不到 / `spider` 字段无效 | 浏览器访问 jar URL；确认 md5 与文件一致 |
| jar 更新了 TV 还是老版本 | config 里 md5 没跟着 jar 更新 | jar 换了 md5 缓存会失效重算（2.2）；自备源要自己同步 |
| 站点在但一调就 ClassNotFound | 端上表还是旧的（导入没收敛） | 走 `/api/config/import` 或确认 ConfigImportHook 生效；导入后要 `GatewayServer.restart` |
| 内置站点报"jar 下载失败: /data/…" | 本地路径被当 URL 下载 | 已修（4.4）；自接导入路径时注意 file:/绝对路径分支 |
| 所有站点"实例化失败 NullPointerException" | jar 的 `Init` 没被 seed | 确认 `seedInitNow` 在网关启动时执行（4.3） |
| `parse=1` 的源播不了 | 设备 WebView 缺失/受限 | 换有 WebView 的设备，或该源无解 |
| 直播空白 | `lives[].type` 不对 | 3=spider（要 jar 里有 Live 类），0=纯 M3U |
| 聚合搜索第二次开始全空/进程消失 | 32 位 ART 缺陷 | 确认进程隔离开启（5.2）；看 `crash.log` |
| 部分签名类源静默搜不到 | 设备时钟偏差 >5 分钟 | 看 `/api/logs` 的 clockCheck 告警；把电视时间设自动校准 |
| 同一配置 docker 能搜、TV 搜不到 | 出口 IP 差异或降级状态不同 | 先对齐版本再对比（`/api/health` 的 `version`），降级/unsupported 状态分开看 |

---

## 相关

- 三端共享的搜索/健康/降级行为：[架构](./architecture.md)
- `/api/*` 契约与 `/api/config/import`：[API 契约](./api-contract.md)
- spider jar 的打包与 dex 形态产物：[构建与发版](./build-release.md)
- 内嵌网关读的 `policy.json`：[配置系统](./config-system.md)
- 弹幕代理与内置 danmu_api：[弹幕](./danmaku.md)
- PC 端 sidecar 与 dex jar 托管：[插件系统](./plugin-system.md)
