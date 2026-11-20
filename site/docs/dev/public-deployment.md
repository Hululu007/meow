# 公网部署与访问控制（v2：应用内账号体系）

> 状态：**方案，待实施**（2026-11-19 定稿方向）。
> 目标场景：公网 Docker 服务器 / 公网 fnOS NAS；浏览器直接打开 web 端口在线观看，
> TV / PC 壳直连后端。**不要求前置反代、不要求 fnOS 网关**。
>
> v1（纯 token + nginx `?key=`）保留在 git 历史里；本文取代它。
> 旧结论「必须只暴露 web 容器 443」不再是前提——应用自己就是边界。
>
> **fnOS 部署另有一章**：经 fnOS 网关进来时的 `X-Trim-*` 身份、以及"网关 / 直连 / 公网"三入口的
> 鉴权分工见 [fnOS 网关身份接入](./fnos-gateway-auth.md)（设计稿）。本文 §10.2 / §10.4 的
> "网关后还要二次登录"是**当前实现**，接入网关身份后会改成免密。

## 结论先行

| 判断 | 内容 |
|---|---|
| Web 直连 | **账号 + 密码登录** → `HttpOnly` 会话 Cookie；`<video>`/HLS 分片同源自动带 Cookie |
| 后端直连（TV/PC） | **设备令牌**（登录后生成，或首启生成）→ `X-Meow-Token` |
| 媒体流 | 浏览器走 Cookie；TV/PC 走短时媒体票 `?mt=`（URL 自带授权，`<video>`/ExoPlayer 都能用） |
| CatVod 出口 | `/config.json`、`/spider-latest.jar` 用独立 `configKey`（`?key=`） |
| 首次启动 | setup 令牌只打印到服务端日志；远程无法抢先设置密码 |
| TLS | **不是"前置服务器"**：Docker 用 web 容器自带 nginx 终止 TLS；fnOS 可用 meowd 的 rustls。纯 HTTP 模式只允许令牌、不允许密码登录 |
| 多用户 | 不做；单管理员 + 多设备令牌 |
| 前置反代 | 可选（TLS/限流/2FA），不是方案成立的必要条件 |

## 一、为什么不需要前置反代

认证放在应用里有三个好处：

1. Web 端会话 Cookie 让媒体请求天然带凭据，不用给每个分片签 URL；
2. TV/PC 继续用 header token，和现有前端「每个请求都带 `X-Meow-Token`」的实现一致；
3. Fongmi/TVBox 只需要一个 `?key=` 的 `config.json`，不依赖任何代理行为。

**前提**：密码登录必须跑在 TLS（或 VPN）上；纯 HTTP 会让密码/会话在链路上明文。
TLS 可以放在：

- Docker：`web` 容器里已有的 nginx（现在就在代理 `/api`，加 `listen 443 ssl` 即可，不是新增服务）；
- fnOS：meowd（Rust）用 `rustls` 终止 TLS；
- 两者都没有：退化为「HTTP + 仅令牌」模式（见 §九）。

> 如果选择 §10.6 的开源 IdP（Authelia/Authentik/Casdoor），则**确实需要**一个前置反代做 forward-auth/OIDC；
> 这是可选项，用于注册/找回/2FA/多用户，不是应用内账号模式的前提。

## 二、威胁模型与信任边界

未配置任何认证时（现状），公网暴露的实际后果：

| 能力 | 入口 | 现状 |
|---|---|---|
| 拿所有站点 `ext`（API key/cookie） | `GET /config.json`、`GET /api/config` | 匿名明文 |
| 看历史/收藏 | `GET /api/state/*` | 匿名 |
| 任意方法 SSRF + 回显 | `GET/POST /api/webdav` | 匿名，method 在 body |
| 盲 SSRF | `GET /api/proxy/danmaku?url=` | 无 URL 校验 |
| 正向代理 | `GET /api/proxy/stream?url=` | 有 `isSafeMediaUrl`，但公网 URL 可白嫖带宽 |
| 改策略/导配置/导入 jar | `POST /api/policy`、`/api/config/*` | 默认无 token 时全放行 |
| drpy 执行请求头 JS | `0.0.0.0:30013` | 默认公网可达 |

**信任边界（v2）**：

- 公网路径不可信：TLS 必须存在，否则只允许预共享令牌；
- 本机回环 / TV 端内网关 / PC 本机插件可信：它们不配认证，保持开放；
- 单管理员：拿到管理员密码或任一设备令牌 = 管理员，不做权限细分。

## 三、凭证模型（四类，职责分离）

| 凭证 | 谁用 | 传输 | 存储 | 生命周期 |
|---|---|---|---|---|
| **管理员密码** | Web 登录 | 仅 TLS 下 POST body；PBKDF2 哈希比对 | `policy.json` 的 `auth.passwordHash`（带盐） | 长期；可改 |
| **会话 Cookie** | 浏览器 | `HttpOnly; SameSite=Lax; Secure`（TLS 时） | 服务端会话表（内存/落盘） | 7–30 天，可退出 |
| **设备令牌** | TV / PC / 脚本 | `X-Meow-Token` header | `policy.json` 里存 SHA-256，原文只显示一次 | 长期，可单设备撤销 |
| **媒体票 `mt`** | 浏览器/TV 的媒体 URL | `?mt=` | 服务端 TTL 表 | 30 分钟–6 小时 |
| **configKey** | Fongmi/TVBox | `?key=` | `policy.json` 存 SHA-256，原文只显示一次 | 长期，可轮换 |

> 原则：**管理员令牌永远不进 URL**。URL 里只允许短时 `mt` 和 CatVod 的 `configKey`。

## 四、认证流程

### 4.1 首次启动（防远程抢注）

1. 检测到没有密码：生成 **setup 令牌**（32 字节 base64url），只打印到服务端日志/控制台；
2. 浏览器打开 `/setup`，输入 setup 令牌 + 新密码；
3. 成功后写入 `passwordHash`，setup 令牌作废；
4. 同时生成第一个设备令牌（名字 `initial`），只打印一次，供 TV 直接填。

**为什么不把 setup 页做成匿名可提交**：公网部署时，任何先访问的人都能设密码。setup 令牌只存在于服务端日志，远程拿不到。

> **HTTP 模式的例外**：纯 HTTP（无 TLS）下，浏览器提交 setup 令牌/密码会在链路上明文暴露。
> 因此 HTTP 模式**不开放网页 setup**，只能在服务器本机执行 `apiserver --set-password`
> （仅回环/控制台）写入密码；或者干脆只用设备令牌，不启用密码登录。
> setup 接口同样限流（5 次/分钟/IP），失败计数与登录共用。

### 4.2 Web 登录

- `POST /api/auth/login` `{username,password}` → 校验 PBKDF2 → 新建会话 → `Set-Cookie: meow_sid=...`
- Cookie：`HttpOnly`、`SameSite=Lax`、`Path=/`、TLS 时 `Secure`；不设 `Domain`
- 密码策略：至少 10 位；不强制大小写符号（避免用户写便签），但拒绝等于用户名/常见弱口令
- 登录成功/失败都做 Origin 校验（无 Origin 的 curl 放行），防登录 CSRF
- 失败限流：同 IP 5 次/分钟；连续失败指数退避；**不做全局锁定**（防攻击者锁死管理员）
- 响应不区分「用户不存在/密码错」
- 会话存在服务端内存表：**apiserver 重启会让所有浏览器会话失效**（设备令牌不受影响），这是有意的取舍；过期会话定时清理，单管理员最多保留 32 个会话（超出踢最旧）
- 反向代理终止 TLS 时，只有来自回环/受信代理的 `X-Forwarded-Proto: https` 才被采信（`MEOW_TRUST_PROXY=127.0.0.1`）；否则攻击者伪造该头可让 Cookie 被标成 Secure 或绕过 HTTP 限制
- 同理，登录限流与 `MEOW_ALLOW_CIDR` 的客户端 IP 只在受信代理下取 `X-Forwarded-For` 最后一跳，否则直接用 socket 对端地址

### 4.3 设备令牌

- `POST /api/auth/devices`（需会话）`{name}` → 返回一次明文令牌；
- `GET /api/auth/devices`：列表只返回 id/name/created/lastUsed，不返回令牌；
- `DELETE /api/auth/devices/{id}`：立即撤销；
- TV/PC 在设置页填这个令牌；旧版 `meow.authToken` 的 localStorage 继续可用（迁移为一个 `legacy` 设备令牌）；
- `MEOW_AUTH_TOKEN` 环境变量若存在，作为 `env` 设备令牌导入（哈希后存 policy），不再参与密码逻辑；
- 设备令牌最多 20 个（防 policy 膨胀）；`lastUsed` 每小时最多落盘一次；
- 令牌校验用常量时间比较。

### 4.4 改密码 / 找回

- 改密码：`POST /api/auth/password`（需会话）→ 重新哈希 → **递增 sessionEpoch**，所有旧会话失效；可选同时撤销全部设备令牌；
- 忘记密码：没有邮件/密保。只能在服务器本机执行 `apiserver --reset-password`（仅回环/控制台），或直接删除 `policy.json` 里的 `auth` 段再走 setup；
- 不提供"网页找回密码"，避免邮箱/SMS 依赖和新的攻击面。

## 五、授权矩阵

| 端点 | 匿名 | 会话 Cookie | 设备令牌 | `mt` | `configKey` |
|---|---|---|---|---|---|
| `/api/health`、`/healthz` | ✅ | — | — | — | — |
| `/api/auth/setup` | setup 令牌 | — | — | — | — |
| `/api/auth/login` | ✅（限流） | — | — | — | — |
| `/api/auth/logout`、`/password`、`/devices*` | — | ✅ | — | — | — |
| `/api/*` 其余 | — | ✅ | ✅ | — | — |
| `/api/proxy/stream`、`/api/library/stream` | — | ✅ | ✅ | ✅ | — |
| `/config.json`、`/spider-latest.jar` | — | ✅ | — | — | ✅ |
| 静态 `/` | ✅ | — | — | — | — |

规则：

- 配了密码/令牌才启用鉴权；什么都没配 = 旧行为（局域网自用不受影响）；
- `OPTIONS` 一律放行；
- 所有 `/api` 请求（含 GET）都要凭证；**只有** `/api/health`、`/healthz`、`/api/auth/login`、`/api/auth/setup` 例外；
- 写请求继续走现有 `Origin` 白名单（`MEOW_CORS`）；Cookie 场景再加 SameSite=Lax 兜底；
- `/api/health` 的 `authRequired` 语义要更新为：**配了密码或任一设备令牌即 true**；另返回 `authMode`（`none` / `password` / `token-only`），前端据此决定跳登录页还是令牌页；
- 前端必须审计所有绕过统一封装的请求（裸 `fetch`、`EventSource`、WebSocket、`<video src>`）：前两者没有带凭据就补，后者只能走 `mt`；
- 服务端判定顺序：**会话 Cookie → `X-Meow-Token` → `mt`（仅 stream）→ `configKey`（仅 config/jar）**，命中即停；
- `scope=read` 的设备令牌只允许安全 GET（搜索/详情/历史/播放地址），任何写操作 403；
- `/api/auth/devices*` 等管理接口**只认会话**，设备令牌即使 scope=full 也不能管理令牌（防一台设备提权）。

## 六、媒体授权（关键约束）

浏览器/PC 的 `<video>`、TV 的 ExoPlayer/WebView 都无法可靠携带自定义 header；TV 页面还是跨源（`http://meow.local`），拿不到后端 Cookie。所以：

### 6.1 两条通道

- **浏览器（同源）**：会话 Cookie 自动带 → `/api/proxy/stream`、`/api/library/stream` 直接放行；
- **TV/PC（跨源或原生播放器）**：先调 `POST /api/stream/ticket`（带设备令牌），拿 `{mt,exp}`，媒体 URL 追加 `?mt=`。

### 6.2 媒体票的作用域（防变成开放代理）

`mt` 不是"万能通行证"，服务端记录：

- `kind=library`：只允许指定 `lib` + 路径前缀；
- `kind=proxy`：只允许指定**源 host 集合**（最多 8 个），且每个 URL 仍过 `UrlSafety.isSafeMediaUrl`；
- 可选绑客户端 IP（公网 HTTP 模式默认开启）；**IP 取 socket 对端，受信代理下才取 XFF**；
- TTL 默认 30 分钟（TLS 下可 6 小时），过期由播放器重取；
- 票表定时清理（每分钟一次），单票最多 64 个 host；`mt` 在访问日志里做掩码（只留前 6 位）。

### 6.3 HLS

- 代理 m3u8 时，把分片 URI 重写为带同一个 `mt` 的代理地址；
- 分片 host 必须在 ticket 的 host 集合内，否则拒绝；
- 播放器不感知票的存在，照常请求；
- **实现注意（代码核对）**：`proxyUrl()`（`ApiServer.java`）目前只拼 `url/referer/ua/headers`，
  不传任何凭证；`EXT-X-KEY`/`EXT-X-MAP`/分片三处重写都走它。必须把 `mt`（以及投屏的 `ct`）
  作为参数贯穿到 `proxyUrl` 和所有调用点，否则"清单能取、分片 401"。

## 七、CatVod 出口

- `configKey` 与管理员密码/设备令牌**完全独立**，首启生成、只打印一次；
- `GET /config.json?key=`、`GET /spider-latest.jar?key=` 校验哈希；
- 无 key / 空 key → 403；无 key 时**不输出 `ext`**；
- key 会进 URL/浏览器历史/访问日志：nginx 对这两个路径 `access_log off`，应用日志 scrub；
- 轮换：`POST /api/auth/config-key/rotate`（需会话）→ 返回新 key 一次。

## 八、存储与加密

`policy.json` 新增段（**绝不通过 `/api/policy`、`/api/config`、备份导出返回**）：

```json
{
  "auth": {
    "username": "admin",
    "passwordHash": "<base64>",
    "passwordSalt": "<base64>",
    "iterations": 210000,
    "sessionEpoch": 1
  },
  "deviceTokens": [
    {"id": "...", "name": "initial", "hash": "<sha256>", "created": "...", "lastUsed": "..."}
  ],
  "configKeyHash": "<sha256>"
}
```

- 密码：`PBKDF2WithHmacSHA256`（JDK 自带，不引第三方），210k 次、16 字节盐、32 字节输出；
- 设备令牌/configKey：`SecureRandom` 32 字节 base64url；存 SHA-256；
- 会话：服务端 `ConcurrentHashMap<sid,{epoch,exp,created,ip?}>`；`sessionEpoch` 变化让全部旧会话失效；
- 所有比较用常量时间；
- 配置导出/WebDAV 同步必须排除 `auth`、`deviceTokens`、`configKeyHash`。

## 九、TLS 与 HTTP 两种模式

### 9.1 TLS 模式（推荐）

- Docker：`web` 容器 nginx 增加 `listen 443 ssl` + 证书挂载；HTTP 301 到 HTTPS；
- fnOS：meowd 增加 `--tls-cert/--tls-key`（rustls）；或同机一个反向代理容器；
- Cookie 带 `Secure`；密码登录可用；媒体票可放宽到 6 小时；
- nginx 必须设 `X-Forwarded-Proto $scheme`；应用只在 `MEOW_TRUST_PROXY` 指定的回环地址上采信它；
- 证书续期不在范围内：Docker 用 certbot `--deploy-hook` reload nginx；fnOS 自签/域名证书需手工续，文档写明。

### 9.2 纯 HTTP 模式（受限）

- **禁止密码登录**（避免密码明文）：只保留设备令牌；密码由本机 CLI 设置，不开放网页 setup；
- **浏览器也走设备令牌模式**：首次打开输入令牌，存 `localStorage`，不启用会话 Cookie（HTTP 下 Cookie 同样会被嗅探）；
- 媒体票 TTL 压到 30 分钟，并默认绑 IP；
- 建议叠加 `MEOW_ALLOW_CIDR`（来源白名单）；**回环地址永远放行**（否则 fnOS 网关/本机反代会被自己挡掉）；
- 文档明确：HTTP 模式只防误闯/扫描，不防链路攻击；公网使用风险自担。

> 如果只想"HTTP 直连 + 不折腾证书"，最省事仍是 VPN（Tailscale/WireGuard）：
> 隧道内继续用 HTTP，密码登录也安全。

## 十、部署形态

### 10.0 部署形态矩阵（先认清"谁和谁是一体"）

| 形态 | 谁在跑 | Web 页面来自 | 后端 API 在哪 | 谁需要登录 |
|---|---|---|---|---|
| **Docker 一体** | web(nginx)+apiserver+drpy+danmu | 同一部署的 web | 同部署 apiserver | 浏览器登录；TV/PC 令牌；Fongmi key |
| **fnOS 一体（直连 30010）** | meowd+apiserver+web | meowd 静态目录 | meowd/内嵌 apiserver | 浏览器登录；TV/PC 令牌；Fongmi key |
| **fnOS（仅 5666 网关）** | 同上，入口走 fnOS 网关 | 网关代理的同一 web | 网关后的 meowd | 浏览器：fnOS 登录（启用应用账号时再加一次应用登录）；TV 远程不可用 |
| **TV 本地网关** | 端内 GatewayServer + 复用 ApiServer | TV 本地打包资源（`meow.local`） | 端内 127.0.0.1 | **不登录**（只在本机回环） |
| **PC 本机插件** | Tauri + 本机 apiserver 插件 | PC 本地打包资源（`tauri://`） | 本机 127.0.0.1 | **不登录** |
| **分体：web 在前、后端在后** | web 容器/反代 + 远端 apiserver | 前置 web | 远端 apiserver（只内网） | 浏览器登录；TV/PC 指向**前置 web** 用令牌 |
| **纯后端（无 web）** | 只跑 apiserver | 无 | 本机/内网 | 无 Web 登录；只有设备令牌 |

两条判据：

1. **页面与 API 是否同源**：同源且该部署启用密码 → 浏览器登录；页面来自本机壳（`tauri://`、`meow.local`）→ 永远不用 Web 登录。
2. **API 是否只在本机回环**：是 → 不需要认证（TV 本地网关、PC 本机插件）；否 → 令牌必填。

### 10.1 Docker 公网服务器

```
公网 30010（或 443，web 容器内 nginx）
 ├─ /api/* ... 应用内会话/令牌
 └─ /config.json?key=...
只发布 web；apiserver/drpy/danmu 全部 127.0.0.1
```

- `MEOW_AUTH_MODE=on`：首启生成 setup 令牌并打印；
- `APISERVER_BIND=127.0.0.1`、`DRPY_PORT=127.0.0.1:30013`、`DANMU_BIND=127.0.0.1`；
- `MEOW_CORS=https://域名,http://meow.local,http://tauri.localhost,tauri://localhost`；
- 若用 443：证书挂载到 web 容器；若坚持 HTTP：只开 30010，按 §9.2。

### 10.2 fnOS 公网 NAS

- **直接 30010**：meowd 保持 `--bind=0.0.0.0`，应用内账号体系生效；TV/浏览器都填 `http://IP:30010`；
  - 代价：应用内 fpk 更新不可用（`/app-center/*` 只有 5666 网关有），升级走应用中心手动装；
- **仅网关**：`MEOW_SHELL_BIND=127.0.0.1`，只暴露 5666；浏览器可用（fnOS 登录 + 应用内账号二次登录），
  **TV 远程不可用**（TV 页面 `http://meow.local` 跨源拿不到 fnOS Cookie）；
- **推荐给 TV 远程**：30010 + 应用内账号，或同机反向代理 443 → 127.0.0.1:30010。

### 10.3 客户端与认证方式

| 端 | 页面来源 | 认证方式 | 备注 |
|---|---|---|---|
| Web / iPhone PWA | 部署的 web 同源 | 账号密码 → 会话 Cookie | 支持改密；不支持注册/网页找回 |
| TV 壳（本地网关） | `http://meow.local` 本地资源 | **无** | API 只在本机 127.0.0.1，不经网络 |
| PC 壳（本机插件） | `tauri://localhost` 本地资源 | **无** | 同上 |
| TV 壳（连公网/局域网后端） | `http://meow.local` | **设备令牌** | 播放另用 `mt`；不用 Web 登录 |
| PC 壳（连远后端） | `tauri://localhost` | **设备令牌** | 同上 |
| Fongmi / TVBox | 第三方壳 | `configKey`（`?key=`） | 只读 `/config.json` 与 jar |
| 脚本 / CLI / AI 外部调用 | 无页面 | 设备令牌 | 建议发只读或短有效期令牌 |

### 10.4 哪些端会出现 Web 登录

| 场景 | 登录页 | 原因 |
|---|---|---|
| 浏览器打开 Docker 的 web 端口 | ✅ | 页面与 API 同源，服务端有密码 |
| 浏览器打开 fpk 的 30010 | ✅ | 同上 |
| 浏览器通过 fnOS 5666 打开 `/app/meow/` | ✅（fnOS 登录后还要应用登录） | 两次认证：网关 + 应用 |
| TV 壳用本机网关 | ❌ | 页面本地、API 回环 |
| PC 壳用本机插件 | ❌ | 同上 |
| TV/PC 连远端后端 | ❌ | 页面本地、跨源；只用设备令牌 |
| TV 浏览器手动打开公网 web 地址 | ✅ | 这时它就是普通浏览器 |

**结论**：Web 登录只属于"浏览器 + 同源 web"；所有壳的本地页面都走令牌，不会弹登录页。

### 10.5 设备令牌怎么按端自定义

令牌是"设备/脚本"的凭证，不是账号。可配置项：

| 字段 | 说明 | 默认 |
|---|---|---|
| `name` | 设备名（TV-客厅 / PC-办公室 / 脚本） | 必填 |
| `expiresAt` | 过期时间；临时分享用 7 天，自有设备可不填 | 不过期 |
| `scope` | `full`（读写）/ `read`（只读：搜索、历史、播放地址） | `full` |
| `bindIp` | 可选绑定出口 IP（公网 HTTP 模式建议开） | 关 |
| `revoked` | 单设备立即失效 | — |

发放方式：

1. **网页生成**：登录后在「设置 → 设备令牌」新建，明文只显示一次；
2. **配对码（推荐给 TV）**：TV 显示 6 位配对码并轮询 → 用户在已登录的网页输入配对码 → 服务端签发令牌给 TV，避免遥控器输入 43 位字符串；
   - 配对码 5 分钟有效、一次性、每 IP 限 5 次/分钟；
   - 流程：`POST /api/auth/pair/start`（TV，匿名，返回 code）→ `POST /api/auth/pair/approve`（Web，需会话，body=code）→ `GET /api/auth/pair/poll?code=`（TV，返回一次性 token）；
   - 服务端记录 code → 批准的设备名/IP；轮询成功即删除 code；
3. **首启令牌**：首次启动打印一个 `initial` 令牌，用于第一个 TV/脚本；之后可撤销；
4. **旧版迁移**：`meow.authToken` / `MEOW_AUTH_TOKEN` 自动变成 `legacy`/`env` 设备令牌。

约束：

- 设备令牌只走 `X-Meow-Token`，**永不进 URL**；
- 最多 20 个；列表不返回明文；`lastUsed` 每小时最多落盘一次；
- 撤销/轮换立即生效；"全部撤销"会踢掉所有 TV/PC，但浏览器会话不受影响。

### 10.6 账号生命周期：注册 / 改密 / 找回

**应用内账号（默认，单管理员）**：

| 能力 | 是否支持 | 做法 |
|---|---|---|
| 注册 | ❌ | 单管理员；首启 setup 设密码。多用户不做 |
| 改密码 | ✅ | Web 登录后「设置 → 账号」；旧会话全部失效，设备令牌可选保留/撤销 |
| 找回密码 | ❌（无邮件） | 服务器本机 `apiserver --reset-password`；删 `policy.json` 的 `auth` 段可重新 setup |
| 2FA | ❌ | 需要时走下面的开源 IdP 方案 |
| 审计 | 基础 | 登录成功/失败、令牌创建/撤销写日志（不含明文） |

**为什么要"套开源"而不是自己造注册/找回**：注册、邮箱验证、密码重置、2FA、防撞库是一整套用户生命周期，自己写必留漏洞。需要这些能力时，直接前置一个成熟 IdP：

| 方案 | 形态 | 注册/找回 | 2FA | 运维成本 | 适合 |
|---|---|---|---|---|---|
| **Authelia** | 单容器 + 文件/LLDAP 用户库 | 无自助注册；重置靠管理员 | TOTP/WebAuthn | 低 | 单管理员/小团队，只要 SSO+2FA |
| **Authentik** | Server+Worker+Postgres+Redis | ✅ 注册/找回/邀请 | ✅ | 中 | 需要完整用户生命周期 |
| **Casdoor** | 单二进制 + SQLite/MySQL | ✅ 注册/找回/OIDC | ✅ | 低-中 | 想要单二进制 + 完整功能 |
| Keycloak | Java + DB | ✅ | ✅ | 高 | 企业级，不推荐自建小应用 |

集成方式（二选一）：

1. **Forward-auth**（Authelia 最常见）：反代先问 IdP，通过后注入 `Remote-User` 头；应用只信任来自回环的该头，不再自己做 Web 登录；
2. **OIDC**（Authentik/Casdoor）：应用做标准 OIDC 客户端，登录跳转 IdP，回调换会话。

**两种模式的重要边界**：

- IdP 只解决**浏览器**的登录/注册/找回/2FA；**TV/PC/Fongmi 仍然用应用自己的设备令牌与 configKey**——不要让 TV 走 OAuth；
- 走 IdP 时仍建议保留应用内"设备令牌"管理页（由 IdP 保护），否则 TV 无法接入；
- 走 IdP = 必须有反代；不用反代就保持应用内单管理员模式。

**选型建议**：

| 需求 | 选 |
|---|---|
| 只有自己/家人，单管理员 | **应用内账号**（Mode A）：不引入额外服务，改密用网页、找回用 CLI |
| 要自助注册/找回密码/2FA/多用户 | **Authentik**（完整生命周期）或 **Casdoor**（单二进制） |
| 只要 SSO + 2FA，不要自助注册 | **Authelia**（最轻） |

无论选哪种，**不要把"注册/找回/2FA"自己写**：那套东西的边界条件（枚举、限流、令牌吊销、邮件投递）比播放器还多，成熟 IdP 已经踩完了。

### 10.7 分体部署（web 与后端分离）

- **web 前置 + 远端 apiserver**：浏览器登录发生在 web 域（Cookie 同源）；web 的 nginx 把 `/api` 反代到远端 apiserver，并透传 `X-Meow-Token`/`mt`；
- **TV/PC 连分体部署**：后端地址填 **web 的地址**（不是 apiserver），用设备令牌；不要直接暴露 apiserver；
- **多个 web 前端共用一个后端**：会话 Cookie 按 origin 各自独立；设备令牌与 configKey 存在后端，天然共享；
- **纯后端（没有 web）**：没有 Web 登录；只发设备令牌 + configKey，适合只给 TV/脚本用。

## 十一、兼容与迁移

| 场景 | 行为 |
|---|---|
| 现有局域网部署（无密码/令牌） | 完全不变 |
| 现有 `meow.authToken` 用户 | 自动迁移为 `legacy` 设备令牌；localStorage 继续可用 |
| TV 本地网关 / PC 本机插件 | 不启用认证，零影响 |
| 开启认证后首次访问 | 浏览器跳 `/login`；未登录的 `/api` 返回 401 |
| 忘记密码 | 服务器本机 `--reset-password`，不提供网页找回 |

## 十二、改造清单

### A 后端（`server/host/src/shared`）

| # | 改动 | 判据 |
|---|---|---|
| A1 | `requiresAuth(method,path)`：会话或设备令牌；白名单见 §五 | 无凭证 `GET /api/config` → 401；`/api/health` → 200 |
| A2 | 首启 setup + PBKDF2 密码 + 登录/退出/改密 | setup 令牌错误 → 403；正确 → 会话 |
| A3 | 会话 Cookie（HttpOnly/SameSite/Secure）+ sessionEpoch | 改密后旧 Cookie 失效 |
| A4 | 设备令牌 CRUD（哈希存储、撤销、lastUsed） | 列表不出现明文 |
| A5 | 媒体票 `POST /api/stream/ticket` + 两个 stream 端点校验 + HLS 重写 | 无票 → 401；换库/换 host → 403 |
| A6 | `configKey` 校验 + 无 key 不返回 ext + 轮换接口 | `?key=` 错 → 403 |
| A7 | WebDAV SSRF 加固（目标校验/方法限制） | 打 169.254 → 拒 |
| A8 | danmaku `?url=` 加 `isSafeHttpUrl` | 打回环 → 拒 |
| A9 | 登录/令牌失败限流 + 日志 scrub | 登录 5 次/分钟 → 429；令牌 10 次/分钟 |
| A10 | `/api/policy`、`/api/config`、备份导出排除密钥字段（auth/deviceTokens/configKeyHash/LLM key/库密码） | 响应中搜不到 hash/key |
| A11 | 安全头：CSP（禁内联/远程脚本）、X-Content-Type-Options、Referrer-Policy；CSP 防 XSS 拿会话发请求 | DevTools 无 CSP 报错，内联脚本被拒 |
| A12 | 废弃 `?token=` 的管理员令牌入口，只保留 header；媒体只用 `mt` | `?token=` 不再通过鉴权 |
| A13 | 设备令牌属性：name/expiresAt/scope（read 或 full）/bindIp/revoke；配对码接口 | 过期/只读/撤销均生效 |
| A14 | 可选 IdP 模式：只信任回环来的 `Remote-User`，不自己解析 JWT（或做标准 OIDC） | 伪造头来自非回环 → 拒 |

### B 前端（`client/apps/web`）

| # | 改动 | 判据 |
|---|---|---|
| B1 | 登录页 + 401 拦截 + 退出 | 登录后首页可用；退出回登录 |
| B2 | 设置页：账号密码、设备令牌列表/新建/撤销 | 新建只显示一次 |
| B3 | `proxyStreamUrl`/`libraryStreamUrl` 先取 `mt` 再拼 URL | 播放请求带 `mt` |
| B4 | 播放器不把 admin token 拼进 URL | 抓包只有 `mt` |
| B5 | TV/PC 的 token 输入沿用现有设置项 | 远端后端可用 |
| B6 | 设备令牌管理页：列表/新建（name/expiry/scope）/撤销 + **配对码批准** | 新令牌只显示一次；配对码 5 分钟内可用 |
| B7 | 账号页：改密码、退出全部会话；HTTP 模式显示令牌输入而非登录 | 行为与 `authMode` 一致 |

### C 部署（`deploy/` + `client/apps/fnos`）

| # | 改动 | 判据 |
|---|---|---|
| C1 | `MEOW_AUTH_MODE`、`MEOW_CONFIG_KEY`、`MEOW_ALLOW_CIDR` 进 `.env.example` | 默认不改变旧部署 |
| C2 | drpy/danmu 端口收口；web 只发布一个入口 | `ss` 无 0.0.0.0:30013 |
| C3 | web 容器 nginx TLS 模板（可选 443）；限流**不覆盖** `/api/proxy/`、`/api/library/stream`（播放并发分片） | 证书可用；HTTP→HTTPS；播放不被 503 |
| C4 | fnOS：`MEOW_SHELL_BIND` 策略/向导（直连 vs 仅网关） | 两种模式都能启动 |
| C5 | fnOS：meowd rustls（可选 TLS） | 证书路径生效 |
| C6 | 文档：Docker/fnOS 两套部署步骤 + TV/Fongmi 配置 | 照文档可复现 |
| C7 | 核对 TV 本地网关 / PC 本机插件只绑 127.0.0.1 | 局域网不可达 |
| C8 | 可选 IdP 部署样例（Authelia/Authentik/Casdoor 任选其一） | 浏览器走 IdP；TV 仍走令牌 |

### D 测试与验收

| # | 改动 | 判据 |
|---|---|---|
| D1 | 后端单测：密码哈希、会话、令牌、票 scope、configKey | 全绿 |
| D2 | 前端单测：401→登录→恢复；票刷新 | 全绿 |
| D3 | 外网断言脚本（见 §十三） | 全过 |
| D4 | 三端真机：浏览器播放、TV 原生播放、PC 远程、Fongmi | 全过 |
| D5 | 回滚演练 | 1 分钟回旧行为 |

## 十三、验收断言

```bash
H=https://meow.example.com

# 未登录
curl -i $H/api/config                    # 401
curl -i $H/api/health                    # 200
curl -i $H/config.json                   # 403（无 key）
curl -i "$H/config.json?key=WRONG"       # 403
curl -i "$H/config.json?key=$K"          # 200 且含 ext

# 登录
curl -c c.jar -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"..."}' $H/api/auth/login   # 200 + Set-Cookie
curl -b c.jar $H/api/config              # 200

# 设备令牌
curl -b c.jar -H 'Content-Type: application/json' \
     -d '{"name":"tv"}' $H/api/auth/devices                        # 200 一次性明文
curl -H "X-Meow-Token: $T" $H/api/state/history                   # 200

# 媒体票
curl -b c.jar -H 'Content-Type: application/json' \
     -d '{"kind":"library","lib":"nas","path":"电影/01.mkv"}' \
     $H/api/stream/ticket                                          # 200 {mt}
curl -o /dev/null -w '%{http_code}\n' "$H/api/library/stream?lib=nas&path=电影/01.mkv&mt=$MT"  # 200
curl -o /dev/null -w '%{http_code}\n' "$H/api/library/stream?lib=other&path=x&mt=$MT"          # 403

# SSRF
curl -b c.jar -H 'Content-Type: application/json' \
     -d '{"url":"http://169.254.169.254/","method":"GET"}' $H/api/webdav  # 拒绝
curl -o /dev/null -w '%{http_code}\n' "$H/api/proxy/danmaku?url=http://127.0.0.1:9979/api/config" # 拒

# 端口
ss -lntp | grep -E ':(30010|30011|30012|30013|443)'   # 只有入口在 0.0.0.0
```

## 十四、回滚

1. 关闭认证：`MEOW_AUTH_MODE=off` 或删除 `policy.json` 的 `auth/deviceTokens/configKeyHash` → 重启；
2. 行为立即回到 v1.2.18 的「无鉴权」模式；
3. `MEOW_CORS` 若收紧过，一起回滚，否则写请求会被 CORS 挡。

## 十五、残留风险与明确不做

| 项 | 结论 |
|---|---|
| 多用户/权限分级 | 应用内不做；需要注册/多用户/找回/2FA 时前置 IdP（§10.6），应用只信任 IdP 的用户头 |
| 网页找回密码 | 不做；只能本机 CLI |
| 管理员令牌进 URL | 禁止；只有 `mt`/`configKey` |
| HTTP 下密码登录 | 默认禁止；只允许令牌 |
| 拿到管理员密码/令牌 | 等于管理员（可导入 jar，等于 RCE 能力） |
| `/api/health` 泄露 dataDir | 接受；可选脱敏 |
| 静态首页公开 | 接受 |
| 纯 HTTP 公网 | 只防误闯/扫描，不防链路；建议 VPN |

## 十六、方案自查（本次 review 发现并已修正）

| # | 发现 | 修正 |
|---|---|---|
| 1 | setup 页若匿名可提交，公网可被抢先设密码 | 改为 setup 令牌只打印到服务端日志 |
| 2 | 媒体 URL 若直接用 admin token，会进日志/历史 | 改为短时 `mt`，admin token 只走 header |
| 3 | `mt` 若不限 scope，等于开放代理 | 绑库/路径前缀或 host 集合 + `isSafeMediaUrl` |
| 4 | HLS 分片相对路径会丢 `mt` | 代理 m3u8 时重写分片 URI 并带票 |
| 5 | TV 跨源拿不到 Cookie | TV 走设备令牌 + `mt`，不依赖 Cookie |
| 6 | 纯 HTTP 下密码登录反而更危险 | HTTP 模式禁用密码登录，只允许令牌 |
| 7 | 登录失败全局锁定可被用来锁死管理员 | 改为按 IP 退避，不做全局锁 |
| 8 | 会话无法撤销 | 服务端会话表 + `sessionEpoch` |
| 9 | 备份/WebDAV 同步可能带走密钥 | 导出排除 `auth/deviceTokens/configKeyHash` |
| 10 | `configKey` 进访问日志 | 这两个路径关 access log + 应用日志 scrub |
| 11 | 现有 `meow.authToken` 用户升级会断 | 自动迁移为 `legacy` 设备令牌 |
| 12 | fnOS 直连 30010 时应用内更新不可用 | 文档明确：升级走应用中心 |
| 13 | drpy 仍绑 0.0.0.0 | 部署清单强制收口 |
| 14 | 没有前置反代时如何 TLS | web 容器 nginx / meowd rustls 两个内置选项 |
| 15 | 密码哈希引入第三方依赖 | 用 JDK 自带 PBKDF2-HMAC-SHA256 |
| 16 | 反向代理终止 TLS 时，应用看不到 HTTPS | 只在受信代理（`MEOW_TRUST_PROXY` 回环）采信 `X-Forwarded-Proto` |
| 17 | 限流/白名单在代理后会把所有客户端当成 127.0.0.1 | 仅在受信代理下取 `X-Forwarded-For` 最后一跳 |
| 18 | 纯 HTTP 下网页 setup 会把密码/令牌送上网 | HTTP 模式只允许本机 `--set-password`，不开放网页 setup |
| 19 | 会话存内存，重启即失效 | 明示为设计取舍；设备令牌不受影响 |
| 20 | 会话/票表无限增长 | 会话上限 32、票表每分钟清理、单票 host 上限 64 |
| 21 | `authRequired` 仍按旧 `authToken` 计算 | 改为「有密码或任一设备令牌即 true」，并返回 `authMode` |
| 22 | 裸 fetch / EventSource / WebSocket 可能绕过统一封装 | 前端全量审计；`<video src>` 只能走 `mt` |
| 23 | `mt` 可能进访问日志 | 日志掩码（前 6 位）；configKey 路径关 access log |
| 24 | 设备令牌可能无限增长/写放大 | 上限 20 个；`lastUsed` 每小时落盘一次 |
| 25 | 证书续期无人负责 | Docker 用 certbot hook；fnOS 文档写明手工续期 |
| 26 | **代码核对**：`proxyUrl()` 不传任何凭证，HLS 分片/EXT-X-KEY 重写后不带 `mt` | 实现时把 `mt`（和投屏 `ct`）贯穿到 `proxyUrl` 及全部调用点 |
| 27 | `MEOW_ALLOW_CIDR` 若不含回环会挡掉 fnOS 网关/本机反代 | 回环永远放行 |
| 28 | `/api/policy` 除 auth 外还可能有 LLM key、库密码 | 脱敏范围扩到所有密钥字段；CSP 防 XSS |
| 29 | fnOS 网关是否透传应用 `Set-Cookie` / `Authorization` 未验证 | 实施前必须先实测；不通就只走直连 30010 或同机反代 |
| 30 | TV 本地网关若绑 0.0.0.0 会变成局域网无认证后端 | 核对只绑 127.0.0.1；文档写明"本地网关只允许回环" |
| 31 | 遥控器输入 43 位令牌不现实 | 增加 6 位配对码流程（TV 显示、网页批准） |
| 32 | 引入 IdP 后容易误以为 TV 也能 SSO | 明确 IdP 只保护浏览器；TV/Fongmi 仍用设备令牌/configKey |
| 33 | 分体部署时 TV 可能被指到裸 apiserver | 文档要求 TV 填 web 前置地址；apiserver 不对外 |

## 十七、工时

| 阶段 | 内容 | 工时 |
|---|---|---|
| 1 | A1–A4（鉴权核心：setup/登录/会话/设备令牌） | 2d |
| 2 | A5（媒体票 + HLS）+ B3/B4 | 1d |
| 3 | A6–A10（configKey/SSRF/限流/脱敏） | 1d |
| 4 | A13（令牌属性/配对码）+ B1/B2/B5/B6/B7 | 1.5d |
| 5 | C（Docker/fnOS/TLS/端口）+ C7 + D1–D3 | 1.5d |
| 6 | D4/D5（三端真机 + 回滚） | 1d |
| 7（可选） | A14 + C8（IdP：Authelia/Authentik/Casdoor 任选） | 1–2d |

合计约 **8–9 人日**（不含可选 IdP）；阶段 1+2 是最小可验证单元。
