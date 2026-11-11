# 片库与离线缓存

> 本地 / NAS 影视接入（片库）与断网可看（离线缓存）的现状说明。
> 本文只写代码里成立的事实；每条结论后面标了出处，改代码前按符号名 grep 一次。

| 域 | 代码入口 | 说明 |
|---|---|---|
| 片库核心 | `server/host/src/shared/core/Library.java` | WebDAV / SMB / 本地目录三种类型的列举、探测与路径校验 |
| 片库路由 | `server/host/src/shared/routes/LibraryRoutes.java` | `/api/webdav`、`/api/library`、`/api/library/stream` |
| 缓存核心 | `server/host/src/shared/core/VideoCache.java` | 分片落盘、清单本地化、配额淘汰、批次、弹幕缓存 |
| 缓存路由 | `server/host/src/shared/routes/CacheRoutes.java` | `/api/cache/*`、导出与合并 |
| 前端契约 | `client/apps/web/src/api/library.ts` | 片库/缓存/转码/刮削的全部前端调用与文件名解析 |
| 前端页面 | `views/LibraryView.vue`、`views/LibraryAddView.vue`、`views/PlayView.vue` | 片库浏览、添加/编辑、直链播放分流 |

两条贯穿全文的边界：

- **片库与 `/api/proxy/*` 是两条通道**。代理接受任意 URL，靠 `UrlSafety` 兜 SSRF；片库只访问配置里声明过的那个根，路径由服务端拼接（`Library.java:20-26`）。不要合并。
- **缓存的目标不是省流量，是断网可看**。凡只让"第二次加载更快"的做法（HTTP 缓存、服务端代理缓存）都不满足这个口径（`VideoCache.java:22-26`）。

---

## 零、结论先行

1. **片库支持三种类型**：`webdav`、`smb`、`local`（`Library.java:178-185`，前端类型表见
   `LibraryAddView.vue:22-35`）。添加页另列了一个**置灰的「Alist网页」选项**作提示：
   没有独立的 AList 协议实现，AList 自带 WebDAV，按 `webdav` 填 `http://主机:5244/dav` 即可。
2. **片库不注册进 `SITES`**，因此不参与搜索/直播的全量扇出，也不进健康降级；
   代价是详情与播放走片库自己的端点，不复用 `/api/{site}/detail`（`ApiServer.java:1455-1468`）。
3. **元数据只有在线刮削一条路**：仓库没有 `.nfo` 解析器，也没有同目录图片约定
   （`grep -rn '\.nfo' server/host/src` 只命中 `Library.java:362` 的 MIME 映射
   与 `Scrape.java:20` 的一句注释）。刮削走豆瓣 `subject_suggest`，结果落盘、
   失败退化成文件名（`Scrape.java:30-33`）。
4. **缓存已实现到"断网能播完一集"**：分片 + 本地清单 + 弹幕 + 海报都在磁盘上，
   播放页查到 `state=done` 就直接播本地清单，不再打源站（`PlayView.vue:450-488`）。

---

## 一、片库：三种协议，一个片库层

### 1.1 三种类型的分工

| 类型 | `base` 写法 | `root` 含义 | 实现 |
|---|---|---|---|
| `webdav` | `http(s)://主机:端口/路径/` | 库根下的子目录 | `listWebdav`（`Library.java:187`） |
| `smb` | `smb://主机/共享名` | 共享内子目录 | `listSmb`（`Library.java:378`） |
| `local` | 后端所在机器的绝对路径 | 该路径下的子目录 | `listLocal`（`Library.java:232`） |

三条分支对外返回同一形状：`{ok, dirs:[...], files:[...]}`，条目字段是
`name / path / dir / size / type / mtime`。`path` 一律是**相对库根**的路径，
前端不需要区分协议（`Library.java:310-317` 的 `relLocal` 注释明确要求与 WebDAV 保持一致）。

### 1.2 配置形状与凭据

配置存在数据目录的 `library.json`（`Library.java:52`），与 `policy.json` 同级，
不进 `config.sites.json`——后者会被 `/api/config/import` 整体覆盖，片库列表不该被别人的配置清空。

- 保存时只保留认识的字段；`id` 过滤成 `[A-Za-z0-9_-]`、最长 48 字符，`base` 必填并补尾斜杠，
  `root` 归一化成「以 `/` 开头、不以 `/` 结尾」（`Library.java:92-116`、`:140-160`）。
- **空密码 = 不改**。整表提交时前端拿不到明文（`publicConfig` 只回 `hasPass`），所以 `pass`
  缺失或为空串时沿用旧值（`Library.java:84-110`）。踩过的表现：删掉 A 库时把 B、C 一起提交，
  没带 `pass`，其余库全部 401。
- 对外输出一律抹掉密码（`Library.java:120-138`），设置页/片库页看不到明文。

### 1.3 WebDAV：PROPFIND + 手写切片

- 用 **OkHttp** 发 `PROPFIND`。原因写死在 `Library.java:524-530`：`HttpURLConnection`
  的方法白名单不接受 `PROPFIND`（直接 `ProtocolException`），`java.net.http` 在
  `android.jar` 里完全不存在，而这份代码要跟 ApiServer 一起在 TV 端编译。
- 只请求五个字段：`displayname` / `resourcetype` / `getcontentlength` /
  `getlastmodified` / `getcontenttype`（`Library.java:535-539`）。目录条目通常没有
  `getcontentlength`，解析侧按 0 处理。
- 解析是**字符串切片，不引 DOM**（`Library.java:582-620`）：不同 NAS 用不同命名空间前缀
  （`D:` / `d:` / 无前缀），DOM 要配 namespace-aware 解析器才能读。`indexOfTag` 允许
  「空前缀或 `xxx:`」，`resourcetype` 里含 `:collection` 即判目录。
- `Depth: 1` 会把目录自身也列出来，按 href 与请求目标比对后剔除（`Library.java:196-200`）。
- href 是 URL 编码的，且**不能整体 `URLDecoder.decode`**——它会把路径里的 `+` 变成空格；
  代码按段解码并对 `+` 做转义保护（`Library.java:488-506`）。
- 单次响应体上限 **8M 字符**（Java `String.length()`），超了抛「目录列表过大」
  （`Library.java:565`）。WebDAV 没有分页，"一次列多少"只能靠这个上限 + 前端逐层点。

> **注释与实现不一致**：`Library.java:572-574` 的注释写「要禁掉自动重定向」，
> 但下面的 builder 是 `.followRedirects(true)`（`:577`）。改这块时先决定以哪个为准。

### 1.4 SMB：smbj，容器里可用

- 依赖 `server/host/libs/smbj-0.13.0.jar`（连同 `asn-one`、`slf4j-api`）。选它而不是系统
  挂载的理由在 `Library.java:368-377`：容器里没有 `mount.cifs` 权限，而 smbj 是纯 Java，
  容器 / PC / TV 共用同一份代码。
- 列目录时 `.` 与 `..` 会被列出来，必须跳过，否则前端看到两个无效条目
  （`Library.java:391-393`）。
- `user` 为空时用匿名认证；`domain` 可选，空则由 smbj 按 WORKGROUP 兜底
  （`Library.java:445-456`）。

### 1.5 本地目录：白名单根

WebDAV 靠"只接受相对路径"防穿越；本地目录天生是绝对路径，必须另做校验：

- 库根 `base + root` 必须 `toRealPath()` 成功且是目录（`Library.java:270-283`）。
- 请求路径先 `normalize()` 消 `..`，再 `toRealPath()` 解符号链接；对不存在的文件回退到
  「父目录 realpath + 文件名」，最后要求结果仍以库根为前缀，否则抛「路径越界」（`Library.java:285-308`）。

### 1.6 路由与 Range

| 路由 | 方法 | 行为 |
|---|---|---|
| `/api/webdav` | POST | 通用 WebDAV 转发（同步/备份用），回 `{ok,status,body}` |
| `/api/library` | GET | 不带 `lib`：配置 + 每个库的顶层目录；带 `lib&path`：列目录 |
| `/api/library` | POST | 保存整表；`?action=test` 测试连接 |
| `/api/library/stream` | GET | 片库文件流，`lib&path`，Range 透传 |

- 三个片库路由在 `ApiServer.java:1455-1468` 显式注册，且 `path.startsWith("/api/library/")`
  直接 404。**必须这样**：落到 `/api/{site}/{action}` 兜底会把 `library` 当站点名去加载类。
- 概览（不带 `lib`）对每个库各列一次根目录，单个库连不上只在该条目上带 `error`，
  不拖垮整页（`LibraryRoutes.java:189-217`）。库多时这就是 N 次网络往返。
- `/api/library?scrape=1` 只是把 `scrape: true` 塞回响应（`LibraryRoutes.java:222-226`），
  **不返回元数据**；真正的刮削由前端另调 `/api/scrape`。
- Range 三套实现，语义一致但来源不同：WebDAV 原样转发 `Range` 并透传 `Content-Range`
  （`LibraryRoutes.java:301-329`）；本地目录自己解析单段范围（支持 `bytes=a-b` 与 `bytes=-N`，
  越界回 416，`LibraryRoutes.java:386-418`）；SMB 用 `File.read(buffer, offset)` 随机读
  （`LibraryRoutes.java:470-515`）。
- **WebDAV 分支在拼 URL 前必须挡 `..`**：OkHttp 的 `HttpUrl` 会做 dot-segment 归一化，
  `path=../../secret.mp4` 会被拼成库根之外的地址（`LibraryRoutes.java:248-264`，
  安全审计 H13 的实测结论）。本地/SMB 各自有前缀校验，只有 WebDAV 是字符串拼接。
- 本地/SMB 的流都带 `Accept-Ranges: bytes`；`Content-Type` 按扩展名映射，
  mkv 是 `video/x-matroska`、ts 是 `video/mp2t`（`Library.java:351-364`）。
- `/api/webdav` 的响应体超过 **20 万字符**截断（`LibraryRoutes.java:143`），给"备份文件列表"定的，片库不经过它。

### 1.7 文件名解析（前端）

片库的"剧集/电影"判断全部在前端做（`api/library.ts:106-404`），后端只给目录和文件。

解析顺序（`parseVideoName`，`library.ts:140-230`）：

1. `第N部` 先摘出来，记 `part`；若它出现在开头，标题直接用 `第N部`
   （电影合集 `第1部.1972.特效中英字幕...` 砍掉部号后首段是字幕说明，不是片名）。
2. 季集依次尝试：`S01E02` → `E02/EP02` → `第N集` → 开头 1–3 位数字 + 分隔符 →
   整个名字就是 `01` 这种纯数字。`E01` 是真实片库的主写法，只写 `S(\d+)E(\d+)` 会全部
   匹配不到（`library.ts:131-136`）；开头数字必须排除 `19xx/20xx`，否则 `1917.rmvb`
   会被当成第 1917 集。
3. 年份取第一个 `19xx/20xx`，并从标题里移除。
4. 标题取年份/季集之前那段，遇到画质/编码/发布组词表就停（`noise`，`library.ts:213-214`），
   遇到「中英字幕 / 国语 / 粤语」也停。

目录名另有一套（`parseFolderName`，`library.ts:261-275`）：`S01`、`第一季` 这类**纯季目录**
返回空标题，剧名要从上一层取；`毛骗S01`、`某某 第二季` 则拆出剧名与季号。

分组（`groupByTitle`，`library.ts:293-329`）：目录内**过半文件带集号**时判定为剧集目录，
统一归到文件夹名下（否则国产剧 `01 _ 郭女俠怒砸同福店.mkv` 会刷出 80 张卡）；
否则按解析出的片名分组（教父三部曲各自独立）。组内按 `episode || part` 排序。

目录定性（`dirKindOf`，`library.ts:356-365`）：`empty / browse / mixed / series / movies`。
`series` 要求**没有子目录**——`毛骗/` 下面有 S01–S03 三个季目录，它是"剧"但不是"一部剧"。

封面用哪个名字去刮（`coverTitleFor`，`library.ts:394-404`）：剧集用目录名；单片电影用
**文件名解析出的片名**（目录名常是豆瓣上没有的中文别名）；多部合集用目录名。

### 1.8 刮削：豆瓣

- 源是豆瓣 `subject_suggest`（无需 key），详情从移动版页面 `og:description` 里取评分与简介
  （`Scrape.java:30-33`、`fillDetail`）。
- 缓存文件 `scrape-cache.json`，key 是 `[lib|]归一化片名|年份`（`Scrape.java:107-111`）。
  带 `lib` 是为了两个库各有一部《教父》时不互相覆盖；不带 `lib` 是旧格式，仍可命中。
- **命中永久保留，未命中只记 10 分钟**（`Scrape.java:49`、`:59`）。踩过的坑：把"没查到"
  也按长 TTL 缓存，一次豆瓣抖动会让一批片名永远没有海报；且失败**不许覆盖已有成功记录**，
  只更新 `missAt`（`Scrape.java:325-333`）。
- 逐级降级：全名搜不到 → 中文片段 → 第一个词（`Scrape.java:299-315`），
  解决「白夜追凶 Day and Night」这类中英混排。
- 批量走 `POST /api/scrape`（body `{groups, lib}`），后端串行 + 间隔
  （`LIMIT_STREAK=4`、`GAP_MS=900`，`Scrape.java:486-488`）。连续失败 4 条判定限流，
  剩余条目原样返回并在末尾附哨兵 `{"__meta":{"rateLimited":true}}`（`Scrape.java:530-562`），
  前端负责过滤（`library.ts:585-613`）。
- 解除绑定用 `DELETE /api/scrape?title&year&lib`（`Scrape.unbind`，`Scrape.java:678-693`），
  会连带清掉旧的全局条目（`ApiServer.java:10878-10886`）。海报必须经 `/api/proxy/image`
  带豆瓣 Referer 取（`library.ts:626-631`），且该端点会**先查本地海报缓存**再发网络
  （`ApiServer.java:11176-11180`）。

### 1.9 转码兜底

浏览器放不了 MKV/HEVC，片库因此有一条独立转码路：

- 产物是 HLS，写在 `cache/transcode/<id>/`，分片 4 秒（`Transcode.java:37-39`）。
  选 HLS 不选 mp4 是因为 mp4 要等 moov 写完才能播，HLS 前两片出来就能起播（`Transcode.java:20-27`）。
- **必须重编码，不能用 `-c copy` 换容器**：HEVC 在 Chromium/WebView2 里没有解码器
  （`Transcode.java:28-33`）。
- 片库转码传 `lib + path` 给后端，而不是把 URL 交给 ffmpeg：本地目录的流地址是
  127.0.0.1（被 SSRF 防线拒），SMB 的 `smb://` ffmpeg 读不了（`LibraryRoutes.java:538-550`）。
  本地直接给绝对路径（零拷贝），SMB 先落临时文件 `<id>.src`；WebDAV 片库不走这条
  （返回 400 让前端用 `src` 传流地址，`LibraryRoutes.java:580-583`）。
- 幂等键是 `lib|path`（不是临时文件路径），`mode=status` 只查状态
  （`LibraryRoutes.java:585-596`）。
- **不能拿首次响应判成败**：首次只是把任务排上，`state=running` 且 `playlist` 为空。
  前端必须轮询，库转码超时 180s、在线转码 90s（`library.ts:439-500`）。

---

## 二、客户端界面

### 2.1 入口与页面

- 顶栏「片库」与「直播」并列，是一个独立路由 `/library`（`AppHeader.vue:286-297`、
  `router/index.ts:31`）。添加/编辑是另一个路由 `/library/add`（`:33`）。
- **片库配置不在设置页**。设置页只保留应用行为；片库的增删改在片库页本身
  （`SettingsView.vue:114-115`）。设置页现在有 16 个分区（`SettingsView.vue:3722-3738`），与缓存相关的是「存储」。
- `/offline` 只是重定向到片库页的「我的缓存」页签，兼容旧书签（`OfflineView.vue:1-15`）。

### 2.2 片库页的三级结构

`LibraryView.vue` 在一个页面里完成「目录 → 影片 → 播放」，布局对齐在线源：

- 根/目录层是海报卡片墙，复用 `PosterCard` 的视觉规格；影片层是详情页那种
  「海报 + 信息 + 选集」（`LibraryView.vue:9-13`）。
- 片库与缓存用**页签**分开（`tab: 'lib' | 'cache'`，`LibraryView.vue:59`），
  不再是上下堆叠。
- 缓存管理归到「我的缓存」页签（`CachePanel.vue`，`LibraryView.vue:803`）：
  一剧一张卡、按 `site|vodId` 聚合（数据来自 `GET /api/cache/grouped`），点开是页面内换层
  而不是弹层（TV 上弹层要跨两层挪焦点），单集操作收在选集下方一条操作条，
  作用于当前聚焦的那一集（`CachePanel.vue:76`、`:333`）。
- 海报缺失时用本地镜像兜底：TV 壳把海报字节与「片名 → 文件」映射存到
  `files/library/`，后端拉不到图时改指向本地副本（`LibraryView.vue:216-280`）。

> `CachePanel.vue:5-7` 的头注释仍写着「被 `/offline` 路由以 `compact=false` 使用」，
> 但 `/offline` 现在只做重定向（`OfflineView.vue:1-15`），组件只出现在片库页的缓存页签。

### 2.3 播放页的直链分流

片库播放**不能**走 `proxyStream`：

- 片库页 push 到 `/play/__library__`，query 带 `library` / `file` / `direct`
  （`LibraryView.vue:661`）。
- `PlayView` 用 `libraryDirect` 判定片库模式（`PlayView.vue:77-81`）；
  `playableSrc` 在这个分支里**原样返回**地址，不再包代理（`:266-274`）。
- 缓存播放同理：`offlinePlay` 为真时直接用 `playlist.m3u8` 相对地址。套上 `proxyStream` 会
  变成 `/api/proxy/stream?url=%2Fapi%2Fcache%2F...` 并 403（`PlayView.vue:275-282` 的注释）。
  自家 `/api/` 开头的地址（转码产物、缓存清单）也一律原样放行（`:288-290`）。
- 图片侧仍走代理：`posterUrl` 固定带豆瓣 Referer（`library.ts:626-631`）。

---

## 三、三端形态差异

### 3.1 Web / PC / TV

| 端 | 片库来源 | 备注 |
|---|---|---|
| Web | 后端配置的 webdav / smb / local | `local` 指"后端那台机器"的路径，浏览器读不到用户磁盘 |
| PC | 同上，另可直接写回本机目录 | 导出到本机用 `/api/cache/export-to`，后端只接受回环调用 |
| TV | 同上 | 壳加载本地 assets，BACK 与焦点由壳/页面协商 |

### 3.2 TV 的两个约束

1. **BACK 先问页面**。壳的 `onBackPressed` 会先调页面的 `window.__meowTvConsumeBack()`，
   页面返回 true 表示已消费，否则才 `goBack()`（`MainActivity.java:1396-1416`）。
   添加/编辑页因此注册了 `__meowTvPageBack`：它有两步（选类型 / 填地址），
   路由历史里没有这一层，不接管会跳过类型选择（`LibraryAddView.vue:157-180`）。
2. **`TileSelect` 在 TV 上不可用**。它的关闭路径是 `mousedown` 与 `Escape`
   （`TileSelect.vue:69-101`），而遥控器只发 D-pad 与确认键。类型选择因此必须是
   独立页面/路由，不能复用这个下拉。

### 3.3 为什么不做成 source

注册成 site 会被 `searchAll` / `liveAll` 全量扇出——每次搜索或直播都会给片库发请求；
而且首页只渲染当前源，片库会被埋进顶栏的源下拉里（`LibraryView.vue:5-8`）。
不注册的代价是详情/播放必须走片库自己的端点，这一点在路由层已落实
（`ApiServer.java:1455-1468`）。

---

## 四、离线缓存

### 4.1 判据与四个前提

判据只有一条：**拔掉网线后能完整看完一集**——画面、弹幕、拖进度、退出再进能续播
（`VideoCache.java:22-26`）。由此推出四个前提，实现分别落在：

1. 播放地址本地可达 → 缓存命中时返回 `/api/cache/{id}/playlist.m3u8`；
2. 清单内引用全部本地化 → 分片、`EXT-X-KEY`、`EXT-X-MAP`、字幕都改成同目录相对文件名；
3. 前端不被后端离线挡住 → 播放页先查本地缓存，命中则不调 `fetchPlay`；
4. 弹幕本地读 → `danmakuDiskGet` 先于上游请求。

### 4.2 落盘布局与 id

```
data/
  library.json                      片库配置（含密码）
  scrape-cache.json                 刮削缓存
  posters/                          海报落盘 + .index.json
  cache/
    tasks.json                      任务/批次清单（刻意不在 cacheRoot 下）
    video/<id>/                     一集
      playlist.m3u8                 引用已改成同目录文件名
      seg-00001.ts ...
      res-0.bin ...                 KEY / MAP / EXT-X-MEDIA 的产物
      poster.jpg                    按魔数嗅探扩展名
      meta.json
    danmaku/<md5(key)>.xml          全局弹幕缓存（不占视频配额）
    transcode/<id>/                 转码产物
```

- 缓存 id 是 `md5(site|vodId|ep)` 前 16 位（`VideoCache.java:211-221`）；前端有一份同算法的
  纯 JS 实现，用来"进播放页前先看本地有没有"而不多打一次网络（`library.ts:1066-1075`）。
- `meta.json` 字段：`id / site / vodId / ep / name / sourceUrl / bytes / segments /
  createdAt / at / percent / poster / posterFile / vodName / vodYear / vodArea / vodRemarks`。
  `at` 是最近一次访问，配额淘汰按它排序，与 `createdAt` 分开（`VideoCache.java:702-726`）。
- 缓存根默认 `cache/video`，可用 `policy.cacheDir` 指到别的盘；相对路径按数据目录解析，
  绝对路径原样用；建不出来或不可写就退回默认（`VideoCache.java:66-89`）。

### 4.3 一集的下载过程

`VideoCache.run`（`VideoCache.java:513-746`）的顺序是有意为之：

1. **先抓海报**。几 KB，视频几百 MB；m3u8 被防盗链拦时，卡片上至少还有图和片名。
2. 拉清单，必须以 `#EXTM3U` 开头，否则判失败（"这不是 m3u8 清单"）。
3. 主清单只取**第一档**（`EXT-X-STREAM-INF` 后第一条），多码率并存会把"缓存一集"
   变成缓存整部片的所有码率（`VideoCache.java:782-793`）。
4. 收集资源：分片行 + 所有 `URI="..."`（KEY / MAP / MEDIA）。字幕也一起下，否则断网时字幕消失。
5. 4 路并发下载（`PARALLEL=4`），每片先写 `.part` 再原子改名。
6. 重写清单：所有引用换成同目录文件名；没下到的分片保留原地址（这一段断网会失败，但整集
   不会全废）；缺 `#EXT-X-ENDLIST` 就补上，否则部分播放器当直播一直等（`VideoCache.java:697-699`）。
7. 一个分片都没下到 → 失败；否则 **分片齐了才预取弹幕**（抢带宽会让下载更慢，
   且 m3u8 都拉不到时白花时间）。

`EXT-X-BYTERANGE` 的分片按"整份文件各存一次"处理：同一 URL 在多行出现时按行号区分文件名。
浪费空间但不会播错——存字节区间需要额外解析 Range 语义（`VideoCache.java:574-580`）。

不做的事：**不把 HLS 合成 mp4**。仓库没有 ffmpeg 之外的复用能力，拼容器会丢掉"边下边播"；
导出时才有合并（见 §4.9）。

### 4.4 断点续传

判据是**文件存在且非空**，不比对字节数：上游分片会随广告插入变化，比长度会让
"已下载但上游改了"的分片永远续不上（`VideoCache.java:599-609`）。

先写 `.part` 再 rename 是必须的：直接写目标文件时进程被 kill 会留下"非空但截断"的分片，
而续传判据正是"非空"，那一片会被当成下好，表现为"播到某集必卡"（`:617-623`）。

续传不需要"下到第几片"的游标——文件名由清单行号决定，每个分片只由一个线程写，
`resume` 只是用同样的参数重跑（`VideoCache.java:1299-1308`）。`pause` 与 `cancel`
都只把状态置成 `paused` / `canceled`，区别只在用户意图，两者都能再续（`:1946-1954`）。
刻意不做"挂起线程再唤醒"：那要维护一组挂起中的 Future，进程重启后全丢，更脆。

### 4.5 配额与淘汰

| 项 | 默认 | 说明 |
|---|---|---|
| `policy.cacheQuotaGb` | 8 | `<=0` 表示不限制（`VideoCache.java:239-243`） |
| `policy.cacheEvictMode` | `lru` | `off` 只告警不删（`:245-248`） |
| 淘汰对象 | `state=done` | 按 `meta.at` 从小到大删，直到回到配额内（`:259-286`） |
| 淘汰豁免 | 正在下载的任务 | 它们还持有目录句柄，删了会让下载报错 |

`at` 在**读取本地清单时**刷新（`handleCacheFile` 里 `.m3u8` 分支调 `touch`），
不按创建时间：老片重看时 `createdAt` 不变，`at` 会刷新（`CacheRoutes.java:758-760`）。

改 `cacheDir` 必须重启后端：缓存根**进程内只解析一次**，否则任务跑到一半换盘，分片散落
两个目录、看起来"永远差几片"。`GET /api/cache` 的 `cacheDirReloadRequired` 就是告诉前端
这件事（`VideoCache.java:57-61`、`:95-101`）。

### 4.6 任务清单与重启恢复

- 清单在 `data/cache/tasks.json`，**不放 cacheRoot**：cacheRoot 可能被指到外接盘，
  换盘后还得能找到索引（`VideoCache.java:887-896`）。
- 原子写：`tasks.json.tmp` + rename；进程被 kill 不会留下半截 JSON（`:949-955`）。
- 分片进度每片都写会打满磁盘，`touchManifest` 按 **2 秒**节流（`:964-977`）。
- 启动时 `loadManifest` 把 `running` / `idle` 改判 `failed` + `error="backend restarted"`，
  有 `sourceUrl` 就置 `resumable`（`:1040-1045`）。**刻意不新增 `interrupted` 状态**：
  前端的状态联合里没有它，多一个值会让"下载中"的筛选静默漏掉这些任务。
- 清单剪枝：`done` 超过 7 天、批次超过 7 天从清单移除；失败任务不删，磁盘分片也不删
  （`pruneOldEntries`，`:1064-1085`）。

### 4.7 整季批量

`POST /api/cache/batch` 与 `POST /api/cache` 的 `items` 分支是两套东西：

- `batch` 走**全局固定 2 线程池**（`BATCH_POOL`，跨批次共享），一集下完再起下一集
  （`VideoCache.java:871-882`）。单批上限 500 集（`:884-885`）。
- 旧的 `items` 分支一次性把每集都 start，每集再 4 路分片：整季 20 集 = 80 条连接打同一源站，
  实测 429/断流（`library.ts:938-944`）。**不要退回那个分支。**
- 批次返回全部集的 id（含还没轮到的），没轮到的在任务表里是 `idle`，
  前端一拿到批次号就能渲染完整集列表（`VideoCache.java:1087-1093`）。

### 4.8 弹幕缓存

弹幕是"离线看完一集"的一部分，所以有两层缓存：

| 层 | 位置 | TTL | 说明 |
|---|---|---|---|
| 内存 | `TtlCache DANMAKU_CACHE` | 成功 30 分钟 / 失败 30 秒 | 上限 24 条（`ApiServer.java:8193`） |
| 磁盘 | `cache/danmaku/<md5(key)>.xml` | 30 天 | 读取时判过期，`VideoCache.DANMAKU_TTL_MS` |

磁盘 key 是 `dm|剧名|集`（`ApiServer.java:7569`），文件名取它的 MD5（`:8385-8388`）；
剧名要先去集号后缀，否则和播放时的 key 对不上。

三条必须遵守的规则：

1. **缓存一集时要预取弹幕**。弹幕原本只在播放时抓，于是"从没在线播过、直接点缓存"的剧
   断网后弹幕是空的。`VideoCache.run` 在分片齐后通过 `bindDanmakuPrefetcher` 回调
   `ApiServer.fetchDanmakuAuto`（`VideoCache.java:468-511`、`ApiServer.java:228-243`）。预取失败不算缓存失败。
2. **预取必须复用播放时同一个函数**。磁盘 key 是 `dm|<剧名>|<集>`，剧名 strip 规则或集数
   解析差一点就永远命中不了；core 包通过回调避免反向依赖入口类（`VideoCache.java:476-479`）。
3. **内存命中也要补落盘**。内存 30 分钟、磁盘 30 天，原来内存命中直接 return，
   "先在线看过再点缓存"的路径永远不写盘——日志说成功、磁盘零文件
   （`ApiServer.java:7573-7584`）。

第四条是后来补的坑：

4. **"只查有没有"的探测不能复用 `danmakuDiskGet`**。那个函数命中会刷新 lastModified 并
   把 activeKey 改成被探测的那一集——"检查下一集有没有缓存"这个纯读操作，反过来把正在播
   那集踢出保护范围。预取端点要用 `danmakuOnDiskUnread`（`ApiServer.java:8406-8419`）。

清理与配额：

- `GET /api/cache` 的 `danmakuBytes` / `danmakuCount` 与视频缓存分开统计，不占视频配额。
- `POST /api/cache/control` 的 `clearDanmaku` + `mode=expired|all`（默认 expired）。
- 配额 `policy.danmakuCacheQuotaMb` 默认 200MB，`danmakuCacheEvictMode` 同 `lru|off`
  （`VideoCache.java:1423-1437`）。判据是文件 `lastModified`：每次命中都会刷新，
  所以"最久没动"就是 LRU。
- 淘汰**永不动正在播的那一集**（`danmakuActiveKey`），写盘后额外保护刚写完的 key
  （`extraProtectKey`）。不能用 `touchDanmaku` 做这件事——那等于宣称"正在播"，
  预取下一集会顶掉真正在播那集的保护（`VideoCache.java:1440-1492`）。
- 设置页「存储」给两个按钮：清过期 / 全清。后端不返回 `danmakuBytes` 时显示 `—` 而不是 `0`。

### 4.9 导出

| 端点 | 行为 |
|---|---|
| `GET /api/cache/export?id=` | 下载单个文件；有 ffmpeg 则 `-c copy` remux 成 mp4，否则按序拼成 `.ts` |
| `POST /api/cache/export-to` | PC 直存到本机目录；**仅回环地址**可调 |

- 实际格式由响应头 `X-Meow-Export-Format` 说明（`CacheRoutes.java:437`）。
  浏览器下载读不到响应头，所以 Web 端只用它下载，格式提示交给 PC/TV。
- 合并只做 `-c copy`，超时 180 秒；`MERGING` 表挡住同一集并发导出，
  超过 10 分钟视为上次异常退出（`CacheRoutes.java:41-63`）。
- 下载中或正在合并的集拒绝导出，否则会得到一份不完整却"看起来成功"的文件。

### 4.10 端点表

```
# 必须进 ApiServer 的显式路由表（否则会被 /api/{site}/{action} 兜底当成站点名）
GET    /api/cache                      列表 + 总占用 + 配额 + 弹幕占用 + cacheDir
GET    /api/cache?id=                  单个任务状态
POST   /api/cache                      开始下载（单集；items 分支已不推荐）
DELETE /api/cache?id=                  删除缓存
POST   /api/cache/batch                整季批量（全局 2 路队列）
GET    /api/cache/status?batch=        批次聚合进度
GET    /api/cache/tasks                未完成任务（可续）
POST   /api/cache/resume               续传 {"id"} 或 {"ids":[]}
GET    /api/cache/export?id=           导出单文件
POST   /api/cache/export-to            写入本机目录（仅回环）
POST   /api/cache/control              暂停/取消/删除/清弹幕
GET    /api/cache/grouped              按剧聚合（「我的缓存」数据源）
GET    /api/cache/poster               本地海报

# 前缀分支，必须排在 /api/cache/ 兜底之前
GET    /api/cache/{id}/playlist.m3u8   本地清单（断网时播它）
GET    /api/cache/{id}/{file}          本地分片 / 密钥
```

排序不是风格问题：`/api/cache/batch`、`status`、`tasks`、`resume`、`export`、`export-to`、
`control`、`grouped`、`poster` 都在 `/api/cache/` 前缀分支之前，否则会被 `handleCacheFile`
当成"取某个 id 的文件"回 404，前端看到"批量下载接口不存在"这种假故障（`ApiServer.java:1469-1533`）。

`/api/cache/{id}/{file}` 是缓存分片唯一的出口（转码产物另有 `/api/transcode/{id}/{file}`）：

- `id` 与文件名都只允许单段，出现 `..` 或分隔符直接 404；
- 文件名还要拒 `:`——Windows 上 `resolve("P:policy.json")` 是盘符相对路径，能越出缓存目录
  （安全审计 C4，`VideoCache.java:1871-1893`）；
- 只在取 `.m3u8` 时 `touch`，否则一集几十上百个分片会把 meta 写爆；
- 支持单段 Range，`Cache-Control: public, max-age=31536000, immutable`
  （`CacheRoutes.java:736-796`）。

### 4.11 海报缓存

`/api/proxy/image` 先查 `data/posters/`，命中就一次网络请求都不发；断网超过一天或
WebView 缓存被清后，整面海报墙不会裂（`PosterStore.java:14-28`、`ApiServer.java:11176-11180`）。

- 文件名是 `sha1(url) + 扩展名`，按 URL 去重，天然支持多个片名共用一张图。
- 索引 `posters/.index.json` 只用于淘汰时知道"哪个 URL 对应哪个文件、多久没访问"，
  丢了会变成 orphan 目录、下次写入时清掉。
- 配额 500MB，单张超过 8MB 不存（防把视频/畸形响应当图片），淘汰到 90% 为止
  （`PosterStore.java:52-54`、`:253`）。
- 索引读取用双重检查而不是整方法 `synchronized`：热路径每张海报都调，
  实测 12 线程排队时 6 张并发每张 4.1 秒（`PosterStore.java:63-75`）。

---

## 五、与既有链路的关系

1. **不复用代理**。`/api/proxy/stream` 的目标是调用方任意给的 URL，`/api/library/stream`
   只认配置里的库 + 相对路径；合并等于把"任意 URL 访问"交给片库入口。
2. **不注册成 site**。片库不计入 `/api/sites`，不参与 `searchAll` / `liveAll`，
   也不影响健康降级；详情与播放走自己的端点。
3. **不写片库目录**。片库是只读资产：刮削结果写 `scrape-cache.json`，海报写 `posters/`，
   转码产物写 `cache/transcode/`，缓存写 `cache/video/`。
4. **`/api/health` 无条件上报 `webdav` 能力**（`ApiServer.java:1654`）。即便某次部署
   连不上任何 WebDAV，前端也不会隐藏相关 UI——这是已知的粗糙点，不是判据。
5. **`/api/webdav` 没有 SSRF 校验**，且 `writeRequiresAuth` 对 GET 一律放行
   （`ApiServer.java:1038-1042`），带 body 的 GET 可以绕过写鉴权。片库端点**没有**复用它的实现；
   这条通道留给同步/备份，单独按安全整改排期。

---

## 六、改这块之前必读

**① 片库与 `/api/proxy/*` 刻意分离，不要合并**
代理接受任意 URL；片库只访问配置里声明过的根，路径由服务端拼接。合并等于把"任意 URL 访问"能力交给片库入口。

**② `/api/library/stream` 必须支持 Range**
2GB 一集没有 206 就没法 seek；本地与 SMB 分支是自己实现的单段 Range，不要换成 `Files.copy`。

**③ 整季下载走 `/api/cache/batch`，不要用 `POST /api/cache` 的 `items` 分支**
后者每集再 4 路分片并发，整季 20 集 = 80 条连接打同一源站，实测 429/断流。`batch` 走全局 2 路队列（`VideoCache.BATCH_POOL`）。

**④ 续传判据是"文件存在且非空"，不比对字节数**
上游分片会随广告插入变化；分片先写 `.part` 再 rename，避免 kill 时留下"非空但截断"的文件被当成已下好。

**⑤ `policy.cacheDir` 进程内只解析一次**
每次重读会让任务跑到一半换盘、分片散落两个目录。改它必须重启后端（`GET /api/cache` 的 `cacheDirReloadRequired` 会告诉你是否还没生效）。

**⑥ 弹幕预取必须复用播放时的抓取函数，且不能顶掉"正在播"的保护**
磁盘 key 差一点就永远命中不了；`touchDanmaku` 只能标真正在播的那一集，预取下一集要用 `enforceDanmakuQuota(extraProtectKey)`，探测是否存在要用 `danmakuOnDiskUnread`（它不动 LRU 与 activeKey）。

**⑦ 转码不能拿首次响应判成败**
`POST /api/transcode` 只是把任务排上，此时 `state=running` 且 playlist 为空，必须轮询等分片就绪（实测踩过：界面报"转码不可用"，后端其实已有 79 个分片）。

**⑧ 缓存文件端点要同时挡 `..`、分隔符与 `:`**
Windows 的盘符相对路径（`P:policy.json`）能越出缓存目录读到 `policy.json`，里面有 `authToken`（安全审计 C4）。

---

## 附：按符号名定位

行号会漂，符号名不会。改这块时按下面的名字 grep：

```bash
# 片库核心
grep -n "listWebdav\|listLocal\|listSmb\|resolveLocal\|parseMultiStatus\|propfind" \
  server/host/src/shared/core/Library.java

# 片库路由与 Range
grep -n "handleLibrary\|handleLibraryStream\|sendLocalLibraryFile\|sendSmbLibraryFile\|hasDotDotSegment" \
  server/host/src/shared/routes/LibraryRoutes.java

# 缓存核心
grep -n "cacheRoot\|idFor\|enforceQuota\|private static void run\|prefetchDanmaku\|startBatch\|loadManifest\|clearDanmaku" \
  server/host/src/shared/core/VideoCache.java

# 缓存路由
grep -n "handleCache\|handleCacheFile\|handleCacheExportTo\|MERGING" \
  server/host/src/shared/routes/CacheRoutes.java

# 文件名解析与前端契约
grep -n "parseVideoName\|parseFolderName\|groupByTitle\|dirKindOf\|coverTitleFor" \
  client/apps/web/src/api/library.ts
```
