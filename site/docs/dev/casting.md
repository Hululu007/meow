# 投屏

> 改造入口文档。**先读第一节的边界，再读第三节的坑**——投屏坏掉的地方几乎都在"URL 可达性"，
> 不在协议本身。文中提到的符号名可用 grep 定位；行号会随改动漂移，不要按行号找。

## 一、三类投屏，我们只做前两类

| 类别 | 业界叫法 | 接收端要什么 | 我们 |
|---|---|---|---|
| **A. 标准协议推流** | DLNA / UPnP AVTransport | 不需要装我们，任何 DLNA 电视/盒子/投影 | ✅ 已实现发送端（**默认部署不可用**，见 §3）|
| **B. 应用内会话投屏** | App-to-App / Remote Control / 播放迁移（Spotify Connect、Jellyfin Play On、Plex Companion）| 必须装我们 | ❌ 未实现（本文第八节是设计草案）|
| **C. 屏幕镜像** | Miracast / AirPlay 镜像 / Cast mirroring（Android 设置里那个"投屏"）| 协议级镜像，不认内容 | ❌ 不做 |

**A 与 B 的本质差别不是"原生 vs 应用"，而是"投一个地址"还是"投一个会话"**：

- A 类：`SetAVTransportURI(url)` → 对方自己去拉流 → 我们只能通过标准命令控制
- B 类：推 `{媒体, 进度, 元数据}` → 接收端是我们的 App → 能保留弹幕/跳片头/换源/续播，还能迁移

**大厂的做法是"一个按钮、两层降级"**：先找自家 TV 版应用（B 类），找不到再降级到 DLNA（A 类）。
设备列表因此要分区（「我们的应用」/「其他电视」）。我们后续改造应照这个结构做，而不是二选一。

---

## 二、代码地图

| 层 | 位置 | 职责 |
|---|---|---|
| 后端协议 | `server/host/src/shared/core/Cast.java` | 手写 SSDP 发现 + SOAP AVTransport + DIDL-Lite |
| 后端路由 | `ApiServer.java` 的 `handleCast` / `writeRequiresAuth` | `GET /api/cast` 发现；`POST /api/cast` 控制（play/pause/stop/seek）|
| 后端安全 | `server/host/src/shared/core/UrlSafety.java` | `isSafeMediaUrl`：允许局域网，拒绝回环/链路本地 |
| 前端 API | `client/apps/web/src/api/library.ts` | `castDiscover(timeoutMs)` / `castControl(action, device, extra)` |
| 前端基地址 | `client/apps/web/src/api/index.ts` | `resolveBase()` / `base()` / `proxyStream()` |
| 前端面板 | `client/apps/web/src/views/PlayView.vue` | `canCastCurrent` / `openCast` / `castTo` / `closeCast` / `switchEpisode` / `switchLine` |
| 播放器按钮 | `client/apps/web/src/components/player/VideoPlayer.vue` | `canCast` prop、`cast` 事件、菜单项「投屏到电视」|
| TV 复用 | `client/apps/tv/app/build.gradle` 把 `server/host/src/shared` 编进 APK | TV 本机网关 `GatewayServer` 跑同一套 `ApiServer`，所以 TV 也有 `/api/cast` |
| 用户指南 | `site/docs/guide/playback.md` | 面向用户的投屏说明（设备支持、操作路径）|

> **A 类只有发送端**。TV/Android 源码里 `MediaRenderer` / `AVTransport` / `MulticastSocket` / 端口 1900 **零命中**，
> 也就是说"别人投到我们"这条路完全不存在。

> **新增任何 `/api/cast/*` 子路径都要写进 `ApiServer` 的显式 `equals(path)` 路由表**，
> 否则会被 `/api/{site}/{action}` 分派当成 `site="cast"`（见 §13 红线 9）。

---

## 三、★ 最致命的坑：投出去的 URL 必须"接收端可达的绝对地址"

### 3.1 数据流

```
用户点「投屏到电视」
  → GET  /api/cast?timeout=3000            后端 SSDP 发现，返回设备列表（含 controlUrl）
  → 前端把 play.url 包成 proxyStream(...)   变成"我们后端代理地址"
  → POST /api/cast {action:'play', device, url, title}
  → 后端 UrlSafety.isSafeMediaUrl(url) 校验
  → SetAVTransportURI + Play
  → 接收端自己去拉 url 播放
```

**关键在最后一步**：接收端（电视）要能访问那个 URL。所以 URL 必须是：

1. **绝对地址**（带 scheme 和 host）
2. **Host 不是回环**（电视访问不到 `127.0.0.1`）
3. **与接收端同网段可达**（受 AP 隔离/容器网络影响）

### 3.2 三端默认部署恰好全部违规（另有两种配置可用，2026-11-16 实测）

`proxyStream()` 产出的是 `${base()}/api/proxy/stream?...`，而 `base()` 在默认部署下是：

| 端 | `resolveBase()` | `proxyStream` 产出 | 结果 |
|---|---|---|---|
| Web（Docker/nginx 同源）| `''` | `/api/proxy/stream?...` | ❌ 无 host |
| Web（fnOS 子路径）| `/app/meow` | `/app/meow/api/proxy/...` | ❌ 无 host |
| PC（Tauri 插件）| `http://127.0.0.1:9979` | 回环 | ❌ 电视访问不到 |
| TV（本机网关）| `http://127.0.0.1:9978` | 回环 | ❌ 电视访问不到 |
| TV 连 NAS 后端 | `http://192.168.1.34:30011` | 局域网绝对 | ✅ |
| Web 手填局域网后端 | 同上 | 局域网绝对 | ✅ |

**实测（本机活实例 9979，`POST /api/cast`）**：

| 投的 URL | 返回 |
|---|---|
| `/api/proxy/stream?...`（Web 同源形态）| `403 {"msg":"url not allowed"}` |
| `http://127.0.0.1:9979/api/proxy/...`（PC/TV 形态）| `403 {"msg":"url not allowed"}` |
| `http://192.168.1.2:9979/api/proxy/...`（局域网绝对）| ✅ 过校验，进入 SOAP（假设备 → "设备没有响应 SetAVTransportURI"）|

**根因**：`UrlSafety.isSafeMediaUrl()` 明确拒绝 `isLoopbackAddress()` / `isLinkLocalAddress()`（允许 `192.168/10.x`，
因为自建采集站/NAS 是真实场景）。这个规则本身是对的（防 SSRF），**错的是我们喂给它的 URL 形态**。

### 3.3 修复口径（尚未实施）

三件事必须一起做，少一件仍然不通：

1. **前端**：`base()` 为空时用 `location.origin`；子路径部署时用 `new URL(base, location.origin).href`
2. **后端**：`handleCast` 收到回环 URL 时改写成本机局域网 IP（多网卡要选"接收端同网段"的那张）
3. **监听地址**：PC 实例实测只绑 `127.0.0.1:9979`（代码默认写的是 `0.0.0.0`，`MEOW_BIND` 可覆盖），
   Android 侧固定 `127.0.0.1`。**PC 当发送端必须放开 bind 并提示放行防火墙**，否则电视连不上；
   **TV 用本机网关当发送端无解**（绑死回环）；连局域网后端（NAS/Docker）时可以，但意义不大——TV 更适合当接收端。

### 3.4 两个容易忽略的边界

1. **HTTPS 自签证书**：DLNA 电视多数不信任自签证书。若后端在 nginx 反代后面（https + 自签），
   投出去的 `https://...` 在电视上会直接失败。A 类要求 **http** 或**受信任证书**。
2. **敏感 header 泄露**：`proxyStream` 会把除 `Referer` / `User-Agent` 之外的 header 塞进 URL query
   （`headers=`）。投给**第三方设备**等于把 Cookie / Authorization 交给电视和沿途日志。
   投屏专用代理应剔除敏感头，或改成短时效签名 URL。

---

## 四、A 类：发现层

### 4.1 SSDP 现状（`Cast.discover`）

| 项 | 现状 | 备注 |
|---|---|---|
| 搜索目标 | `ST: urn:schemas-upnp-org:device:MediaRenderer:1` | **只搜这一个**；只实现 MediaServer（放自己片库）的设备不会出现 |
| 报文 | 单条 `M-SEARCH`，`MX: 2` | 慢设备可能错过；业界普遍发 2~3 次 |
| 收包 | `DatagramSocket` 400ms 超时循环到 deadline | deadline 由路由钳制在 800~8000ms，默认 2500 |
| 去重 | 按 `LOCATION` | 合理 |
| 设备描述 | 逐个 `httpGet`（每个 4s 超时，**串行**）| 设备多时会把发现预算吃光 |
| 身份 | 只存 `name/host/location/controlUrl/type` | **没有 UDN**；`controlUrl` 跨重启可能变 |
| 缓存 | 故意不缓存 | 电视刚开机时也能发现 |

### 4.2 环境坑（比协议更容易翻车）

1. **多网卡选错出口**：本机实测有 6 个 IPv4（真实网卡 + Hyper-V/WSL/Docker 虚拟网卡）。
   `DatagramSocket()` 不绑网卡时走默认路由，SSDP 可能从虚拟网卡发出 → 一台设备都发现不了。
   修法：按网卡各发一次，或 `setNetworkInterface`。**这也会让"本机探测 0 台"产生误判。**
2. **Docker 桥接网络**：容器内多播通常出不了宿主机，`/api/cast` 可能恒返回 0 台。
   **未在本机证实**（LAN 没有 DLNA 设备可对照）。真网络验证前不要下结论；必要时用 `network_mode: host`。
3. **AP 隔离 / 访客 WiFi**：设备之间互相不可见。表现为"发现得到但拉不到流"或"根本发现不到"。
4. **Android 侧缺多播权限**：TV Manifest **没有** `CHANGE_WIFI_MULTICAST_STATE`，代码**没有** `MulticastLock`。
   → **Android 当接收端时必须补**，否则收不到 M-SEARCH（WiFi 驱动会过滤多播）。
5. **IPv4 only**：SSDP 走 IPv4 多播；纯 IPv6 局域网发现不到，属已知边界。

---

## 五、A 类：控制层

### 5.1 已实现的 SOAP 动作

| 动作 | 用途 | 前端是否调用 |
|---|---|---|
| `SetAVTransportURI` | 设置媒体（带 DIDL 元数据）| ✅ 投屏时 |
| `Play` | 开始播放（**必须在 Set 之后单独发**）| ✅ |
| `Pause` | 暂停 | ❌ 后端有，UI 没接 |
| `Stop` | 停止 | ❌ 同上 |
| `Seek` | 拖进度（`REL_TIME` + `HH:MM:SS`）| ❌ 同上 |

> 现状是"投上去就撒手"：后端四个动作都实现了，前端全仓只有 `castControl('play', …)` 一处。

### 5.2 DIDL 与 `protocolInfo`

DIDL-Lite 里 `<res protocolInfo="http-get:*:video/*:*">` 用的是**通配符**。
`SetAVTransportURI` 不带 DIDL 时部分渲染器直接拒绝；但**通配符同样可能被严格实现拒绝**。
改造时按实际 MIME 填（`application/vnd.apple.mpegurl` / `video/mp4`），并保留通配符作为兼容重试。

### 5.3 缺的标准动作

| 动作 | 缺了会怎样 |
|---|---|
| `GetTransportInfo` | 不知道电视是 playing/paused/stopped |
| `GetPositionInfo` | 拿不到当前位置 → 无法显示进度、无法回本地续播 |
| `GetMediaInfo` | 拿不到 duration |
| `ConnectionManager.GetProtocolInfo` | 无法预判格式 → 投了黑屏（HEVC/MKV）|

### 5.4 错误面太窄

`Cast.soap()` 对任何非 200 都返回 `null`，上层统一报"设备没有响应"。
**UPnPError 的 `errorCode` 被丢掉了**，而不同错误对应完全不同的处置：

| 错误码 | 含义 | 处置 |
|---|---|---|
| `701` | Transition not available（状态机不允许）| 等 300~500ms 重试一次；仍失败→"电视忙/状态不对" |
| `402` | Invalid Args（DIDL / URI 不合法）| 查 `protocolInfo` 与 URL 转义 |
| `710` / `711` | Seek 模式不支持 / 目标非法 | 不 Seek（新集从 0）；目标 clamp 到 `[0, duration)` |
| `602` | Optional Action Not Implemented | 记入设备能力，别重复尝试 |
| 超时 / 非 200 | — | "设备没有响应"，错误里带设备名 |

改造时把 `errorCode` 透出到接口与日志，前端按上表映射成人话。

---

## 六、进度与遥控（未接线）

**不需要 GENA 事件订阅**。`Cast.java` 注释里"要做进度同步就得订阅 AVTransport 事件"的判断可以推翻：
轮询 `GetTransportInfo` + `GetPositionInfo` 就够（A 类 1~2s；B 类 1s），与仓库现有"不用 WebSocket/SSE"的取向一致
（TV 的 Chrome 66 长连接会被固件杀）。

### ★ 单位红线

- `PlayResult` 的 `skips/subs/position/qualities` 由后端 `normalizePlay` 产出，**单位是毫秒**
- DLNA `Seek` 的 `Target` 是 `HH:MM:SS`（秒）
- `GetPositionInfo` 返回 `RelTime` 也是 `HH:MM:SS`

**换算必须集中在一处**（前端 `api/playExtras.ts` 那套思路），组件里不要各算一遍。

---

## 七、格式与转码

| 内容 | A 类能不能投 | 说明 |
|---|---|---|
| MP4 / H.264 | ✅ 基本都行 | 最稳 |
| HLS（m3u8）| ⚠️ 看设备 | **DLNA 规范不强制支持 HLS**；国产电视多有私有扩展，廉价盒子常不认 |
| MKV / HEVC | ⚠️ 大多不行 | 需要 `/api/transcode` 先转 HLS/MP4 |
| 直播（m3u8 live）| ⚠️ 看设备 | 部分电视支持 HLS live；B 类无此限制（接收端自己的播放器）|
| 需解析的源 | ❌ 不该投 | 解析地址常带时效；且 `canCastCurrent` **没排 `needsParse`**（与组件 props 注释冲突）|
| 片库 / 本地文件 | ⚠️ 当前被排除 | `canCastCurrent` 里 `isLibraryPlay → false`；放开前要先确认 Range 与鉴权 |

改造时应先查 `GetProtocolInfo` 再决定：直接投 / 转码投 / 提示不支持。

---

## 八、B 类：自有会话投屏（设计草案，未实现）

### 8.1 与 A 类的差别

| 维度 | A 类 | B 类 |
|---|---|---|
| 投出去的东西 | 一个 URL | 一个**会话**（媒体 + 进度 + 元数据 + 控制通道）|
| 鉴权 | 无（标准缺陷）| 可配对/白名单 |
| 弹幕/跳片头/换源 | ❌ 全丢 | ✅ 全保留 |
| 换集 | 重新投一次 | 自动续推 |
| 迁移（手机↔PC↔投影）| ❌ | ✅ |

### 8.2 发现：一次 SSDP，两档能力

推荐最终形态：接收端同时满足两者——

1. 响应 `MediaRenderer:1`（第三方 App 能投进来）
2. 在设备描述里带 `meow` 标记（我们的发送端据此升级到会话能力）

分阶段落地时，可以**先只做自定义 service type**（`urn:meow:device:Cast:1`），少约 300 行；
代价是丢掉"第三方投到我们"。发送端做两次 M-SEARCH（或一次 `ssdp:all`）即可兼容两种。

### 8.3 接收端必须补的五件事

| # | 事项 | 现状 |
|---|---|---|
| 1 | **局域网监听**（`0.0.0.0`）| 现网关 `GatewayServer` 绑死 `127.0.0.1:9978`，描述/控制 URL 必须局域网可达 |
| 2 | **独立端口** | 9977（`DebugServer`）、9978（网关）、9333（`PushServer`）都被占；接收端要选空闲端口并在 `LOCATION` 里广告 |
| 3 | `CHANGE_WIFI_MULTICAST_STATE` + `MulticastLock` | 都没有（见 4.2）|
| 4 | 生命周期 | 无 `startForeground`；建议"仅 App 前台可被发现"，不引入常驻前台服务。**用户侧含义：电视端要开着猫窝才能被投到** |
| 5 | 设备身份 | 持久化 UDN + 可改设备名（`friendlyName` 常是型号串）+ 能力声明（codec / 弹幕 / 可接）|

### 8.4 会话 API 草案（**未实现，仅约定形状**）

```
GET  /api/cast/devices
  -> {devices:[{id, name, kind:"meow"|"dlna", model, addr,
                caps:{codecs,danmaku,canReceive}}]}

POST /api/cast/session
  {deviceId, media:{url?, title, poster?, site?, vodId?, ep?, danmakuUrl?, position, headers?}, mode}
  -> {sessionId}

GET  /api/cast/session?id=
  -> {state:"playing"|"paused"|"buffering"|"ended"|"gone",
      position, duration, media, takenOver?}

POST /api/cast/command
  {sessionId, action:"play"|"pause"|"seek"|"stop"|"next"|"prev"|"volume", value?}

POST /api/cast/transfer
  {sessionId, toDeviceId}
```

**端点打给谁（最容易写错的地方）**

- `GET /api/cast/devices` 走**发送端后端**——SSDP 在发送端的网络里跑
- `POST /session`、`GET /session`、`POST /command`、`POST /transfer` 由**发送端前端直接打到接收端的 `addr`**
  （播放器与状态都在接收端，打给发送端后端没有意义）
- `sessionId` 由**接收端**生成；发送端后端不存会话
- 跨网段（不在同一广播域）需要发送端后端中继，属后续扩展

约定：

- **接收端持有权威状态**，发送端轮询（1s），不用 WebSocket/SSE
- `position` 单位**秒**（与 DLNA 对齐）；不要和 `PlayResult` 的毫秒混用
- 推 URL 为主（经发送端后端代理），同时带 `site/vodId/ep` 让接收端可自行解析；
  弹幕另带 `danmakuUrl`（见 8.7），接收端不必重新按片名匹配
- 会话断开/超时（**10~30s 无心跳**）→ 发送端提示并提供"一键回本机"

### 8.5 配对与鉴权

DLNA 标准无鉴权 → 只能在**接收端**做应用层确认：

- 首投弹「允许一次 / 记住此设备」，按 UDN 白名单持久化
- 不做 PIN 优先（大厂也是首投确认），PIN 作为"忘记设备"后的兜底

**标准 DLNA 接收端（可选 ①）的鉴权限制**：DLNA 没有握手，发送端不会"重试"，
所以做不到"先确认再播"。只能按 IP/UA 白名单放行，或先放行再提示。
这是可选项 ① 的已知安全限制，**不要对用户承诺"投屏要确认"**。

### 8.6 迁移（transfer）语义

1. 新设备从指定位置开始播放
2. 成功后才停旧设备（失败保持旧设备，避免两头空）
3. 会话 ID 迁移到新设备，发送端 UI 只换目标、不重建

### 8.7 弹幕随投屏（B 类的核心差异化，A 类做不到）

#### 结论矩阵

| 投到哪 | 弹幕 | 原因 |
|---|---|---|
| 第三方 DLNA 电视 / 盒子 / 投影 | ❌ 没有 | 渲染器是对方的播放器，没有我们的弹幕层 |
| 我们的 App（WebView 播放）| ✅ 完整 | 接收端跑同一套 `VideoPlayer` + `danmaku.ts` |
| 我们的 App（回落 ExoPlayer）| ❌ 没有 | `NativePlayerActivity` 不带弹幕层，只播画面 |
| Web 当接收端 | — | 不支持（浏览器不能监听 1900）|

#### 实现要点

**1. 弹幕地址只依赖 `title + episode`，不依赖站点 id**

`PlayView` 里是 `proxyDanmaku(title, epName.value || '1')`。这意味着外部投屏只要能提供
`title + ep`，接收端就能复用整条弹幕链路（抓取 / 缓存 / 升级），不需要为"外来投屏"写第二套匹配逻辑。

> 已知限制：片名别名会让按名匹配失败（裸 host 走弹弹play 三段式时直接取 `animes[0]`）。
> 所以推荐下面的策略 b，让接收端直接用发送端算好的地址。

**2. 三种弹幕同步策略**

| 策略 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| a. 接收端自拉 | 接收端按 `title+ep` 调**自己**的 `/api/proxy/danmaku` | 实现最省，链路现成 | 与发送端可能拿到不同结果（首屏源/升级时序不同）|
| b. **推 `danmakuUrl`（推荐）** | 会话里带发送端的 `/api/proxy/danmaku?...` **绝对地址** | 两边同一份后端缓存，一致性好 | 要发送端后端可达（与媒体 URL 同条件）|
| c. 推载荷 | 会话里带弹幕 JSON/XML | 完全一致（含前端 `dmUpgrade` 聚合后的结果）| 体积大（几万条可达数 MB），要限流与回退 |

建议：默认 **b**；`dmUpgrade` 升级后的聚合结果若只存在发送端 IndexedDB，允许 **c** 作为可选
（限制 ≤2MB，超出自动回退 b）。

**3. 弹幕偏好不随投屏走（有意如此）**

`prefs.danmaku` / `danmakuBlock` / 透明度 / 速度 / 字号都是各端 localStorage。
接收端用自己的设置——电视大屏的字号本来就不该跟手机一致。
若要"跟着走"只能推一份轻量配置，收益低，列为可选。

**4. 播放器选型决定有没有弹幕**

接收端优先 **WebView 播放**（保弹幕 / 跳片头 / 换源），只有 codec 不支持才回落
`NativePlayerActivity`。**回落时必须显式提示"已切原生播放，弹幕不可用"**，否则用户会以为弹幕丢了。

**5. 进度与弹幕的联动**

弹幕由接收端播放器驱动；发送端遥控 seek 时接收端弹幕自动跟随，发送端不参与调度（只轮询状态）。

**6. A 类的补偿（不建议做）**

"弹幕留在手机"需要发送端维持一条与电视同步的播放时钟（还要处理暂停/seek 漂移），
成本高、收益低（用户看的是电视）。建议 A 类直接在 UI 标注"该设备不支持弹幕"。

#### 验收

- 投到自家 TV：弹幕时间轴与发送端一致（同一集、同一进度）
- 回落原生播放：UI 出现"弹幕不可用"提示
- 投到第三方电视：UI 提示"该设备不支持弹幕"

### 8.8 投屏后的控制面：线路、集数、倍速、字幕

#### 现状：投屏后切集会"双播"

`switchEpisode` / `switchLine` 的动作是：`player.pause()` → `router.replace(...)` → 重跑 `load()`
→ 新 `src` → **本地自动开播**。全程**不读投屏状态**，于是投屏后切集会变成：

- 电视继续播旧的那一集 / 那条线路
- 本机开始播新的那一集 / 那条线路
- → **两边同时出声**（`castTo` 只在投屏成功那一刻 `pause()` 了一次）

`closeCast()` 也只清 UI，**不会 `stop` 电视**。改造时这两处都要接进会话。

#### 控制权模型（改造后的约定）

| 东西 | 谁持有 | 为什么 |
|---|---|---|
| 剧集表 `playlist` | **发送端** | 接收端不解析剧集，避免两端源配置不同导致集数错位 |
| 线路表 `lines` | **发送端** | 接收端不该知道"线路"这个概念 |
| URL 解析（含 parse / 换源）| **发送端** | 与用户当下看到的一致 |
| 播放状态 / 位置 | **接收端** | 发送端轮询（A 类 `GetPositionInfo`，B 类会话）|
| 弹幕地址 | **发送端生成** | `danmakuUrl` 随集更新（见 8.7）|

#### 三类操作的统一处理

| 操作 | A 类（DLNA）| B 类（会话）| 位置连续性 |
|---|---|---|---|
| 切集 | `SetAVTransportURI(新URL)` + `Play` | `POST /api/cast/session` 更新 media | 新集从 0 开始（有续播点则用续播点）|
| 切线路（同集）| 同上 + `Seek(旧位置)` | 更新 media + `position` | **必须 Seek**：`SetAVTransportURI` 会把位置重置为 0 |
| 换源（site/vodId 变）| 同切线路；DIDL 标题同步更新 | 更新 media + `danmakuUrl` | 按集名/序号映射位置 |

**顺序红线**：切集/切线路都**不要先 `Stop` 再 `Set`**——先停会黑屏，部分电视回不到播放态。
直接 `SetAVTransportURI` 覆盖即可；失败时旧内容通常仍在播（这也是"失败保留旧"的基础）。

#### 失败与回退

1. 推送失败（SOAP 非 200 / 会话 4xx）→ **不停本地也不停电视**，提示"投屏更新失败，电视仍在播上一集"
2. 连续 **5 次**（约 5~10s）轮询失败，或超过 §8.4 的会话超时（10~30s）→ 判定接收端消失，
   提示"电视已断开"，提供**一键回本机**（用最后已知位置续播）
3. 用户点"停止投屏" → `Stop`（A）/ `stop`（B）→ 读最后位置 → **本地从该位置续播**
4. 投屏期间**不要把本机进度写进历史**：历史要写**电视位置**，否则下次续播跳到旧点

#### 自动连播由接收端状态驱动

本地 `onEnded` 在投屏时永远不会触发（本地不播）：

- B 类：会话 `state == ended` → 发送端按"播完一集"设置推下一集
- A 类：**不要只看 `STOPPED` 时的位置**——多数渲染器播完会 `STOPPED` 且位置归 0。
  判据用"上一次轮询还在 PLAYING 且位置接近时长，随后变 STOPPED" → 视为播完；
  若中途直接 `STOPPED` 且从未接近结尾 → 视为失败或被停，**不要自动跳集**

#### 能力矩阵（投屏后哪些控件还能用）

| 控件 | A 类 | B 类 | 处理 |
|---|---|---|---|
| 播放 / 暂停 | ✅ `Play`/`Pause` | ✅ 命令 | 底栏切换为遥控条 |
| 进度条 | ✅ `Seek` + 轮询 | ✅ | 拖动后等一个轮询周期再回显 |
| 切集 / 上下一集 | ✅ 重推 | ✅ | 见上表 |
| 线路 / 换源 | ✅ 重推 | ✅ | 见上表 |
| 倍速 | ⚠️ 多数电视忽略 `Speed` 参数 | ✅ | A 类禁用并提示"电视不支持倍速" |
| 音量 | ⚠️ 需 `RenderingControl`（未实现）| ✅ | 先只做 B 类 |
| 外挂字幕 | ⚠️ 兼容性差 | ✅ | A 类提示"字幕需内嵌" |
| 弹幕 | ❌ | ✅（WebView）| 见 8.7 |
| 原生播放（ExoPlayer）| ❌ 先停止投屏 | ❌ 同 | 否则本机与电视同时播 |

#### 验收

- 投屏中切集：电视切到新集，**本机不出声**
- 投屏中切线路：电视同集续播在同一位置（±2 s）
- 推送失败：电视继续播旧内容，UI 有提示
- 停止投屏：本机从电视位置续播
- 历史进度：写入的是电视位置（不是本机停在 0 的假进度）

### 8.9 并发、超时与状态机

#### 多发送端抢占

A 类是"后到先得"：第二台手机 `SetAVTransportURI` 直接覆盖，前一个发送端毫不知情。
B 类必须显式处理：

- 接收端收到新会话 → 通知旧发送端（旧端轮询到 `state:"gone"` 或 `takenOver:true`）
- 旧端 UI 提示"已被其他设备接管"，不弹抢占确认（家庭场景只会烦人）

#### 孤儿会话（发送端被杀 / 被系统清理）

- 接收端**继续播放**（用户正在看），但把会话标记为 `disconnected`
- 接收端 UI 角落提示"发送端已断开"，提供遥控兜底（电视遥控器本身能暂停/退出）
- 可选 TTL：N 分钟无心跳自动停止；**默认建议不停**，避免看着看着被停
- 发送端重连后按 `sessionId` 接管，不重建（**`sessionId` 要持久化到本地**，否则进程被杀就丢）

#### 发送端状态机

```
idle → discovering → connecting → playing ⇄ paused
                        ↘ failed        ↘ disconnected → (回本机 | 重连)
                                          ↘ ended → 下一集 / 停止
```

UI 只暴露四态：**未投 / 搜索中 / 正在 XX 上播放 / 已断开**。中间态不要暴露给用户。

#### 页面离开不等于停止投屏

离开播放页时电视应继续播；只有显式"停止投屏"、会话超时或被接管才停。
因此**会话状态必须放在 store（或持久化），不能只存在 `PlayView` 的局部 ref**，
否则返回播放页或切集重建组件后，"正在 XX 上播放"就丢了，还可能在本地重新开播。

---

## 九、A 类设备支持矩阵

### 9.1 大概率能投

国产智能电视（小米/海信/TCL/创维/长虹/康佳）、合资电视（索尼/三星/LG）、
国产电视盒子（小米/当贝/天猫魔盒/泰捷）、国产智能投影（极米/坚果/当贝）。

> 入口常叫「多屏互动 / 无线投屏 / 媒体共享 / DLNA」，**默认可能关闭**，需要用户手动打开。

### 9.2 明确投不了（协议决定，不是 bug）

| 设备 | 原因 |
|---|---|
| **Apple TV** | 只支持 AirPlay，不支持 DLNA |
| **Chromecast / Google TV 棒** | 只支持 Google Cast |
| **Fire TV** | 无系统级 DLNA 渲染器 |
| HomePod / AirPlay-only 音箱 | 只有 AirPlay |
| 只支持 Miracast 的廉价投影 | 只能镜像，不能接 URL |
| 手机/平板/PC（没装我们）| 既没有 DLNA 渲染器、也没装我们 → **投不了**（B 类要求装我们）|

### 9.3 现场验证三步

1. 手机装第三方 DLNA 发送端（BubbleUPnP 等）试投同一台电视 → 能否发现
2. 看我们投屏面板是否出现设备 → 过了"发现 + AVTransport"两关
3. 先投 MP4 直链、再投 m3u8 → 区分"链路问题"与"HLS 兼容问题"

---

## 十、Apple TV / AirPlay 评估（结论：有路，优先级低）

Apple TV 与 DLNA 是两套协议栈，不是"加个分支"：

| 环节 | DLNA | AirPlay |
|---|---|---|
| 发现 | SSDP | mDNS（`_airplay._tcp`）|
| 鉴权 | 无 | HAP 配对（电视显示 4 位 PIN）|
| 传输 | SOAP + HTTP URL | RTSP + 二进制 plist |
| 同步 | 无 | 发送端要跑 UDP 定时服务器 |

开源的 `pyatv` 已证明可行（`examples/play_url.py` 就是"播放视频 URL"）：
`POST /play` + `Content-Type: application/x-apple-binary-plist` + `X-Apple-ProtocolVersion: 1`，
body 为 `Content-Location / Start-Position / X-Apple-Session-ID`，随后轮询 `GET /playback-info`。
**普通 HTTP 视频不需要 FairPlay**；tvOS 原生支持 HLS，格式上反而比很多 DLNA 电视更稳。

### 10.1 三条可行路径（不是"没办法"）

| 路径 | 做法 | 工作量 | 前提 / 风险 |
|---|---|---|---|
| **A. Java 自研（推荐先评估）** | JmDNS 发现 + **复用 `openairplay/AirPlayAuth` 的 Java 配对实现**（SRP6 + Curve25519）+ `/play` + binary plist + UDP timing server | **4~7 天** | 必须有 Apple TV 真机；AirPlayAuth 最后更新 2017，**现代 tvOS 需先验证** |
| **B. pyatv sidecar** | 后端调 Python `pyatv` 的 `play_url`，把配对凭证与 PIN 流程包成插件 | **3~5 天** | Docker 要带 Python（+60~80MB）；PC 可内嵌运行时；**Android 本机不行**（只能走 NAS/Docker 后端）|
| **C. Apple TV 装 App** | 我们暴露 DLNA **MediaServer**，用户在 Apple TV 的 VLC/Infuse 里浏览播放 | 0 开发（MediaServer +1~2 天）| 要装 App、手动浏览；**只覆盖片库**，不支持我们的源/弹幕 |

参考实现（都不是直接可用的成品，但能省大量试错）：

- `openairplay/AirPlayAuth`（**Java**，97★）——pair-setup / pair-verify 已实现，含 `Curve25519` 与 SRP6；**这是路径 A 的关键**
- `postlund/pyatv`（Python，1213★，2026-08 仍在更新）——`play_url` 全流程；**路径 B 的关键**
- `omarroth/doubletake`（Go，166★，2026-11 更新，**LGPL-3.0**）——Linux 上的 AirPlay **镜像**发送端，可作协议参考，**许可证不适合直接抄进本仓库**
- `akustikrausch/airplay2-sender-cpp`（C++，75★）——AirPlay 2 **音频**发送端，视频不适用

### 10.2 结论修正

不是"没办法"，而是"**要一台真机 + 3~7 天**"：

- 若 Apple TV 用户是真实需求 → 先做 **路径 B**（pyatv sidecar）验证"能不能投、投出来是什么样"，3~5 天出 POC；
  POC 通过后再决定是否做 **路径 A**（Java 化，摆脱 Python 依赖）。
- 若只是长尾 → 先不做，但**文档与用户指南要写明**"Apple TV / Chromecast / Fire TV 不支持 DLNA"，
  并给出替代：iPhone/Mac 用系统 AirPlay 镜像，或 Apple TV 装 VLC/Infuse 播我们片库。

另：商用产品标注 "AirPlay" 需 MFi 授权——技术上可做，对外不要宣传"支持 AirPlay"。

---

## 十一、测试与验收

### 11.1 必须沉淀的自动化

| # | 用例 | 判据 |
|---|---|---|
| 1 | **假渲染器 smoke** | 本地起一个假 MediaRenderer：回 SSDP `LOCATION`、提供描述 XML（含 AVTransport controlURL）、收 SOAP 落盘；断言收到 `SetAVTransportURI`（DIDL 转义正确）与 `Play` |
| 2 | **门禁：URL 形态** | `canCast` 产出的 URL 必须是绝对地址且 host 非回环（防止再退回相对/回环）|
| 3 | **门禁：`needsParse` 排除** | 需解析的源不出现投屏入口 |
| 4 | **单位换算单测** | ms ↔ 秒 ↔ `HH:MM:SS` 只在集中处换算 |
| 5 | **接收端拒非法 URL** | 被推 `http://127.0.0.1/...` 或非 http(s) 时拒绝（复用 `isSafeMediaUrl`）|
| 6 | **切集 / 切线路位置** | 同集换线后位置误差 ≤2s；切集从 0（或有续播点）开始，本机不出声 |
| 7 | **会话接管 / 超时** | 旧发送端能收到 `gone` / `takenOver`；无心跳不误停正在播的内容 |
| 8 | **敏感头不泄露** | 投给第三方设备的 URL 不含 Cookie/Authorization |

> 假渲染器验证过一次（2026-10-25，识别为 `Fake TV`、DIDL 中文标题保留），但**没有沉淀成常驻用例**。

### 11.2 真机清单（无法自动化）

- 小米/海信/极米/当贝 各一台：m3u8 + mp4 各投一次
- 投后暂停/拖进度（验证 5.1 的未接线动作）
- 投屏中切集 / 切线路各一次（验证 8.8，重点听有没有双声）
- 多网卡 PC、Docker 部署、AP 隔离网络各验一次"发现得到/发现不到"
- 拔网/关电视：错误提示是否可读（不要暴露 `HTTP 403`）

---

## 十二、改造路线（编号，工作量按单人估）

| 编号 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| 1 | P0 链路：URL 可达性 + bind + 多网卡 SSDP + 排除 `needsParse` | 0.5~1 天 | 投客厅电视真出画面 |
| 2 | A 类补齐：`GetProtocolInfo` 预判 + `GetTransportInfo/GetPositionInfo` 轮询 + 遥控 UI + 切集/切线路重推 + UPnPError 透出 | 1~1.5 天 | 投后能看进度、能暂停/拖拽、切集不出双声 |
| 3 | B 类接收端 MVP（Android）：自定义 SSDP + `MulticastLock` + LAN 监听 + 会话 API | 2~3 天 + 真机 1 天 | 手机/PC/Web → 我们的 TV/手机/投影 能接住播放 |
| 4 | B 类体验：换集/切线路重推 + 停止投屏回本机 + 进度写电视位置 + transfer + 弹幕/跳片头保留 | 1~2 天 | 场景 2 体验对齐大厂 |
| 5 | 配对与设备管理（首投确认、记住、改名、能力图标、列表分区）| 0.5~1 天 | 同网段不会被乱投 |
| 6 | 门禁 + 假渲染器 smoke | 0.5 天 | 防止再次退化 |
| **7** | **PC 接收端**：后端/Tauri 开 LAN 监听 + 会话 API + 防火墙提示 + PC 端"可被投屏"开关 | 0.5~1 天 | 手机/TV → 我们的 PC 能接住播放（你要求的"手机到 pc"）|
| 可选 ① | 标准 MediaRenderer（第三方投进来）| +2~3 天 | 爱奇艺/B站能投到我们 |
| 可选 ② | AirPlay 发送端（Apple TV）| +3~5 天（pyatv POC）/ +4~7 天（Java 化，见 §10）| 需真机；优先级低 |

> 必做清单不含 PC 接收端时，"手机 → PC"这条路径不成立；所以 7 是必做。

### 12.1 改动落点（按文件，施工时照这张表找位置）

| 目标 | 文件 | 改什么 |
|---|---|---|
| URL 可达性 | `client/apps/web/src/api/index.ts`（`base` / `proxyStream`）| 同源与子路径部署时产出**绝对**地址 |
| | `server/host/src/shared/ApiServer.java`（`handleCast`）| 回环地址改写成本机 LAN IP（多网卡选同网段）|
| | `client/apps/desktop/src-tauri/src/plugins.rs` + 后端插件清单 | 传 `MEOW_BIND=0.0.0.0`；首次投屏提示放行防火墙 |
| **路由注册** | `ApiServer.java` 的显式 `equals(path)` 表 | 新增 `/api/cast/devices` / `session` / `command` / `transfer` 必须登记，且排在站点分派之前 |
| SSDP 健壮性 | `server/host/src/shared/core/Cast.java`（`discover`）| 多网卡各发一次 / 发 2~3 次 M-SEARCH / 描述抓取并发 / 保存 UDN |
| 能力预判 | `Cast.java` + `handleCast` | 查 ConnectionManager `GetProtocolInfo`，按 MIME 决定直投 / 转码 / 拒绝 |
| 进度与遥控 | `Cast.java` | 加 `GetTransportInfo` / `GetPositionInfo` / `GetMediaInfo`；透出 UPnPError |
| | `client/apps/web/src/api/library.ts`、`PlayView.vue`、`VideoPlayer.vue` | 接 pause/stop/seek、遥控条、投屏状态显示、设备列表分区 |
| 投屏入口正确性 | `PlayView.vue`（`canCastCurrent`）| 排除 `needsParse`；片库是否放开需单独拍板 |
| 切集 / 切线路 | `PlayView.vue`（`switchEpisode` / `switchLine`）| 投屏中改为"重推 + 保持位置"，本地不自动开播（见 8.8）|
| 进度归属 | `PlayView.vue` 的进度回调 / `App.vue` 的历史写入 | 投屏期间写**电视位置**，不写本机停在 0 的假进度 |
| 接收端（Android）| 新 `CastReceiver` 模块（不要改 9978 回环网关）| **新开 `0.0.0.0` 的空闲端口**；`MulticastLock` + SSDP 响应 + `ssdp:alive`/`byebye` + 会话 API |
| | `client/apps/tv/app/src/main/AndroidManifest.xml` | `CHANGE_WIFI_MULTICAST_STATE` |
| 接收端（PC）| `client/apps/desktop/src-tauri/src/plugins.rs` + 后端 | 开 LAN 监听 + 防火墙提示 + "可被投屏"开关 |
| B 类会话 | `ApiServer.java` + `client/apps/web/src/api/*` + 设备列表 UI | 按 8.4 草案新增端点与分区列表 |

---

## 十三、改这块之前的红线

1. **不要给接收端投相对地址或回环地址**——`isSafeMediaUrl` 会拒，且接收端本来也访问不到。
2. **不要为了"能投"去掉 `isSafeMediaUrl`**——它挡的是"让内网设备访问任意地址"的 SSRF 变种。
3. **不要在 Android 上开 1900 监听却忘了 `MulticastLock`**——收不到任何 M-SEARCH，且日志里看不出原因。
4. **不要把 `position` 的毫秒/秒混用**——`PlayResult` 是毫秒，DLNA 是秒/`HH:MM:SS`。
5. **不要用 `controlUrl` 当设备唯一标识**——跨重启会变；要有 UDN。
6. **不要假设 `/api/cast` 有鉴权**：`writeRequiresAuth` 只在配置了 `MEOW_AUTH_TOKEN` 时才拦
   （2026-10-30 安全审计 H15 已把它列进"写操作需令牌"，但默认无令牌）。
7. **不要相信 `X-Forwarded-For`**：`clientIp()` 默认只认 socket 地址，`trustProxy` 才取最后一跳。
8. **不要把 Docker 桥接网络下的"0 台设备"当成代码 bug**——先按 4.2 验证多播与网络形态。
9. **新增 `/api/cast/*` 子路径必须写进显式 `equals(path)` 路由表**——不写会被 `/api/{site}/{action}`
   分派当成 `site="cast"`，得到 404 或调错类。
10. **接收端必须复用 `isSafeMediaUrl` 校验被推的 URL**——否则我们成了"让电视去访问任意地址"的跳板。
11. **投屏期间不要让本地播放器自动开播**——`switchEpisode` / `switchLine` 现在会，改的时候必须按会话短路。
12. **投给第三方设备的 URL 不要带 Cookie / Authorization**——见 §3.4。

---

## 相关

- [播放与转码](./playback.md)：错误分类、转码决策、代理与请求头
- [接口契约](./api-contract.md)：响应与错误码约定
- [数据与状态](./data-state.md)：`/api/state/progress` 跨端进度
- [测试与验收](./testing.md)：门禁与冒烟脚本的组织方式
- [Docker 部署](./docker.md)：容器网络形态
- [用户指南 · 播放与弹幕](../guide/playback.md)：面向用户的投屏操作与限制
