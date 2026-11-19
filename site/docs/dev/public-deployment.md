# 公网部署与访问控制

把四容器起在公网服务器上需要补什么。**结论：只暴露 `web` 一个入口，认证分两半——
`/api/*` 交给 apiserver 的令牌，`/config.json` 交给 URL 密钥；不加反代、不加隧道。**

## 结论先行

| 判断 | 内容 |
|---|---|
| 入口 | 只发布 `web`（443）。`apiserver` / `danmu_api` / `drpy` / `sources` 全部只在内部 |
| `/api/*` | 一律要 `X-Meow-Token`（**含 GET**）。白名单只有 4 条 |
| `/config.json`、`/spider-latest.jar` | 匿名可达，但要求 `?key=`；这是 CatVod 生态唯一能带凭据的方式 |
| 令牌发放 | 首启自动生成，写进 `policy.json` 并在日志打印一次；`MEOW_AUTH_TOKEN` 可覆盖 |
| 三端影响 | **TV 本地网关、PC 本地插件零影响**（两者都不设令牌，走"未配 = 关闭"） |
| 不做 | 外部反代、隧道、nginx basic auth、用户体系（`architecture.md` 8.3 已禁） |

逐项改造清单见 [§八](#八、改造清单)：A 契约 / B 后端 / C 前端 / D 配置 / E 验收。

## 一、为什么认证必须分两半

三个出口的凭据能力不同，这决定了方案形状：

| 出口 | 谁在调 | 能带自定义 header | 能带 URL 参数 |
|---|---|---|---|
| `/api/*` | 我们的 Web / PC / TV（同一个 Vue 前端） | ✅ 已经在带 `X-Meow-Token` | ✅ |
| `/config.json` | Fongmi / TVBox / 我们的 TV 导入 | ❌ | ✅ |
| `/spider-latest.jar` | 同上 | ❌ | ✅ |
| `/`（静态） | 浏览器 | — | — |

两条推论：

1. **不能用 nginx basic auth**：WebView 与 Fongmi 都带不了 basic 凭据，做了就断三端。
2. **`/config.json` 不能靠应用层令牌**：它必须匿名可 GET，而 `ext` 里常常是 API key / cookie
   （`ApiServer.java:12020-12021` 原样透传）——所以只能用「URL 即密钥」这个生态惯例兜住。

## 二、威胁模型（当前形态暴露什么）

设 `web:30010` 对公网开放、令牌为空时的实际后果：

| 能力 | 入口 | 代码位置 |
|---|---|---|
| 拿到所有站点 `ext` | `GET /config.json`、`GET /api/config` | `/config.json` 分派 `ApiServer.java:1429-1431`；构造在 `catVodConfigJson`（`:11956`）/ `configJson`（`:13448`），ext 原样透传在 `:12020-12021` 与 `:13456-13457` |
| 看播放历史 / 收藏 | `GET /api/state/*` | `routes/StateRoutes.java:112-380` |
| 把服务器当正向代理 | `GET /api/proxy/stream?url=` | `ApiServer.java:10778`（`handleStream`） |
| 打内网 / 云元数据并回显响应 | `GET /api/webdav` + body 里的 `method` | `routes/LibraryRoutes.java:73-147`（`handleWebdav`） |
| 盲 SSRF（无 URL 校验） | `GET /api/proxy/danmaku?url=` | `ApiServer.java:9285-9309`（`handleDanmaku` 的直连分支） |
| 改策略 / 导配置 / 删备份 | `POST /api/policy`、`/api/config/*` | `ApiServer.java:1111-1136`（`writeRequiresAuth`） |

根因两条：

- `writeRequiresAuth` **先判 GET 全豁免**，再判手写黑名单（`ApiServer.java:1111-1136`）——黑名单漏了 8 项；
- `POST /api/webdav` 把方法藏在 body 里，而 `GET /api/webdav` 免鉴权 → 等于一条任意方法的 SSRF 隧道。

## 三、目标形态

```
公网 :443 ─► web (nginx)
             ├─ /api/*              ─► apiserver  要求 X-Meow-Token（含 GET）
             ├─ /config.json?key=   ─► apiserver  key 不符 → 403
             ├─ /spider-latest.jar?key= 同上
             └─ /                   ─► 静态（公开，前端包内无秘密）
```

端口收口（现状 vs 目标）：

| 服务 | 现状 | 目标 |
|---|---|---|
| `web` | `0.0.0.0:30010` | `0.0.0.0:443`（TLS 由本容器终结） |
| `apiserver` | `127.0.0.1:30011` | 不变 |
| `danmu_api` | `127.0.0.1:30012` | 不变 |
| `drpy` | **`0.0.0.0:30013`** | `127.0.0.1:30013` |
| `sources` | **`0.0.0.0:18080`** | `127.0.0.1:18080` |

`drpy` 那个口子必须收：它的 `POST /{site}/{action}` 会执行请求头里的 JS
（`server/drpy/server.js:301-313` 的注释记录了 2026-10-30 修 C1 的原因）。
现在它靠「没配 token 时只允许回环」兜住，但那是**依靠运气**，不是依靠边界。

## 四、实施清单

### 4.1 apiserver：令牌覆盖 GET

```java
// 白名单之外的任何方法都要令牌；未配令牌时保持旧行为（局域网自用不受影响）
private static boolean requiresAuth(String method, String path) {
    if (authTokenExpected().isEmpty()) return false;
    if ("OPTIONS".equalsIgnoreCase(method)) return false;
    return !(path.equals("/api/health")
          || path.equals("/healthz")
          || path.equals("/config.json")
          || path.equals("/spider-latest.jar"));
}
```

三条判据：

- **未配令牌 → 全部放行**。TV 本地网关与 PC 本地插件都不设令牌（见第五节），这条保证它们升级后不变。
- **`/api/health` 必须匿名**：局域网发现、容器 healthcheck、前端连不上时的降级判断都靠它。
- **`/config.json` 与 jar 交给 nginx 的 `?key=`**，apiserver 不做二次判定（避免两处漂移）。

### 4.2 令牌发放：默认自动生成

| 方案 | 便捷性 | 强度 | 结论 |
|---|---|---|---|
| 用户自己填 `MEOW_AUTH_TOKEN` | 要教他 `openssl rand`，实际会填 `123456` | 靠用户 | 仅作为覆盖入口 |
| **首启自动生成 → `policy.json` + 日志打印** | 一行 env + 看一次日志 | 32 字节 base64url | ✅ 采用 |
| 首启生成并显示在首页 | 最省事 | **任何人打开首页都能看到** | ❌ 禁止 |

打开方式：

```ini
# 只在公网部署时加这一行；局域网自用不要加
MEOW_AUTH_MODE=auto
```

行为：

1. `MEOW_AUTH_TOKEN` 非空 → 用它（最高优先级，CI / 迁移场景）。
2. 为空且 `MEOW_AUTH_MODE=auto` → 生成 32 字节随机，写进 `{dataDir}/policy.json` 的 `authToken`，日志用方框打印一次。
3. 两者都没有 → 鉴权关闭（保持现状，**升级不会打断任何现有部署**）。

查看令牌：

```bash
docker compose logs apiserver | grep -A2 '访问令牌'
```

改令牌：改 `./data/policy.json` 的 `authToken` 后重启 apiserver（或重新设 `MEOW_AUTH_TOKEN`）。

### 4.3 nginx：TLS + `?key=` + 限流 + 安全头

官方 nginx 镜像会对 `/etc/nginx/templates/*.template` 做 envsubst，所以**挂一份自己的模板即可，不改镜像**：

```yaml
services:
  web:
    ports: ["443:443"]
    volumes:
      - ./nginx.secure.conf.template:/etc/nginx/templates/default.conf.template:ro
      - ./certs:/etc/nginx/certs:ro
    environment:
      MEOW_APISERVER: http://apiserver:9979
      MEOW_CONFIG_KEY: ${MEOW_CONFIG_KEY:?公网部署必须设}
```

模板要点：

```nginx
# limit_req_zone 必须在 http 上下文；本模板渲染到 conf.d/，正是 http 上下文
limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;

server {
    listen 443 ssl;
    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    # 后端用变量形式，必须自带 resolver（Docker 内建 DNS）
    resolver 127.0.0.11 valid=5s ipv6=off;
    set $meow_backend "${MEOW_APISERVER}";

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy no-referrer always;

    # 前端存活探针（不依赖后端）+ 后端探活（局域网发现与容器 healthcheck 都用它）
    location = /healthz { default_type application/json; access_log off;
                          return 200 '{"ok":true,"role":"web"}'; }
    location = /health  { proxy_pass $meow_backend/api/health; access_log off; }

    # ---- 匿名出口：URL 即密钥 ----
    location = /config.json {
        if ($arg_key = "") { return 403; }                  # 空 key 兜底：env 漏配时不放行
        if ($arg_key != "${MEOW_CONFIG_KEY}") { return 403; }
        proxy_pass $meow_backend/config.json;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location = /spider-latest.jar {
        if ($arg_key = "") { return 403; }
        if ($arg_key != "${MEOW_CONFIG_KEY}") { return 403; }
        proxy_pass $meow_backend/spider-latest.jar;
        proxy_set_header Host $http_host;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    # ---- 流式端点：禁限流（一次播放会并发多个 Range 分片）----
    location ^~ /api/proxy/ {
        proxy_pass $meow_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
    location ^~ /api/cache/ {
        proxy_pass $meow_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    # ---- 其余 API：限流；令牌由 apiserver 判 ----
    location /api/ {
        limit_req zone=api burst=40 nodelay;
        proxy_pass $meow_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }

    location / { try_files $uri $uri/ /index.html; }
}
```

四个容易踩的点：

1. **`if` 只能单独配 `return`**（上面两处属于允许范围），别在里面写 `proxy_pass`。
2. **`limit_req` 不能盖到 `/api/proxy/` 与 `/api/cache/`**：一次播放会并发十几个 Range 分片，全局限流会让播放器收到 503 后重试、表现为卡顿。所以这两条用 `^~` 单独放行（`^~` 优先于前缀 `/api/`）。
3. **不要在 `location` 里写 `add_header`**：nginx 的 add_header 一旦在 location 出现就**不再继承** server 级的那三条安全头。`/config.json` 需要的 `no-store` 后端自己会发（`sendText` 统一加）。
4. **`$meow_backend` 是变量，必须配 `resolver`**，否则容器内解析不到 `apiserver`（这是现有模板里就有的一行，别漏抄）。

### 4.4 三个必须一起修的 bug

| 问题 | 修法 | 为什么边界层替代不了 |
|---|---|---|
| `GET /api/webdav` 可执行任意方法 | `method != GET` 时要求令牌，或直接限制来源为回环 | 它是「绕过边界」的：`APISERVER_BIND=0.0.0.0`（文档支持给 TV 直连）时对整条局域网开放 |
| `/api/proxy/danmaku?url=` 无 SSRF 校验 | 加 `UrlSafety.isSafeHttpUrl`（与 `/api/parse` 对齐） | 同上；且 169.254 元数据一旦可达，等于交出云主机 |
| `writeRequiresAuth` 黑名单漏 8 项 | 改成 4.1 的白名单式 | 令牌形同虚设 |

### 4.5 `MEOW_CORS`（★ 最容易把三端打断的一步）

公网部署要收紧，但**不能只填域名**——三端的页面来源各不相同：

| 端 | 页面来源（Origin） | 来源依据 |
|---|---|---|
| Web / iPhone PWA | `https://meow.example.com` | 浏览器地址 |
| **TV 壳** | **`http://meow.local`** | `MainActivity.java:317-330` 自己拦的虚拟源（**故意不用** `WebViewAssetLoader`，否则 https 页面加载 http 图片会被拦，表现为卡片全没图） |
| **PC（Tauri）** | `tauri://localhost` 或 `http://tauri.localhost` | Tauri 2 的自定义协议，随平台不同 |
| 局域网直连 | `http://192.168.x.x:30010` | 浏览器 / TV 填的地址 |

所以正确写法是把它们全列上：

```ini
MEOW_CORS=https://meow.example.com,http://meow.local,http://tauri.localhost,tauri://localhost,http://192.168.1.10:30010
```

**漏一个的后果不是"写操作失败"，是整页空白**——前端首个写请求 403 就停在空状态。2026-11-02 踩过一次（`ApiServer.java:1160-1161` 的注释记着：写门禁连 `192.168` 都没放行，局域网部署首页第一个 POST 就 403）。

实操建议：**先在 `MEOW_CORS=none` 下抓一次真实 Origin**（后端 403 时会把 Origin 打出来，或看浏览器 DevTools → Network → 请求头），逐个加进去，最后再切正式值。

理由（为什么默认是 `*`）：`originAllowed()` 在 `corsAllowList()==null` 时直接 `return true`（`ApiServer.java:1157`）。令牌走自定义 header 本身免疫 CSRF，但收紧 CORS 后连「读响应」也堵上，所以公网值得做——代价就是上面这张源表必须齐全。

> `architecture.md` 6.1 的 S4 写的是「与 token 无关，默认部署也生效」，与代码不符——已在 6.1 更正。

### 4.6 回滚

改坏了怎么在 1 分钟内退回「无鉴权」：

```bash
# ① 关掉令牌（最快的止血，不重启也能生效的是 policy.json 那条，但建议重启）
docker compose exec apiserver sh -c 'sed -i "s/\"authToken\": *\"[^\"]*\"/\"authToken\": \"\"/" /data/policy.json'
docker compose restart apiserver

# ② 或者直接改 .env，把这一行留空后 up -d
MEOW_AUTH_MODE=
MEOW_AUTH_TOKEN=
```

`authTokenExpected()` 的读取顺序是 **env → policy.json**，所以只要两处都空就回到「全部放行」。

回滚前先确认一件事：**`MEOW_CORS` 一旦收紧，回滚 token 仍然可能被 CORS 挡住写请求**——两条要一起回滚。

## 五、三端影响

| 形态 | 后端在哪 | 设令牌？ | 影响 |
|---|---|---|---|
| **TV 本地网关** | 端内 `GatewayServer`（9978），直接复用 `ApiServer` 类 | ❌ 不设 | **零影响**。`authTokenExpected()` 为空 → `requiresAuth` 返回 false |
| **PC 本地插件** | `plugins/apiserver`，`manifest.json` 的 `env` 为 `{}` | ❌ 不设 | **零影响** |
| **Web / Docker 公网** | `apiserver` 容器 | ✅ 自动生成 | 首访弹「输入访问令牌」；输对后存 `localStorage['meow.authToken']` |
| **TV / PC 连公网后端** | 远端 | ✅ 需手填 | 设置 →「写操作令牌」填同一个值（`SettingsView.vue:5100`）；不填就是 401 |
| **TV / PC 连局域网后端** | 局域网 `http://<IP>:30010` | 看那台后端 | 设了就填，没设就不用 |

三个细节：

1. **TV 本地网关是同一份 `ApiServer` 代码**（`GatewayServer.java:11`「直接复用 apiserver 的 ApiServer」），
   所以令牌规则天然一致——它只是不设令牌而已。
2. **TV 壳自己的 `X-Meow-Token` 是另一回事**：那是 `DebugServer` / `PushServer` 的调试通道令牌，
   与后端令牌无关，别混用。
3. **三端共用一个前端**，所以「令牌输入页」写一次三端都有；无需为 TV 单独实现。
4. **每台设备各填一次**：令牌存的是 `localStorage['meow.authToken']`，而 localStorage **按 origin 隔离**——浏览器（https://域名）、TV 壳（http://meow.local）、PC（tauri 协议）是三份独立存储，各填一次。这是 WebDAV 同步也不带它的原因（`STATE_PREFS_SYNC` 白名单里没有令牌）。
5. **判断要不要弹令牌页，用 `/api/health` 的 `authRequired`**（`ApiServer.java:1851`），别用 `/api/config`：
   health 是白名单端点、匿名可达，返回里直接有 `authRequired: true/false`。用探测业务端点会多一次 401 往返，而且 401 无法区分「没令牌」和「后端没起」。

### 哪个界面会被要求输入令牌

- **会**：连「设了令牌的后端」的 Web / PC / TV 界面（同一个 Vue 前端，行为一致）。
- **不会**：连本机网关（TV 端内 9978）、连本机插件（PC）的界面。
- **静态页面仍可打开**：不做反代认证时，陌生人能看到首页骨架与「输入令牌」空态，但拿不到任何数据。
  要让「连页面都进不去」，只能加反代/隧道认证——本方案明确不做（见第七节）。

## 六、验收断言

部署完从**外网**执行，九条全过才算通过：

```bash
H=https://meow.example.com
K=<MEOW_CONFIG_KEY>

curl -s -o /dev/null -w '%{http_code}\n' $H/api/config            # 401
curl -s -o /dev/null -w '%{http_code}\n' $H/api/health            # 200（探活不能坏）
curl -s -o /dev/null -w '%{http_code}\n' $H/health                # 200（局域网发现走这里）
curl -s -o /dev/null -w '%{http_code}\n' "$H/config.json"          # 403
curl -s -o /dev/null -w '%{http_code}\n' "$H/config.json?key="     # 403（空 key 兜底）
curl -s -o /dev/null -w '%{http_code}\n' "$H/config.json?key=$K"   # 200
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "X-Meow-Token: T" $H/api/config                            # 200
curl -s -H "X-Meow-Token: T" "$H/api/webdav" \
     -d '{"url":"http://169.254.169.254/","method":"GET"}' | head -c 120   # 被拒
# 三端真实 Origin 各发一次写请求（TV=meow.local，PC=tauri，Web=域名），都要 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Origin: http://meow.local" \
     -H "X-Meow-Token: T" -X POST $H/api/state/prefs -d '{"prefs":{}}'    # 200
```

端口侧：

```bash
ss -lntp | grep -E ':(30010|30011|30012|30013|18080|443)'   # 只有 443 在 0.0.0.0
```

## 七、不做与残留

| 项 | 原因 |
|---|---|
| 外部反代 / Cloudflare Tunnel | 用户限定：只用现有容器 |
| nginx basic auth | WebView 与 Fongmi 带不了凭据，会断三端 |
| 用户体系 / 多用户 | `architecture.md` 8.3 已定不做；单用户自用 |
| `ext` 脱敏 | 破坏 CatVod 兼容（3.1）；改由 `?key=` 保护 |
| GET 全豁免（现 S2） | 公网部署下等于全公开读，必须收成白名单 |

残留风险（接受）：

- 拿到令牌的人 = 管理员；令牌泄露即等于交出后端（可改 policy、可导入远程 jar）。
- 静态前端公开，别人能看出这里跑着猫窝。
- **`/api/health` 匿名且带 `dataDir` 绝对路径与 `disabled` 站点名**（`ApiServer.java:1869`）——公网可见部署路径。要隐藏就得在 `healthJson()` 里脱敏，本方案接受。
- **无域名场景**：纯 IP 只能自签证书，浏览器会报警告；而且 `?key=` 走明文 http 等于公开。公网部署应配域名 + 真证书。
- `/config.json?key=` 的 key 会进 nginx access log 与浏览器历史——换 key 时两处都要改。
- 证书由宿主签发与续期，本方案不含自动续期（可加 `certbot renew --deploy-hook 'docker exec meow-web nginx -s reload'`）。

## 八、改造清单

按依赖顺序，勾一项验一项。**A 组先做**——鉴权语义变化属于契约变更，文档不同步会让三端实现对不上。

### A 契约与文档

| # | 改动 | 位置 | 判据 |
|---|---|---|---|
| A1 | 鉴权语义改写：GET 也要令牌、白名单 4 条、`?token=` 是否保留 | `api-contract.md` §1.2（第 63–79 行） | 与本文 §4.1 一致 |
| A2 | 安全清单补「前提：不对公网暴露」+ 修正 S4 | `architecture.md` §6.1 | ✅ 已改 |
| A3 | 同步清单加「鉴权范围变更」一行 | `site/README.md` 的「改功能同步哪些页」 | 三端文档都被指向 |

### B 后端（`server/host/src/shared`）

| # | 改动 | 位置 | 判据 |
|---|---|---|---|
| B1 | `writeRequiresAuth` → `requiresAuth`，白名单 4 条 | `ApiServer.java:1111-1136`（`writeRequiresAuth`） | 无令牌 `GET /api/config` → 401；`GET /api/health` → 200 |
| B2 | 调用点同步改名与语义 | `ApiServer.java:1283`（调用点） | 同 B1 |
| B3 | `MEOW_AUTH_MODE=auto`：首启生成 32 字节 → 写 `policy.json` → 日志方框打印 | `ApiServer.java:1104-1109`（`authTokenExpected()` 读取）+ policy 保存处 | 日志可见；重启后值不变；未设 env 时行为不变 |
| B4 | `handleWebdav`：`method != GET` 要令牌，或来源限回环 | `routes/LibraryRoutes.java:73-147` | `GET /api/webdav` 打 `169.254.169.254` → 被拒 |
| B5 | `handleDanmaku` 的 `?url=` 加 `UrlSafety.isSafeHttpUrl` | `ApiServer.java:9285-9309` | `?url=http://127.0.0.1:9979/api/config` → 被拒 |
| B6 | （P2）`authTokenMatches` 只认 header，去掉 `?token=` | `ApiServer.java:1169-1182` | `?token=` 不再生效 |
| B7 | 确认 `authRequired` 反映新语义、`/api/policy` 仍摘掉 `authToken` | `ApiServer.java:1851`（`healthJson`）、`10194`（`handlePolicy`，摘除在 `:10209`） | `GET /api/health` 的 `authRequired=true`；`/api/policy` 响应无 `authToken` |

### C 前端（`client/apps/web/src`）

| # | 改动 | 位置 | 判据 |
|---|---|---|---|
| C1 | 401 拦截 → 「输入访问令牌」空态页（复用 `meow.authToken`） | 新组件 + `api/index.ts:375`（已带 header） | 输错停页；输对进首页；清掉后重新要求 |
| C2 | 设置页文案「写操作令牌」→「访问令牌」 | `views/SettingsView.vue:5100-5106` | 文案与实际语义一致 |
| C3 | 排查是否有请求绕过统一封装（裸 `fetch` / `EventSource`） | `api/*.ts` 全量 `grep -n "fetch("` | 所有 `/api` 请求都带 `X-Meow-Token` |
| C4 | 令牌页的触发条件用 `/api/health` 的 `authRequired` | `api/health.ts` + 新空态页 | 后端关令牌时不弹；开令牌时弹 |

### D 部署配置（`deploy/docker`）

| # | 改动 | 位置 | 判据 |
|---|---|---|---|
| D1 | `drpy` 端口收口 | `docker-compose.yml:96-97` 及 `standalone` / `with-sources` 同名段 | `ss -lntp` 无 `0.0.0.0:30013` |
| D2 | `sources` 端口收口 | `docker-compose.with-sources.yml` | 无 `0.0.0.0:18080` |
| D3 | 新增 `nginx.secure.conf.template`（TLS + `?key=` + `limit_req` + 安全头） | 新文件 | 无 key 与空 key `GET /config.json` 都 403；有 key 200；播放分片不被限流 |
| D4 | `.env.example` 增加 `MEOW_AUTH_MODE`、`MEOW_CONFIG_KEY`，并把 `MEOW_CORS` 的注释改成「公网必填」 | `.env.example:65`、`:78` | 默认值不改变现有部署行为 |
| D5 | **采集三端真实 Origin**，写进 `MEOW_CORS`（域名 / `http://meow.local` / tauri 协议 / 局域网 IP） | 部署现场 | TV 与 PC 的写操作不再 403（该项漏做会整页空白） |

### E 测试与验收

| # | 改动 | 位置 | 判据 |
|---|---|---|---|
| E1 | 九条外网断言落成脚本 | `smoke/`（或 `server/host/smoke.py`） | §6 九条全过 |
| E2 | 前端单测：401 → 令牌页 → 输对恢复 | `client/apps/web/tests/` | `npx vitest run` 绿 |
| E3 | 回归：TV 本地网关、PC 本地插件 | 手动 | 两端不改任何配置仍能搜索与播放 |
| E4 | **回滚演练**：清 `policy.json` 的 `authToken` → 重启 → 三端恢复 | 手动 | 1 分钟内回到无鉴权，且不残留 401 |

### 顺序与工时

| 阶段 | 内容 | 工时 | 里程碑 |
|---|---|---|---|
| 1 | A1–A3 + B1–B3 + C1–C4 | 1.5 天 | 内网可跑通「弹令牌 → 输对 → 正常用」 |
| 2 | B4–B7 | 0.5 天 | 三条绕过边界的路径封死 |
| 3 | D1–D5 + E1 | 1 天 | 可开公网，九条断言全过；三端写操作不 403 |
| 4 | E2–E4 | 0.5 天 | 收尾 + 回滚演练 |

**阶段 1 是最小可验证单元**：做完就能判断整个方案成不成立（尤其要确认 TV/PC 连远端时前端真的带上了令牌）。
**阶段 3 的 D5 是最容易漏的一项**：`MEOW_CORS` 少一个 Origin，症状是整页空白而不是报错，排查成本最高。
