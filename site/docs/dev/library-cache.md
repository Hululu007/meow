# 本地 / NAS / 网盘 影视资源接入（三端）

> **状态：已实现**（2026-10-26 起）。本文保留设计推演与实测依据，**现状以代码为准**。
>
> - 后端：`core/Library.java`（webdav/smb/local 三类型 + Range 流）、`core/VideoCache.java`
>   （分片落盘 / 断点续传 / 8GB LRU 配额 / 导出 mp4·ts）、`core/Transcode.java`（MKV/HEVC 转 HLS）
> - 前端：`/library`、`/library/add`、「我的缓存」面板
>
> **实施与设计稿的出入**：AList 走 WebDAV 而非 `/api/fs/list`；本机直存用后端
> `POST /api/cache/export-to` 而非 Rust 网关。**读本文时把「要新做」当设计意图。**
> 用户视角的功能说明见 README。
>
> **⚠️ 全文 84 处 `文件:行号` 是写作时的位置，已大面积漂移。**
> 结论与判据（§七 的六条）仍然有效；要定位代码请按符号名重新 grep，不要直接用行号。
>
> **§零 是对用户真实 NAS 的实测**（2026-10-24），其余章节是读代码推断。
> 两者冲突时以 §零 为准——实测已确认那台 NAS 有可用的 WebDAV（PROPFIND 207 + Range 206），
> 不需要等 SMB 方案。
>
> **行号基线：一律按写作当时的 HEAD `3eeaacc`**（`ApiServer.java` 6029 行、
> `SettingsView.vue` 含 TV 专属的 `localexec` 分区）。仓库推进很快——
> 本文初稿写的是 `99b7710`（5833 行），此后 HEAD 已前进三次
> （`82575ce` → `5ad6a5a` → `5b8901d` → `3eeaacc`），后端行号整体下移了约 196 行。
> **所以：把行号当定位提示，不要当唯一依据；改代码前用符号名 grep 一次。**
> 本文所有后端引用都用方法名/常量名标注，例如
> 「`handleStream`（`:4502`）」，符号名永远有效，数字可能漂。
>
> **前稿（本文上一版）有几条被复核推翻的判断，已在文中逐条改掉**：
> ①「`javax.xml` 在精简运行时里没有」——宿主是完整 Temurin 17 JRE
> （`Dockerfile.apiserver:16`），`java.xml` 模块存在；
> ②「TV 是纯 WebView 壳」——TV 端已有原生 ExoPlayer（`NativePlayerActivity.java`）、
> JS 桥（`TvBridge.java` + `api/nativeBridge.ts`），并已入库
> （`82575ce` / `5ad6a5a`）；但它只在**播放失败后**兜底一次，不是主播放路径；
> ③「先用 2–3d 补目录列举端点」——这对 WebDAV 不成立，`POST /api/webdav` 早就能发
> PROPFIND；真正缺的是本地文件系统列举；
> ④ 文件名解析「4 条基础正则够用」——实测不够，见 §1.5。

### 零、真实环境实测（2026-10-24，覆盖本文的代码推断）

本文其余各章是**读代码**得出的结论。下面这组是对着用户真实 NAS 实测的，
凡是与代码推断冲突，以本节为准。

**被测环境**：Samba 服务器（`net view` 报 `nuc6 server (Samba TRIM)`），
`192.0.2.19`，445/139 开放，局域网 ping 1ms。19 个 SMB 共享，
视频库在 `视频` 共享下（Windows 侧映射为 Y:），顶层五个分类：
`18NO` / `其他` / `动漫` / `电影` / `电视剧`。

**★ 关键发现：它还开了 WebDAV，不需要等 SMB。**

| 探测 | 命令 | 结果 |
|---|---|---|
| 端口 | `/dev/tcp/192.0.2.19/5005` | **OPEN**（5006 也开，是 HTTPS 侧） |
| WebDAV 认证 | `curl -X PROPFIND -u ... -H 'Depth: 0' http://192.0.2.19:5005/` | **207 Multi-Status** |
| 匿名访问 | 同上不带 `-u` | 401（说明必须带凭据） |
| 根目录内容 | `PROPFIND Depth: 1` | 只有 `/视频/` 一个（DSM 把 WebDAV 根收窄到该共享） |
| 目录列举 | `PROPFIND Depth: 1 /视频/` | 五个分类目录，URL 编码形如 `/%E7%94%B5%E5%BD%B1/` |
| 文件字段 | `PROPFIND Depth: 1 /视频/电影/教父/` | `displayname` 有、**`getcontentlength` 有**（`8998666874`）、`getcontenttype` 有（`video/mp4`）、`getlastmodified` 有 |
| 目录条目 | 同上 | **没有** `getcontentlength`（目录只有 `resourcetype=collection`+`displayname`+`getlastmodified`） |
| Range | `curl -H 'Range: bytes=0-1023'` 对 10.6GB 的 mp4 | **206**，`size_download=1024` |

结论：**列表所需的全部字段（名字/大小/类型/时间）WebDAV 已经给全，且 Range 可用**。
所以 §1.3「WebDAV 先做」不只是成本低，而是**这台 NAS 上真的能立刻跑通**；
SMB 那条（`jcifs-ng`/`smbj`、9MB 依赖、TV 分支未定）在这台机器上完全不必要。

**片库规模与形态（决定实现细节，实测）**：

- **314 个视频 / 362.2GB**；`.mp4` 182 个、`.mkv` 132 个、1 个 `.txt`。
- **零封面、零字幕、零 `.nfo`**（`-Include *.jpg,*.png,*.nfo,*.srt,*.ass` 全部 0 命中）。
  → §1.4 说的「复用 `.nfo` + 同目录图片当基线」**在这台机器上等于没有基线**，
  实际能用的只有文件名解析。
- 单集 1.4–2GB（4K H265）；电影 8–10GB（如教父第 1 部 `9324242082` 字节）。
  → 这直接判定了 §4.3 前提①的实现方式：**后端绝不能把响应体读进内存**
  （现在 `handleStream` 的 `read(...)` 与 `byte[] data` 路径会 OOM），
  必须流式透传 + Range 转发。
- **132 个 `.mkv` 在浏览器里播不了**（Chromium/WebView/WebView2 对 MKV 容器支持极差，
  尤其 H265+AAC）。这不是代码能修的：要么 `-c copy` 转封装成 mp4 容器，要么转码；
  362GB 全转代价极大。**UI 必须明确提示「此格式需转封装」**，不能显示成一直加载。

**命名规则（文件名解析必须覆盖，实测样本）**：

| 类型 | 实例 |
|---|---|
| 剧集 | `白夜追凶.Day.and.Night.2017.E01.2160p.WEB-DL.H265.AAC-FLTTH.mp4` |
| 电影合集 | `教父/第1部.1972.特效中英字幕.BD1080P.X264.AAC.English.CHS-ENG.Mp4Ba.mp4` |
| 规模参考 | 武林外传 77 集 / 89.6GB；白夜追凶 32 集 / 50.6GB；毛骗 44 集 / 47.6GB |

两个坑：**是 `E01` 不是 `S01E01`**（只写 `S(\d+)E(\d+)` 会全部匹配不到）；
**`第N部` 表示不同部**（教父三部平铺在一个文件夹），不是季集号，
不能当「第 N 集」处理。

**并行改动说明**：本节写作期间另一会话在工作区加了 `NativePlayerActivity.java`、
`TvBridge.java`、`api/nativeBridge.ts`，并提交为 `82575ce`（TV ExoPlayer + ASS 字幕）
与 `5ad6a5a`（Web UI 接原生播放器桥）。这些已进 git，不再是「未提交改动」；
本文凡引用 TV 播放路径，按这两个提交之后的状态理解。

---

## 〇、结论先行

四个问题的答案，各一句话：

1. **接入**：WebDAV 先做、AList 第二、SMB 本轮不做；NAS 该走 WebDAV（协议已在、只差解析），
   AList 适合网盘（直链由服务端下发、天然免认证），SMB 在 JVM 侧零支持、PC 已被映射盘符覆盖，
   而开源刮削一个都不能直接用——仓库里 Kodi/TMM/TMDB/.nfo 四路全是 0 匹配，只能拿
   `.nfo + 同目录图片` 当基线、文件名当兜底。
2. **界面**：设置页现有 10 个分区，再新增第 11 个「本地片库」放**配置**，顶栏「直播」旁新增独立
   `/library` 路由放**观影入口**；类型选择必须用新写的居中模态（现有 `TileSelect`
   在遥控器上关不掉）。
3. **参考形态**：影视仓那个「请选择存盘类型」的三按钮竖排模态，Web/PC 可 1:1 复刻，
   TV 必须挂到路由上才能按 BACK 关；差异点是影视仓把它当**一次性向导**、
   我们当**可编辑的资源列表**。
4. **缓存**：断网可看现在三端都**做不到**，缺口不在「下载器」而在播放链路本身——
   播放地址被无条件包进 `/api/proxy/stream`，而该代理拒绝回环且不转发认证头。
   先做 PC、先做弹幕落盘，视频分片排在后面。

---

## 一、三端怎么接入 NAS / 本地 / 网盘

### 1.1 结论

**NAS 走 WebDAV，网盘走 AList，SMB 本轮不做，DLNA 与 HTTP 目录后置；刮削以
「复用 `.nfo` + 同目录图片」为基线，文件名解析为兜底，在线刮削作为可选后置。**

选型的真正瓶颈不是协议成本，而是**播放链路对本地/认证地址的支持**。协议再便宜，
播不出来就是零。所以本章的顺序是「先看清播放链路卡在哪，再谈接哪个协议」。

### 1.2 现状：片库已实现，WebDAV 转发仍在

后端已有一个通用 WebDAV 转发器：`POST /api/webdav`
（路由 `ApiServer.java:633`，实现 `handleWebdav` `:4776`）。它：

- 用 `java.net.http.HttpClient` 发任意方法（builder 在 `:4792`），
  注释 `:4789-4791` 明确记了「`HttpURLConnection` 发 PROPFIND 会抛 ProtocolException」这个坑；
- `PROPFIND` 自动补 `Depth`（默认 `"1"`，`:4812`）和一段固定 prop 请求体；
- 有 `user`/`pass` 时注入 Basic 认证（`:4807`）；
- 只回 `{ok, status, body}`，body 超 20 万字符截断（`:4850`），**不做任何解析**。

前端两个消费点都在拿正则扫 XML：`client/apps/web/src/stores/sync.ts:371` 用
`/<D:href>([^<]+)<\/D:href>/g` 取快照文件名，
`client/apps/web/src/stores/prefs.ts:494` 只是数字面量
`<D:href>` 出现次数当「目录里有几个文件」。

> 这两处的写法有个共同缺陷：**前缀写死 `D:`、且大小写敏感**。换一台返回
> `<d:href>` 或带其它前缀的服务器就会误判成「空目录」。新端点必须解析后计数，
> 不能沿用这个正则（详见 §1.7 第 1 步第 ④ 条）。

**片库层已经实现**（2026-11-04 核对；WebDAV / 本地 / SMB 三种入口有代码，AList 仍是 `disabled` 占位）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 片库端点/类 | `grep -rn "api/library\|LocalLibrary" server/host/src/shared client/apps/web/src` | 13（`routes/LibraryRoutes.java` + `api/library.ts` + `LibraryView.vue`） |
| 后端列目录 | `grep -rn "Files\.list\|Files\.walk\|walkFileTree\|newDirectoryStream\|listFiles" server/host/src/shared` | 18（`shared/core/Library.java`） |
| 静态文件路由 | `grep -rn "sendLocalLibraryFile" server/host/src/shared` | 2（`shared/routes/LibraryRoutes.java`） |
| 前端片库字样 | `grep -rn "片库\|本地目录\|网盘" client/apps/web/src` | 120 |

三端都有「本地目录 / NAS / WebDAV」配置项（AList 仍是 `disabled` 占位）。后端路由表里
**49 条 `equals(path)`**（2026-11-04 核对），片库相关在 `shared/routes/LibraryRoutes.java`。

### 1.3 三条协议路线，逐条给结论

#### WebDAV——先做，但**必须先修播放链路**

成本最低这件事有一半是假的。「能列目录」和「能播」是两件事：

- **列表侧**：只差把 XML 解析成结构化数组。`java.xml` 在 Temurin 17 JRE 里存在
  （`Dockerfile.apiserver:16` 是 `eclipse-temurin:17-jre`），字符串状态机或
  `DocumentBuilder` 都可以，不必引第三方库。
- **播放侧**：**这是硬阻塞**。前端 `client/apps/web/src/views/PlayView.vue:99-109`
  的 `src` computed 只放行 `/^https?:/i` 的地址，然后**无条件**
  `return proxyStream(url, ...)`；`client/apps/web/src/api/index.ts:467` 的
  `proxyStream` 只拼 `url` / `referer` / `ua` 三个参数。
  后端 `handleStream`（`:4502`）读的也只有 `url`/`referer`/`ua`/`Range`
  （`:4527` 读 Range、`:4545-4546` 设 Referer/Range），
  在 `:4502`–`:4700`（该函数体）区间 `grep Authorization|Cookie|userInfo` 命中 **0**。

  结论：**带密码的 WebDAV，即使目录列出来了，也放不出来。** 前端连
  `resultFromParser` 已经把 `cookie` 转成 `header.Cookie` 的那一层都没接
  （`client/apps/web/src/api/index.ts:482-484` 只取 Referer/User-Agent）。

#### AList——第二做，实际比 WebDAV 更容易出画面

`SITES.put("AList", "AList")` 在 `ApiServer.java:123` 已注册，`EXT` 表里**一条都没有**
（`grep -c 'EXT.put("AList"'` → 0）。`AList` 类的 ext 是一个 JSON 配置对象，不是目录路径
（字段定义见 （私有开发资料）；
`ApiServer.java:205-212` 的注释直接记了这次的实测：「Market/AList 的 init 拿不到 ext 就 NPE」）。

AList 的优势在于**直链由服务端下发**：列表与播放地址都走同一套 HTTP+JSON，
`raw_url` 自带签名，正好绕开「代理不转发认证头」这个缺陷。
证据（均在 （私有开发资料））：
`a_0.java:96` 取址走 `/api/fs/get`（v2 退回 `/api/public/path`）、
`:169` 列目录走 `/api/fs/list`、`:69` 探版本走 `/api/public/settings`；
直链字段名是 `url` 且兼容 `raw_url`（`c_0.java:40`：
`@SerializedName(alternate={"raw_url"}, value="url")`）。
所以同样不做认证透传，AList 能播、WebDAV 不能。

#### SMB——本轮不做，三条理由

1. **JVM 侧零支持**：`server/host/libs/` 恰好 6 个 jar，没有 jcifs-ng / smbj；
   要引 `smbj` 得连带 `bcprov` 等依赖，而仓库已有的 `bcprov.jar` 是
   **8.3MB**（`ls -l` 实测 8324412 字节，Bundle-Version 1.78.1），版本还得对齐。
   （前稿写的「约 9MB」是估算，未逐个 jar 核到字节；量级方向是对的。）
2. **PC 已被映射盘符覆盖**：Windows 把 `\\NAS\share` 映射成盘符后就是普通路径。
   这是通用判断，仓库内无对应代码可引。
3. **TV 走哪条分支还没定**：`client/apps/tv`（**57** 个 tracked 文件）**已**引入 media3
   （`client/apps/tv/app/build.gradle` 里 `media3` 出现 4 次，含 `media3-exoplayer:1.4.1`）；
   而 `tv/`（gitignore 掉的 Fongmi 分支副本，`.gitignore:82`、`git ls-files tv/` → 0）里
   `tv/catvod/build.gradle:32` 已 `api libs.smbj`。**先定 TV 走哪条，再谈 SMB。**

   > 注意：既然 `client/apps/tv` 已经引了 ExoPlayer，SMB 对 TV 并非「引不动」，
   > 而是「要不要为它再加 smbj」。这与前稿「TV 是 20KB 纯 WebView 壳所以引不了」
   > 的论证前提不同——**那条理由已作废**，只剩下「本轮不做、避免加依赖」。

#### DLNA / HTTP 目录——后置，且现状比前稿说的更差

- DLNA：全仓 `ContentDirectory|BrowseAction` 命中 **0**。`tv/` 分支只有
  「投屏出去」（`DLNACast.java`）和「当接收端」，没有媒体服务器浏览。
  前稿说「三端共用后端 SSDP 发现」，实际要从零写 Browse 客户端。
- HTTP autoindex：后端没有任何目录页解析器（`grep -rniI 'a href|autoindex' server/host/src` → 0）。
  借道 type 0 嗅探也走不通——`handleParse` 只遍历配置里的 `parses` 表，
  表里没有 type=0 条目时直接返回「配置里没有 parses 表，无法解析」（`:1932`）。

### 1.4 刮削：仓库里一个都没有

四项全部 0 匹配（`server/` + `client/`，排除 node_modules）：

| 路线 | 检查 | 结果 |
|---|---|---|
| Kodi Python addon | `grep -rni "xbmc\|kodi"` | 0 |
| tinyMediaManager | `grep -rni "tinymedia"` | 0 |
| TMDB 直连 | `grep -rni "themoviedb\|tmdb"` | 0 |
| `.nfo` 解析 | `grep -rn "\.nfo\|parseNfo\|tvshow\.nfo"` | 0 |

**豆瓣不能当刮削器**。`Douban.java` 只实现了 spider 五方法里的 `categoryContent`
（`:100`）和 `homeContent`（`:240`），`detailContent`/`searchContent`/`playerContent`
全无（`grep` 计数 0）。未覆盖的方法回落到基类的默认实现——两份基类桩都在
`detailContent`/`searchContent`/`playerContent` 上 `return ""`
（（私有开发资料）；
宿主自己那份 `server/host/src/com/github/catvod/crawler/Spider.java:22-25` 同形，
另外多了 `Init` 单例注入）；
后端 `emptyFallback`（`:1556`）再把空 body 兜成空列表——`:1549` 的注释原文就写着
「实测 `Douban` 就没有 `detailContent`」。

它产出的字段是 **4 个**：构造调用在 `Douban.java:95`
`new i_0(string, string2, charSequence, object)`，四个实参依次是
`"msearch:"+id`（`:72`）、`title`、`pic.normal + @Referer/@User-Agent` 后缀、
`"评分："+rating.value`（`:88`）；而 `i_0` 的 4 参构造（`:57-62`）只写
`b`/`c`/`d`/`e`，即 `vod_id`/`vod_name`/`vod_pic`/`vod_remarks`。
所以它**没有 year/area/director/actor/content，也没有搜索**，
「按片名查元数据」这条路它做不了。

> 取证限制（如实标注）：这段构造代码里的字符串是**明文**的
> （`"msearch:"`、`"评分："` 直接可读，`sed -n '60,95p'` 即见），所以上述 4 个字段
> 是读源码确认的；但 Douban 的接口基址与 apikey 在其它方法里是混淆字节串，
> 本文不依赖那部分，也没有反编译验证它们的取值。

值得注意：DTO 本身不缺字段。（私有开发资料）
声明了 `vod_year` / `vod_area` / `vod_actor` / `vod_director` / `vod_content`，
只是 Douban 用的 4 参构造（`:57-62`）从不写这几项。**将来换源或自己塞 JSON，
字段是现成的**，不用改 DTO。

可参考的唯一 `.nfo` 实现在上游 misaka（（私有开发资料），gitignore 不入库）。
它的目录约定（`src/utils/local_danmaku_scanner.py:219-233`）值得照抄：

1. 同目录 `tvshow.nfo`
2. 上级目录 `tvshow.nfo`（季目录）
3. 父目录下唯一的 `*.nfo`（电影，文件名任意）

字段只有 6 个 tag 加 Kodi 的 `uniqueid`（`:246`、`:251-260`）。海报查找**以 nfo 存在为前提**
（`:151-152`），电影取 `poster.jpg`，剧集优先 `seasonNN-poster.jpg` 再退 `poster.jpg`
（`:158`、`:165`、`:170`）。

**但有一处不能照抄**：misaka 扫描的是**弹幕 XML 文件**（`:212` 的入参来自
`.bilibili.xml` 这类文件名），视频目录里常同时存在多条 nfo，所以
「父目录下唯一 `*.nfo`」这个判定基数会变，本地片库要另定规则（建议：视频同名
`.nfo` 优先，其次唯一 `*.nfo`）。

另：`folder.jpg` 只在 docs 里出现过，**代码零实现**；`fanart.jpg` 全仓也没有
（misaka 的 fanart 是远端 API，不是本地文件）。前稿把 `folder.jpg` 写成既有约定，是错的。

### 1.5 文件名解析：4 条基础正则不够，且「改进版」是死代码

前稿说「正则要兼容中英文与发布组命名」，这仍成立；但**不能说 misaka 的做法可以直接抄**。

`filename_parser.py:186-192` 有一组扩展正则 `EPISODE_PATTERNS`、`:194-199` 有
`SEASON_EXTRACT_PATTERNS`，看起来很完备。**但它们是死常量**——
全仓 `grep -c 'EPISODE_PATTERNS'` → 1（只有定义行），无任何引用。

真正被调用的 `extract_season_episode`（`:720-747`）只有 4 条基础正则。我把模块单独
加载后实跑（`python` 包装器不可用，改用 `py -3` + `importlib` 直接加载该文件）：

```
'庆余年.S01E03.1080p.mkv'          -> (1, 3)
'庆余年 第1季第1集'                  -> (1, 1)
'Breaking.Bad.1x01'                -> (1, 1)
'[Group] Anime - 05 [1080p].mkv'   -> (None, None)     ← 漏
'Movie.2019.2160p.mkv'             -> (None, None)     ← 电影，正常
'庆余年 第2季 第08集'                -> (None, None)     ← 漏（有空格）
'庆余年 第2季第08集'                 -> (2, 8)
'The.Office.S02'                   -> (None, None)     ← 只有季没有集，漏
```

结论：**要实现「扩展正则」，得自己补，不能假设上游已经生效。** 需要补的两类：

- 集号：`[ ]+-[ ]+(\d{1,4})`（发布组 `- 05` 写法）、`第N集`、`\[N\]`、`EP/DR`；
- 季号：`第N季`（含中文数字）、`Season N`、`S_N`、`Nth`。

年份正则可沿用 `:544` 的 `[\(\[（]?((?:19|20)\d{2})[\)\]）]?`，但**必须**配 `:629` 的
`if 1900 <= ep <= 2099: continue` 排除，否则 4 位年份会被当集数。
中文数字转换参考 `:47` 的 `CHINESE_NUM_MAP`。

### 1.6 一个会让实现直接返工的冲突

`core/UrlSafety.isSafeMediaUrl`（`UrlSafety.java:57-71`）明确拒绝回环地址，
`schemeAndHost`（`:101-114`）只放行 http/https（`:113`）。这条策略同时打掉三件事：

1. `file://` 海报进不了图片代理（`/api/proxy/image` 在 `:5353` 调它）；
2. 前稿推荐的本机网关 `http://127.0.0.1:PORT/media?p=...` **会被 403**；
3. 网盘源返回的 `http://127.0.0.1:99xx/proxy?do=xxx` 也会被 403——
   而前端 `PlayView.vue:99-109` 会把它无条件包进代理。

另外三个必须一起处理的事实：

- **`handleWebdav` 没有任何 SSRF 校验**：`handleWebdav`（`:4776`）到函数尾
  （约 `:4862`）区间 `grep UrlSafety` → 0；而 `handleStream`（`:4517`）和
  `handleImage`（`:5353`）都有。这条通道还能用 `GET` 带 body
  绕开 `writeRequiresAuth`（`:468-475` 只对非 GET/HEAD/OPTIONS 要求 token）。
  **做片库端点时不要复用它的「无校验」实现。**
- **图片代理注释与实现不符**：`:4757` 的方法注释写「并做本地缓存」，但实现
  （`handleImage` 在 `:5324`）只在 `:5384` 发了 `Cache-Control: public, max-age=86400`，
  没有任何磁盘缓存代码。
  （另有 `:5609`、`:5618` 两处 `max-age=0, must-revalidate`，是 spider jar 下载用的，
  与媒体缓存无关——所以准确说法是「媒体响应里只有图片桶有 1 天缓存」。）
- **`/api/health` 的 `webdav` 能力是无条件上报的**（`:713`），即便某次部署连不上
  任何 WebDAV，前端也不会隐藏相关 UI。

### 1.7 要做什么（按顺序，指出先改哪）

**第 0 步（前置，必做）——修播放链路的认证透传。**
改 `ApiServer.java` 的 `handleStream`（`:4502`）：在 `referer`/`ua` 同级增加
`auth`（Base64 `user:pass` → `Authorization`）与可选 `cookie` 参数；同步改
`client/apps/web/src/api/index.ts:467` 的 `proxyStream` 透传这两项。
**不做这步，WebDAV 与所有私有网盘只能列目录不能播。**

> **凭据不能放 query string。** 早期草案把 `auth` 拼进 `proxyStream` 的 URL 参数，
> 这与仓库自己的立场相反——`ApiServer.java:540-541` 的注释写着
> 「GET 一律不拦……给它加 key 只会让人把 token 写进 URL 日志里」。
> 正确做法：`proxyStream` 对 `auth`/`cookie` 改为**不拼进 URL**。
> 但 `<video src>` 无法附加请求头，所以只剩两条路：
> （a）后端保存凭据，URL 里只出现 `credId`（`/api/library/stream?cred=..&p=..`）；
> （b）前端先换短期票据。
> **这两条的取舍必须在 P0 开工前定，不要先按 URL 传参实现。**

**第 1 步——WebDAV 目录端点。**
新增 `GET /api/library/dav?url=&depth=`，路由**必须写进 `:548`–`:663` 那张显式表**
（放在 `/api/webdav` `:633` 附近），否则会被 `:671-679` 的 `/api/{site}/{action}`
兜底当成站点名。内部复用 `:4792` 起的 HttpClient 段，把 XML 解析成
`[{name,isDir,size,mtime,href}]`。五条容错：

1. `getcontentlength` 缺失 → `size=-1`，不参与排序；
2. `resourcetype` 缺失 → 用 href 尾斜杠判目录；
3. `getlastmodified` 解析失败 → 回退 0；
4. **命名空间前缀不能写死 `D:`**——现有两处前端代码都写死了
   （`sync.ts:371`、`prefs.ts:494`），换个服务器就误报「空目录」。
5. **不要沿用 `handleWebdav` 的 20 万字符截断（`:4850`）**。那个上限是给「备份文件
   列表」定的；片库要自己解析 XML，应在解析前限条目数（建议单次 `depth=1` 最多
   2000 条并返回 `truncated:true`），否则大目录会在截断处产生半截 XML、解析直接抛错。

   > **WebDAV 没有分页**（只有 `Depth` 与 Range），所以「一次列多少」只能由
   > 我们自己定上限 + 前端逐层点。这条决定了 §2.6 目录页不能做「无限滚动」。

**第 2 步——AList 源。** 给 `AList` 补 ext（走 `config.sites.json` 注入，不要硬编码）。
配置形状按 （私有开发资料）
实测的 `SerializedName`，**完整是**：

```json
{
  "drives": [{
    "name": "我的盘",
    "server": "http://192.0.2.10:5244",
    "version": 3,
    "path": "/",
    "token": "<可选，免登录时留空>",
    "search": true,
    "hidden": false,
    "vodPic": "",
    "login": { "username": "...", "password": "..." },
    "params": [{ "path": "/", "pass": "" }]
  }]
}
```

`login`（（私有开发资料）、`:12`
的 `username`/`password`）和
`params`（（私有开发资料）、`:12`
的 `path`/`pass`）**都不能省**：
省了 `login` 私有 AList 配不起来，省了 `params` 多路径盘挂不上。
注意版本探测差异（v3 用 `content`、v2 用 `files`，
见 （私有开发资料） 的分支）。

**第 3 步——本机目录。** 见 §2.5（PC 端内网关的具体设计）与 §3.3（TV 形态）。
本地网关地址**不能走后端代理**（回环被拒），必须让端内直连。

**第 4 步——刮削（可选）。** 基线是 `.nfo` + 同目录图片；`.nfo` 读不到就退文件名；
在线刮削放最后，且**必须**允许失败退化成文件名。**不要用豆瓣**（无 search/detail）；
要刮就接 TMDB 并让用户自带 key。参考实现可看
`tv/webhome-devkit/examples/homepages/nostr.html:4605-4606`（写好了一个完整 TMDB 客户端，
但该目录被 `.gitignore:82` 忽略）与
（私有开发资料）（9 个刮削器 + `base.py`，
同样 gitignore）。

---

## 二、客户端界面：配置与观影入口放哪

### 2.1 结论

**配置进设置页新增的第 11 个分区「本地片库」（`conn` 之后），观影入口是顶栏「直播」旁边的独立
`/library` 路由；类型选择用新写的居中模态，不用现有 `TileSelect`。**

理由：片库是「和点播并列的另一种内容来源」，不是「某个源里的一个分组」——
仓库已经用同一个判断把「直播」做成了并列入口
（`AppHeader.vue:138` 注释原文：「与点播并列，不做成某个源里的一个分组」）。

### 2.2 现状：设置页是长页 + 锚点，没有模态**组件**

- 设置页现在是 **10 个**分区（比前稿多一个 TV 专属的 `localexec`），全部是同一长页里的
  `<section data-sec>` 锚点，导航只是 `scrollToSec` 滚动。分区表在
  `SettingsView.vue:1230-1241`：
  `conn` / `plugin`(仅桌面) / `localexec`(仅 TV) / `net` / `danmaku` / `play` /
  `browse` / `appearance` / `sync` / `maint`；
  对应锚点在 `:1502`、`:1591`、`:1924`、`:1977`、`:2107`、`:2189`、`:2250`、
  `:2288`、`:2340`、`:2559`。
  （`desktopOnly` / `tvOnly` 的过滤在 `:1245-1246`。）
- **没有 ARIA 角色化的对话框**：`grep -rnE 'role="dialog"|aria-modal' client/apps/web/src`
  → 0；现有确认交互是 20 处原生 `confirm/prompt/alert`
  （`SettingsView.vue:478`、`:522` 等）。
  **但不能说「本仓第一个模态」**——播放器已经有一个可抄的遮罩式弹层：
  `VideoPlayer.vue:3256` 的 `absolute inset-0 z-50 grid place-items-center bg-black/70
  backdrop-blur-sm`（弹幕搜索框），这组类名就是现成的遮罩+居中写法。
  准确说法是「没有可复用的模态**组件**，但有一处现成的遮罩样式」。
- 首页只渲染「当前源」（`HomeView.vue:25`、`:54`），源靠顶栏下拉切换
  （`AppHeader.vue:101-135`）。所以把片库注册成普通 source，等于把它藏进那个下拉里。
- **设置页无法按分区深链**：`router/index.ts:34` 只有一条 `/settings`，
  `scrollBehavior` 恒 `({top:0})`（`:36`），页内不读 hash。新增分区同样不可被链接直达。

### 2.3 配置界面：设置页新增「本地片库」分区

**放哪**：`NAV_ITEMS` 在 `conn` 之后插一项（`SettingsView.vue:1230`），
对应 `<section data-sec="library">` 插在 `:2104`（`net` 结束）与 `:2107`（`danmaku` 开始）之间。
（注意：这一带的行号在 TV 的 `localexec` 分区加入后已整体下移；按
`data-sec="net"` / `data-sec="danmaku"` 两个锚点定位最稳。）

**控件形态**：复用现有磁贴语言（`set-card` + `TileAction`），一行一个资源：

| 字段 | 控件 | 适用类型 | 说明 |
|---|---|---|---|
| 类型 | 只读徽标 | 全部 | `WebDAV` / `AList` / `本机目录`，添加时选定，之后不可改（改=删了重加） |
| 名称 | 文本 | 全部 | 显示用，默认取主机名 |
| 地址 | 文本 | 全部 | WebDAV 是根 URL；AList 是服务地址（如 `http://nas:5244`）；本机目录是路径 |
| 用户名 | 文本 | WebDAV / AList | AList 映射到 ext 的 `login.username` |
| 密码 | 密码 | WebDAV / AList | AList 映射到 `login.password`；**存储方式见下** |
| 路径 | 文本 | AList | 映射到 ext 的 `params[0].path`（默认 `/`） |
| 目录密码 | 密码 | AList | 映射到 `params[0].pass`；有加密目录时必填 |
| 子目录 | 文本 | WebDAV | 默认 `/`，与同步用的 `dir` 分开 |
| 设为默认 | 开关 | 全部 | 决定 `/library` 首屏展开哪个库 |
| 操作 | 两个按钮 | 全部 | 「测试连接」「删除」 |

**为什么 AList 要单独的「路径 / 目录密码」两栏**：AList 的 ext 不是「用户名+密码」两个
平铺字段，而是 `login:{username,password}` 加 `params:[{path,pass}]` 两层结构
（`merge/p004e/a.java:18-21`、`d.java:9/12`、`e.java:9/12`）。
只按用户名/密码两个输入框去喂 AList，映射不到 `params`，**多路径盘和加密目录会配不起来**。

**存储：新建独立 key `meow.library`（localStorage），理由与「凭据会泄漏」无关。**

先纠正一个前稿的错误：`WebdavConfig` 现在**不会**被备份上传。
`prefs.ts:153` 的 `KEY = 'meow.prefs'` 与 `:399` 的 `WEBDAV_KEY = 'meow.webdav'`
是两个不同的 localStorage key，而 `makeBackup`（`:433`）只序列化 `getPrefs()`——
`getWebdav()` 从未进入备份。所以「把 NAS 凭据塞进 prefs 就会被传上云」这个现状不成立。

真正该新建 key 的理由有三条：

1. **语义分离**：`WebdavConfig` 是「跨端同步的传输通道」，片库是「内容来源」，
   两者只是恰好都用 WebDAV 协议，混在一个 key 里会让「关掉同步」连带清掉片库。
2. **不会误入同步白名单**：后端 `STATE_PREFS_SYNC`（`ApiServer.java:5211` 起）
   是**白名单**——不在名单里的键一律不落盘、不上传。新建 key 天然不在里面。
3. **字段形状不同**：片库要有多个库、每个库有类型/名称/是否默认，`WebdavConfig`
   是单例。

> **注意 `STATE_PREFS_SKIP` 目前是死代码，不要把它当防护网。**
> `grep -rn 'STATE_PREFS_SKIP' --include=*.java .` → **1**（只有 `:5222` 的声明，
> 没有任何读取点）。所以「登记到 SKIP 里就不会被上传」这句话现在是**假的**。
> 真正的保护来自上面第 2 条的 `STATE_PREFS_SYNC` 白名单机制。
> 前稿把它写成「已列出的防护」，属把要做的写成已有的，已删除。

**凭据怎么存**：`meow.library` 里**只存 `libId` + 展示信息**（名称/类型/地址/默认），
密码走单独通道——要么交给系统钥匙串（PC），要么让后端保存到数据目录下独立文件
（服务器型部署）。理由：localStorage 是明文，而 §六 已说明
「不改现有行为」意味着不能顺手把凭据塞进会被导出的备份 JSON。
**这条直接决定 §2.3 的字段表里「密码」一栏在 Web 端是否可填。**

**「测试连接」统一成一个端点** `POST /api/library/test`（三类型分派），
不要沿用现在这种「webdav ping 直接打 `/api/webdav`」的做法
（`prefs.ts:471-505`，且它没带 `X-Meow-Token`，在开了 authToken 的部署上必然 401）。
端点要带**超时**（建议 8s）与**明确的失败分类**（DNS 失败 / 401 / 404 路径不存在 /
证书错误），否则用户只看到「失败」两个字，无法判断是密码错还是地址错。

### 2.4 观影入口：独立 `/library` 路由 + **必须新开的详情/播放端点**

- 路由加在 `router/index.ts:28`（`/live` 之后）：`/library` 与
  `/library/:libId`（进入某个库的目录浏览）。
- 顶栏在「直播」`AppHeader.vue:138-149` 之后插一个同形 `RouterLink`，
  图标用心形/文件夹类，文案「片库」。
- **不要做成新的 source**：注册成 site 会被 `searchAll`（`ApiServer.java:2399` 起，
  `:2414` 的 `targets.addAll(SITES.keySet())`）和 `liveAll`（`:967` 同一句）
  全量扇出——每次搜索/直播都会给片库发一次请求；而 `SearchView.vue:24`
  的默认 scope 是 `'all'`，全站聚合是默认模式。

#### ★ 这里有个必须解决的矛盾（前稿写错了）

前稿同时写了两句互相冲突的话：「不要做成 source」+「复用 `/detail/:site/:id`
零改动可用」。**这两条不能同时成立。** 原因：

`DetailView.vue:43` 拿到 `site` 后直接 `fetchDetail(site, id)`
（`api/index.ts` 里拼成 `POST /api/${site}/detail`），而后端对**未注册的 key**
会走 `instance(site)` → `Class.forName("com.github.catvod.spider." + key)`
→ 抛 `RuntimeException("cannot load spider ...")`（`instance()` 在 `:768`，
抛点 `:789`）。
片库不注册进 `SITES`，那个 `site` 值就没有对应类，详情页会拿到 **500**。

> 补充事实：宿主 `server/host/src` 下**没有** `com/github/catvod/spider/` 任何类
> （`find server/host/src -path '*com/github/catvod/spider*' -name '*.java'` → 空），
> 所以也不能靠「往宿主里塞一个同名类」绕过去。

#### 正确做法：新增 lib 专用端点，`site` 传保留前缀

1. 后端新增 `GET /api/library/detail?lib=&p=` 与 `GET /api/library/play?lib=&p=&ep=`，
   都不经过 `instance()`，直接由片库实现返回 CatVod 形状的 JSON。
2. 前端 `DetailView` / `PlayView` 在 `site` 以保留前缀（建议 `lib:`）开头时
   改走这两个端点，其余情况保持现状——**这是纯增量分支，不动任何现有源的路径**。
3. 进度与收藏仍以 `site + vod_id` 为主键（`stores/history.ts:62`、
   `stores/favorites.ts:39-44`），所以历史/收藏/续播照旧复用，`site` 就用 `lib:<libId>`。

**这个分叉必须在 P2 开工前定**，否则「详情页零改动」会在联调时变成 500，
P2 的工期估算要重做。输出仍是 `VodItem`
（`vod_id` / `vod_name` / `vod_pic` / `vod_year` / `vod_area` / `vod_remarks`），
所以 `PosterCard.vue` / `HomeView.vue` / `CategoryView.vue` 的海报墙确实零改动——
**零改动的是海报墙，不是详情页。**

### 2.5 「选目录」与 PC 端内网关（本轮唯一要新写的媒体服务）

#### 2.5.1 选目录：三端能力不同

- **PC**：`SettingsView.vue:1010-1028` 的 `tauriPickFile()` 调
  `invoke('plugin:dialog|open')`，但 `client/apps/desktop/src-tauri/Cargo.toml`
  里 `tauri-plugin` 命中 **0**，插件没注册 → 恒走 `:1024` 的 `prompt()` 手输。
  **任何「PC 选目录」的设计都不能假设 dialog 插件已可用**，要么补插件，
  要么在 Rust 侧加 `read_dir` 命令（`lib.rs:368` 的 `generate_handler` 现在
  只有 `plugin_*` 系列）。
- **Web**：`showDirectoryPicker` / `webkitdirectory` 命中 0，浏览器没有目录 API。
  Web 端只能「填后端所在机器的路径」，且后端要新写列举端点（§1.7 第 3 步）。
- **TV**：`ACTION_OPEN_DOCUMENT` / `MediaStore` / `DocumentFile` 命中 0，
  Manifest 只申请 `INTERNET`（`AndroidManifest.xml:4`），**没有外部存储权限**，
  读不了 U 盘。但 App 私有目录是可写的（见 §4.4），所以 TV 能做「缓存」不能做「挂 U 盘片库」。

#### 2.5.2 PC 端内网关：具体设计（前稿只给了名字，这里给能开工的规格）

**放哪**：`client/apps/desktop/src-tauri/src/media_server.rs`，在 `lib.rs` 里
启动后 spawn 一个线程，与现有 `mcp.rs`（9339 起的 MCP 冒烟服务）同风格——
`mcp.rs:12-14` 的注释明确记了「零依赖手写 HTTP/1.1，不引 hyper/axum」这个决策，**沿用**。

**规格**：

| 项 | 取值 | 理由 |
|---|---|---|
| 监听 | `127.0.0.1` + 随机空闲端口（绑 0 再读实际端口） | 不写死端口：桌面端后端 9979 已会顺延 9980–9985（`apiserver.manifest.json` 的 `portFallback`），再抢固定端口必然撞 |
| 暴露给前端 | 通过 `boot_info`/新增 command 返回 `{port, token}` | 前端在 `PlayView` 拼 `http://127.0.0.1:<port>/media?p=<encode>&t=<token>` |
| 鉴权 | 一次性随机 `token`，随进程生成，路径里必带 | 本机其它进程也能访问回环端口；**不加 token 等于把整个磁盘开给任何本机程序** |
| 白名单根 | 用户在设置里选定的目录绝对路径列表，启动时 `canonicalize()` | 防 `..` 穿越与符号链接逃逸：请求路径 canonicalize 后必须以某个根为前缀，否则 403 |
| Range | 必须支持 `Range: bytes=` → 206 + `Content-Range` | 拖进度条依赖它。`<video>` 对 mp4 起播就会发 Range 请求 |
| Content-Type | 按扩展名映射（mp4/mkv/ts/m4s/m3u8/webvtt…） | m3u8 必须是 `application/vnd.apple.mpegurl`，否则 hls.js 会拒 |
| 只读 | 只实现 GET/HEAD，其余 405 | 缩小攻击面 |
| 与后端关系 | **不经过 `/api/proxy/stream`** | 回环被 `UrlSafety` 拒（§1.6）。前端必须有一个「本地地址直连」分支，跳过 `proxyStream` |

**前端要配合改的一行**：`PlayView.vue:99-109` 的 `src` computed 现在无条件
`return proxyStream(url, ...)`，需要加一条「地址 host 是 127.0.0.1/localhost 时直接返回」
的分支。**这是 P4 能不能验收的关键一行，不是可选项。**

> **替代方案（成本更低，但不是本轮）**：Tauri 的 `protocol-asset` 自定义协议
> 能让 `<video src="asset://...">` 直接读白名单目录，不需要自己写 HTTP 服务。
> 但 `Cargo.toml` 现在只启用了 `custom-protocol`，`tauri.conf.json` 里没有
> `app.security.assetProtocol` 段，**启用它同样是新工作**，且 Range 支持取决于
> Tauri 版本。两条路都要改代码，选「手写网关」是因为它同时能服务 TV（同一套协议）。

### 2.6 目录浏览页：`/library/:libId` 长什么样

前稿只给了入口，没给页面。补齐到能写代码的程度：

- **形态**：网格（与 `CategoryView` 一致），沿用 `PosterCard`。目录条目用
  「文件夹图标 + 名称」占位（`PosterImage` 已有失败占位，可直接复用）。
- **每条显示**：名称、大小（目录不显示）、修改时间（相对时间，如「3 天前」）、
  文件名解析出的季集徽标（如 `S01E03`）。**不要显示完整路径**。
- **排序/筛选**：默认「目录优先 + 名称自然序」（`localeCompare` 带 `numeric:true`）；
  提供「按时间」切换。**不做分类胶囊**——目录本身就是分类。
- **分页/懒加载**：**不做无限滚动**。WebDAV 无分页（§1.7 第 1 步第 5 条），
  一次只列一层（`depth=1`），超过 2000 条截断并显示「本目录条目过多，请进入子目录」。
- **URL 形态**：`/library/:libId?p=<encode 后的相对路径>`。**不套多层路由**，
  否则 TV 的 BACK 语义会变成「一层层退」而不是「退出到片库首页」。
- **面包屑**：顶部显示 `库名 / 子目录 / …`，每一级可点；同时提供「上一级」按钮
  （TV 遥控器没有鼠标，面包屑是唯一的层级导航）。
- **空态**：目录为空显示「这个目录里没有视频文件」+ 「上一级」按钮。
- **错误态**：按 `POST /api/library/test` 的失败分类显示——
  401「用户名或密码不对」、404「路径不存在」、超时「NAS 没响应（检查是否在同一局域网）」、
  证书错误「证书不受信任」。**不要统一显示「加载失败」。**
- **加载中**：骨架屏（复用 `PosterCard` 的占位），超时 15s。

---

## 三、参考形态：影视仓的「请选择存盘类型」

### 3.1 参考对象

影视仓 TV 版「存储空间」页 → 点「添加」→ 居中模态框，标题「请选择存盘类型」，
三个**等宽竖排**按钮：本地目录（当前选中高亮）、Webdav、Alist网页；遥控器可聚焦。

### 3.2 结论

**Web/PC 可以 1:1 复刻（只是我们没现成模态组件，得新写）；TV 不能照抄——同一份模态
在 TV 上必须挂在路由上才能按 BACK 关，且打开时背景必须不可聚焦。** 另外它对我们
是**可编辑的资源列表**，不是一次性的添加向导，这是最大的形态差异。

### 3.3 我们的等价设计：三端各什么形态

#### Web（浏览器）——1:1 复刻

新建 `components/common/ChoiceDialog.vue`：

- `fixed inset-0` 遮罩 + 居中卡片。**层级用 `z-40`**：顶栏是 `z-30`
  （`AppHeader.vue:84`），播放器自己的弹层是 `z-50`（`VideoPlayer.vue:3256`）。
  选 `z-40` 是为了「设置页的模态永远在顶栏之上、但明确低于播放器弹层」——
  同级 `z-50` 不产生覆盖序，两者同时出现时谁在上是未定义的。
  **另需明确：片库模态只在设置页/片库页出现，播放页不会同时打开它**（写进组件注释防后患）。
- 标题区 + 三个 `w-full` 竖排 `<button>`，`flex-col gap-2`，等宽靠 `w-full` 而非 `flex-1`；
- 当前项用 `border-accent bg-accent/15 text-accent`（与 `AppHeader.vue:127`
  站点下拉的选中态同一套 token）；
- `Esc` 关闭、点遮罩关闭、**背景必须 `v-if` 卸载或加 `inert`**——TV 的焦点选择器会扫全文档（见下）。

#### TV（遥控器）——模态必须挂到路由上

TV 的遥控实现是**全文档几何选焦**：`client/apps/tv/app/src/main/assets/tv-nav.js:24-26`
用 `document.querySelectorAll(FOCUSABLE)` 扫全部可聚焦元素，`:84-95` 的
`enter()` 直接 `el.click()`。它**没有** `focus trap`、`inert`、`aria-*`
（`grep -c 'trap\|inert'` → 0），也没有 `focus()` 调用。

后果有两条，都必须照做：

1. **模态打开时背景元素仍在焦点候选里**。若遮罩不能挡住焦点，遥控器会把光标
   移到背景按钮上并点中它。所以模态打开时要么 `v-if` 卸载背景内容，
   要么给背景加 `inert`。
2. **`TileSelect` 在 TV 上关不掉**：它的关闭路径是 `mousedown`（`:62-68`）和
   `Escape`（`:70-71`），而 TV 只转发 D-pad 与确认键（`MainActivity.java:227-245`），
   `Escape` 根本到不了页面。**所以类型选择必须用新模态，不能复用 `TileSelect`。**

BACK 键走 `web.goBack()`（`MainActivity.java:248-254`），因此**模态态要写进路由**
（如 `/settings?dlg=library-add`），这样 BACK 天然等于关闭模态。
如果做成纯组件内 `v-if`，BACK 会直接退出整个页面。

#### PC（Tauri）——同 Web，另加原生目录选择

浏览器形态 1:1 复用；「本地目录」这一项额外接一个 Rust `read_dir` 命令
（见 §2.5），选完把绝对路径回填到地址框。

### 3.4 与影视仓的差异，以及为什么

| 维度 | 影视仓 | 我们 | 为什么 |
|---|---|---|---|
| 模态生命周期 | 一次性向导：选类型 → 填表 → 关闭 | **可编辑的资源列表**：同一模态既用于「添加」也用于「编辑」 | 用户会有多个 NAS/网盘并存；影视仓的形态一关就找不回来，编辑要删了重建 |
| 类型是否可改 | 选了就定了 | 同样不可改 | 三种类型的字段集完全不同（WebDAV 要子目录、AList 要 token、本机要路径），中途改类型等于清空重填，不如显式「删了重加」 |
| 存在哪里 | TV 本地 | **配置在后端数据目录；本地媒体走端内直连** | Web 端没有文件系统（§2.5），必须有个后端存配置；PC/TV 的媒体地址又要能绕开后端代理 |
| TV 的关闭方式 | 遥控 BACK 关浮层 | BACK 走 `goBack()` → **模态必须进路由** | `tv-nav.js` 不转发 Esc，且 `MainActivity.java:248-254` 把 BACK 绑定到 WebView 历史 |
| 默认项高亮 | 「本地目录」选中 | 按端不同：PC 默认「本地目录」、Web 默认「WebDAV」 | Web 端没有本地目录能力（§2.5），把默认项指向做不到的选项会立刻失败 |

**配置存哪的取舍（前稿只说「两套」，没给规则）**：

- **单一真源 = 后端**（`data/library.json`，走 `DataPaths`）。理由：Web 端没有文件系统、
  TV 换机要能带走、PC 与 Web 要看到同一份库列表。
- 端内（localStorage `meow.library`）只存**「本机覆盖项」**：本机目录路径、端内网关端口。
  这两项换个设备必然不同，不能同步。
- 冲突规则：**后端是权威，端内覆盖项按 `libId` 合并**；端内没有的 `libId` 从后端读，
  端内有后端没有的（例如刚在 PC 上加的本机目录）在下次「保存」时推给后端。
  不做双向自动合并——会产生用户看不懂的「库自己变多了」。

**为什么这条必须先定**：`/api/config/import` 会整体覆盖 `config.sites.json`
（`ApiServer.java:5863` 的 `DataPaths.write("config.sites.json", ...)` 与随后的
`rebuildSites()`）。片库配置**不能**放那个文件，否则用户导入一份别人的配置就把自己的
NAS 列表清空了。放独立的 `library.json` 是硬要求，不是偏好。

**不做的事**：不做「扫码导入」「从剪贴板粘贴分享链接」这类影视仓有但我们没有入口支撑的形态——
仓库里没有任何扫码/剪贴板读取代码，做了也是空控件。

---

## 四、线上视频缓存与弹幕缓存下载

### 4.1 结论

**以「断网可看」为唯一验收口径，现在三端全部不通过；且缺口不在「下载器」，而在
播放链路。所以顺序是：先让播放器能播本地地址，再谈下载。**

### 4.2 两个目标必须分开

| | 目标 A：断网可看 | 目标 B：省流量 |
|---|---|---|
| 判据 | 拔网线后能完整播完一集：画面 + 弹幕 + 拖进度 + 退出再进能续播 | 重复观看不重复下载 |
| 要求 | 地址、清单、分片、密钥、弹幕**全部本地可达**，且前端不依赖后端在线 | 只需 HTTP 层缓存命中 |
| 典型方案 | 分片落盘 + 清单重写成同目录相对路径 + 本地静态服务 | 浏览器 HTTP 缓存 / CDN / 代理层 `Cache-Control` |
| 现有能力 | **0** | 只有图片：`ApiServer.java:5384` 的 `max-age=86400`（另有 `:5609`/`:5618` 两处 `max-age=0, must-revalidate` 是 spider jar 下载用的，与媒体无关） |

**凡只满足 B 的方案都不算完成本章**。举例：给 `/api/proxy/stream` 加一层服务端磁盘缓存，
拔网线后播放器仍要先请求 `/api/proxy/stream` → 后端要回源 → 失败。这属于 B，不满足 A。

### 4.3 断网可播的四个硬前提，逐条对现状

#### 前提 ① 播放地址必须本地可达

**现状：不成立，两道拦截。**

1. 前端 `PlayView.vue:99-109`：`src` computed 只放行 `/^https?:/i`，
   然后**无条件** `proxyStream(url, ...)`。即使给出 `http://127.0.0.1:PORT/media?p=...`，
   也会被包成 `/api/proxy/stream?url=http%3A%2F%2F127.0.0.1...`。
2. 后端 `handleStream` 的入口校验 `UrlSafety.isSafeMediaUrl`（`ApiServer.java:4517`
   → `UrlSafety.java:57-71`）**拒绝回环**，直接 403 `url not allowed`。

`file://` 更早就死了：`schemeAndHost`（`UrlSafety.java:101-114`）只认 http/https（`:113`）。
测试要用本机 LAN IP」记成坑，结论一致。

**缺口**：需要前端在「地址指向端内网关」时**不要走 proxyStream**（§2.5.2 最后一段），
并且后端放开对显式声明的回环端口的限制（或让本地地址完全绕开后端）。

#### 前提 ② m3u8 内所有引用必须本地化

**现状：改写逻辑存在，但产出的是绝对回环地址，且缺两个关键 tag。**

现有改写（`handleStream` 内的清单分支，`:4619` 起）：
- 只处理 `#EXTM3U` 开头的响应（`:4619`），否则原样透传；
- `URI="..."` 分支（`:4637-4645`）覆盖 `EXT-X-KEY` / `EXT-X-MAP`；
- 普通分片行改写成 `proxyUrl(...)`（`:4659`）。

但 `proxyUrl`（`:4738-4747`）拼的是 `${selfBase}/api/proxy/stream?url=...`——**绝对地址**，
不是 `seg-00001.ts`。这在断网时必然失败（它指向一个要回源的代理）。

三个未处理的点（`grep` 均为 0）：
- `#EXT-X-BYTERANGE`：0 命中。带字节范围的分片必须先改成 Range 请求再各存一文件，否则存下来的是错的。
- `#EXT-X-ENDLIST`：0 命中。VOD 清单结尾没补，部分播放器会当成直播流一直等。
- 多级清单：**不递归**。主清单是 `#EXT-X-STREAM-INF` 时，子清单本身也得下载并重写。

另外 `:4658` 有个容易忽略的行为：`filterAdsEnabled() && isAdHost(abs)` 为真时
**直接 `continue` 丢弃该行**——广告过滤开着时，缓存下来的清单会缺分片。

**缺口**：需要**另一支**「落盘用」的改写，产出同目录相对文件名；不能复用 `proxyUrl`。

#### 前提 ③ 前端不能被后端离线挡住

**现状：三端都不成立。PC 能启动，但首页被一道在线检查挡住。**

- PC 是唯一能离线启动的端：前端打包进 `frontendDist`（`tauri.conf.json:10`），
  后端是本地 sidecar；`/api/health` 的 `ok` 只看本地状态
  （`spiderJar && configLoaded`，`ApiServer.java:719`），不依赖外网。
- **但「能启动」不等于「能验收」**：`App.vue:147` 的 `await store.boot()` 会先
  `await ping()`（`stores/app.ts:45`），`ping()` 失败则 `store.error` 非空
  （`App.vue:177` 的 `if (!store.error) return false`），首页转成
  「后端未连接」大卡片（`App.vue:230` 起）。
  **所以离线时首页是挡住的状态。** 好消息是 `RouterView` 始终渲染
  （`App.vue:271-274`，注释明写「路由不能被杀」），且离线卡片只在
  `route.name === 'home'` 时出现（`showOfflineCard`，`App.vue:175-180`，
  其中 `:176` 是 `if (isPlay.value) return false`）——**`/play` 与 `/history` 不受影响**。
  这条决定了离线验收必须从 `/history` 进，不能从首页点。
- `PlayView.vue:212-218` 的 `load()` 仍必经 `fetchPlay` → `/api/{site}/play`，
  离线必失败并落到错误页（`errorSource='fetch'`）。**即便是本地缓存，
  也没有「跳过 fetchPlay」的分支。**
- Web：无 Service Worker（`grep -rn serviceWorker client/apps/web/src` → 0），
  断网连页面都打不开。`public/manifest.webmanifest` 存在但 `index.html` 没有
  `rel="manifest"`（命中 0），PWA 是半接线状态。
- TV：壳加载的是远端 http 地址（`MainActivity.java:106-109` 的 `load()` →
  `web.loadUrl(url)`），默认 `DEFAULT_URL` 指向 `http://10.0.2.2:30010`
  （`app/build.gradle:18`）。断网后 WebView 直接白屏。

**缺口**：两处。① 首页离线时被卡片挡住（验收从 `/history` 走可绕过，但用户从首页进会卡）；
② 需要一个「缓存命中就不打源站」的入口——先查本地缓存，命中则直接进播放器，
不经过 `fetchPlay`。

#### 前提 ④ 弹幕必须本地读

**现状：完全没有。**

- 弹幕地址只有一个来源：`PlayView.vue:151-156` 的 `danmakuUrl` computed，
  恒为 `proxyDanmaku(title, ep)`（`api/index.ts:489`）→ 后端在线请求。
- `loadDanmaku`（HEAD `VideoPlayer.vue:1874`；该文件在工作区仍有未提交改动，
  现行位置约 `:1972`，**按函数名定位**）只有一条路径：`fetch(url)`；
  `catch` 里 `dmCount.value = 0`——**失败就静默无弹幕，没有本地回退**。
- 外挂字幕同理：`fetch(proxyStream(s.url))`（HEAD `:318`）。

顺带一个容易误判的点：弹幕**有**缓存，但是纯内存的。
`TtlCache` 类在 `ApiServer.java:3424`，`MAX = 24`（`:3427`），
成功 TTL 30 分钟（`:3404`、`:3638`、`:4127`），失败 TTL 30 秒（`:3408`）。
进程重启即丢，且没有落盘代码。`:3452`/`:3459` 是两张表
（`DANMAKU_CACHE` 与 `DANMAKU_SRC_CACHE`）。

**缺口**：`loadDanmaku` 需要「本地文件 → 后端」的读序；弹幕要落盘。

### 4.4 存储位置与目录结构

**落盘根一律走 `DataPaths`。** 现有 4 处 `DataPaths.write` 调用
（`ApiServer.java:4307`/`4914`/`5292`/`5863`）全部平铺在数据目录根下，
`DataPaths.dir()` 全仓 **0 调用**——`data/cache/` 目录也不存在（`ls data/` 实测只有
`config.sites.json` / `site-health.json` / `state-*.json` / `danmu/`，其中 `danmu/`
是 danmu_api 容器的挂载点，与 JVM 无关）。

目录按端不同：

| 端 | 落盘根 | 现状 |
|---|---|---|
| PC | `%APPDATA%\com.meow.player\data\cache\`（identifier 见 `tauri.conf.json:5`，`dataDir={appData}/data` 见 `apiserver.manifest.json:34`） | 目录不存在，但**可写** |
| TV | `ctx.getFilesDir()` 或 `getCodeCacheDir()` | **已具备写文件能力**（见下），只差一个「缓存专用目录」的约定 |
| Web | 不做 | 无 SW/OPFS/IndexedDB |

> 前稿写的 `%APPDATA%\meow\cache` 是错的，identifier 是 `com.meow.player`。
>
> **修正前稿**：前稿写 TV「无写文件代码（`getFilesDir`/`openFileOutput` 命中 0）」，
> 那是在旧提交上成立的。现在 TV 端**已经有完整的写盘链路**：
> `com/github/catvod/utils/Path.java:53` 用 `getFilesDir()` 取私有目录，
> `Path.java` 内有多个 `FileOutputStream` 落盘（`:204`/`:227`/`:248`/`:302`），
> 还有 `getCodeCacheDir()` 做 jar 缓存与校验（`LocalSpiderHost.java:95`、`:119`、`:215`）。
> **所以 §4.6「TV 缓存是空中楼阁」的论证要改**：落盘能力已具备，
> 缺的只是「壳能脱网启动」与「缓存目录选在哪」。

集内结构：

```
cache/<site>/<vod_id>/<ep>/
  playlist.m3u8    ← 分片地址已改写成本地相对名
  seg-00001.ts ...
  init.mp4         ← EXT-X-MAP 产物
  key.bin          ← EXT-X-KEY 的 URI 目标
  danmaku.xml
  meta.json        ← sourceUrl / header / etag / duration / segmentCount
                     / completed / bytes / hasKey / createdAt / lastAccessAt
```

`lastAccessAt` 是 LRU 的键，前稿只写了「20GB 上限」，没说按什么淘汰。

**不要试图把 HLS 合成一个 mp4**：仓库里没有 ffmpeg、没有 mp4box/mux.js，
web 依赖只有 hls.js/dashjs（`client/apps/web/package.json:10-19`）。
现拉一个 muxer 会同时丢掉断点续传。

### 4.5 失效与清理

- `meta.json` 记 `etag`/`lastModified`；源变了**提示「有更新」但不自动删**（与
  `ApiServer.java:5384` 图片的 `max-age=86400` 一个立场：宁可留旧，不要让人正在看的片子消失）。
- 淘汰按 LRU，默认 20GB，可配。
- 设置页「清空本地缓存」（`SettingsView.vue:596-607`）现在只清 localStorage
  + sessionStorage + Cache Storage（`caches.keys()`），**碰不到任何媒体缓存**，
  也没有后端调用。要加一条 `DELETE /api/cache`（仅桌面端显示）。
  顺带一个副作用：它会 `sessionStorage.clear()`（`:602`），而 `sessionStorage` 里存的是
  `PlayView` 的失败线路表，所以「清缓存」会顺手重置自动换线的记忆。

### 4.5.1 `[已实现]` 缓存落盘与清理的真实现状（2026-10-30）

上面 §4.4–4.5 是设计稿，实现与它有四处不同，**以本节为准**：

| 项 | 设计稿 | 实现 |
|---|---|---|
| 目录 | `cache/<site>/<vod_id>/<ep>/` | `cache/video/<id>/`，`id` = `site+vodId+ep` 的哈希 |
| 弹幕位置 | 每集目录里的 `danmaku.xml` | **独立目录** `cache/danmaku/<md5(键)>.xml`，键是 `dm\|<剧名>\|<集>` |
| 配额淘汰 | LRU 20GB | policy 的 `cacheQuotaGb`（默认 8） + `cacheEvictMode`（lru / off） |
| 清单 | 集内结构表 | 见 §4.4 的 `playlist.m3u8` 改写说明，仍然成立 |

#### 弹幕必须在缓存时就抓下来（不能只靠播放时）

**踩过**（2026-10-30）：弹幕只在**播放时**才被拉取（`fetchDanmakuAuto`），
所以"从没在线播过、直接点缓存"的剧，磁盘上没有弹幕文件 —— 断网后打开这一集，
上游全连不上，弹幕是空的。而"离线也能看完一集"里的"看完"包含弹幕。

修法：`VideoCache.run()` 在**分片全部下完之后**调一次预取（`prefetchDanmaku`）。
顺序有讲究——放最前面会和分片抢带宽，也会在 m3u8 都拉不到时白花时间；
且失败不算缓存失败，没有弹幕的集照样能播。

```java
if (t.done == 0) { fail(t, "一个分片都没下到"); return; }
prefetchDanmaku(t);          // ← 分片齐了才抓弹幕
t.state = "done";
```

**★ 预取必须复用播放时那同一个函数，不能另外写一份抓取逻辑**：磁盘缓存键是
`dm|<剧名>|<集>`，剧名 strip 规则或集数解析规则差一点，缓存就永远命中不了。
所以 `VideoCache` 通过 `bindDanmakuPrefetcher` 回调到 `ApiServer` 的
`fetchDanmakuAuto`（core 包不反向依赖入口类，TV 网关的减配版后端也才干净）。

#### 内存命中也要补落盘（更隐蔽的一个洞）

`fetchDanmakuAuto` 原来在**内存 TTL 命中时直接 return，跳过落盘**。
内存 TTL 30 分钟、磁盘 30 天，于是"先在线看过这一集、再点缓存"的路径
**永远不写盘**——日志里明明打印"成功 15280 条"，磁盘上零文件。

```java
String cached = DANMAKU_CACHE.get(cacheKey);
if (cached != null) {
    if (!cached.isEmpty()) danmakuDiskPut(cacheKey, cached);   // ← 补这一行
    ...
}
```

写盘是幂等的（同 key 覆盖同一文件），重复写几 KB 比"看起来成功了其实没存"好得多。

#### 弹幕缓存以前只增不减

TTL（30 天）只在**读取时**判过期不命中，文件本身永不删除，也没有
容量上限、清理任务或手动入口。OECT 上实测攒到 **23 个文件 / 22MB**，
用户既看不到也清不掉。

现在：

| 端点 / 入口 | 行为 |
|---|---|
| `GET /api/cache` 的 `danmakuBytes` / `danmakuCount` | 占用与文件数（与视频缓存分开算，不占配额） |
| `POST /api/cache/control` `{"action":"clearDanmaku","mode":"expired"}` | 只删超 30 天的（默认） |
| 同上 `"mode":"all"` | 全清 |

设置页「存储」区给两个按钮：**清过期 / 全清**。默认给"只清过期"——
全清会把昨天刚缓存、今晚火车上要看的弹幕一起删掉。

> **老后端不返回 `danmakuBytes` 时**，前端显示 `—` 而不是 `0`：
> 把"不知道"说成"没有"比不显示更糟（OECT 上实际有 22MB）。

#### 设置页「存储」不再列逐条清单

原来这里列每一集的「已就绪 / 366 MB / 删除」。2026-10-30 用户要求删掉
（"不应该显示清单明细吧，显示当前占用就行了吧"）——管理的入口已经在
「我的缓存」页（海报墙 → 详情 → 选集），设置页再列一份是两套界面管一件事，
而且一部长剧能把这一屏铺满。现在只留**汇总**：视频缓存（含配额）与弹幕缓存两格。

#### 「我的缓存」页是海报墙，不是集列表

一集一张小卡会让 24 集的剧铺满 24 格、海报重复 24 次。现在：

- **一剧一张卡**（聚合键 `site|vodId`），角标显示"已下 3/24 集"
- **整卡可点**进详情层（海报 + 信息 + 选集，与本地片库详情同一套骨架），
  卡上**没有播放/删除按钮**——TV 上少两个可聚焦元素就少按两次方向键，
  而"删除"这种不可逆操作紧贴海报误按代价大
- 详情层是**页面内换层**，不是弹层：TV 上弹框要跨两层挪焦点、退层还得分两步
- 单集的暂停/取消/删除/继续下载收在选集下方一条操作条，作用于刚点的那一集
- 海报优先用后端本地 `/api/cache/poster`：离线时远端图床连不上，
  只用远端地址会让整页变灰块——那正是这个页面最不该出现的样子

> **失败任务不该长成一张卡**：`site|vodId` 不同（同一部剧从另一个源缓存失败）
> 就会多出一张"0/1 集 · 无海报"的空卡，看起来像缓存了两部不同的剧。
> 后端 `grouped()` 现在不给"失败/取消且零字节"的任务建组（`running`/`paused` 除外）；
> 前端再兜一层过滤，因为 PC/TV 的内置后端随插件发布，插件没升级前仍是旧行为。

### 4.6 先做哪一端

**先 PC。** 三个理由：

1. **PC 是唯一拔网线还能启动的端**（§4.3 前提 ③）。Web/TV 连壳都加载不了，
   缓存做完也验不了。注意 PC 的首页在离线时会被「后端未连接」卡片占住，
   **验收要从 `/history` 进**，不是从首页点进去。
2. PC 有确定的落盘目录和本地 sidecar，能直接跑「断网验收」这条测试。
3. 弹幕落盘只需 1–2 天就能把「断网弹幕在」验掉，而视频分片下载是长工期。
   **先拿弹幕把链路打通，再扩到视频。**

TV 要能离线，得先解决「壳从哪加载」：把 `apps/web/dist` 拷进
`app/src/main/assets/` 并改成加载 `file:///android_asset/index.html`，
这要改 `MainActivity.java:106-109` 和 `app/build.gradle`（加 copy 任务）。
**这一步不做，TV 的缓存就没有可用的运行环境。**

> **这一步有三个已知障碍，前稿没写，不解决就成不了**：
> ① **`vite.config.ts` 没有设 `build.base`**（全文无 `base`），产物引用的是
> `/assets/...` 绝对路径，`file://` 下会 404 → 必须改成 `base: './'`。
> ② `file://` 页面的 Origin 是 `null`，访问 `http://` 后端会触发 CORS；
> 后端 `applyCors` 要能接受 `Origin: null`（现在只回显 `allowOrigin`，未处理 null）。
> ③ WebView 加载 `file://` 后再请求 `http://` 属于 mixed content——
> 当前 `MainActivity.java:63` 是 `MIXED_CONTENT_ALWAYS_ALLOW`，这条**已经放行**，
> 但它是全局放开，属于既有技术债，不是新引入。

TV 有一个 PC 没有的潜在优势：原生 ExoPlayer 跑在 App 进程里，不走 WebView 也不走
后端代理，理论上可以直接吃 `file://` 或端内网关地址。但**它现在只在 WebView
播放失败后兜底一次**（`PlayView.vue` 里 `if (!nativeTried && hasNativePlayer())` 分支），
仍要页面先加载成功才会被触发，
所以离线的第一步依然是「让壳能离线启动」，不是「让 ExoPlayer 能读本地文件」。

### 4.7 要新增的端点

**分两张表，别混。** 前稿说「全部写进 `:548`–`:663` 那张 equals 表」是错的：

- `/api/cache/*` → 必须进显式 equals 表（`:548`–`:663`），
  否则会被 `:671-679` 的 `/api/{site}/{action}` 兜底当成站点名 `cache`，
  报出误导性的 `cannot load spider cache`（`:650-652` 的注释记的就是这个坑）。
- **`/cache/...` 不在 `/api/` 下**，`path.startsWith("/api/")` 这个兜底条件对它不成立
  （`ApiServer.java:671`）。它会一路落到 `:681` 的
  `sendJson(ex, 404, "not found")`。所以**它需要新增一个 `/cache/` 前缀分支**，
  放在 `/proxy`（`:663`）附近、`/api/proxy/` 兜底（`:667`）之前，
  **不是写进 equals 表**。

```
# 进显式 equals 表
POST   /api/cache/prepare   {site,vod_id,ep,url,header,danmakuName,danmakuEp} → jobId
GET    /api/cache/status?job=
GET    /api/cache/list
DELETE /api/cache/item?site&vod_id&ep
DELETE /api/cache
GET    /api/cache/play?site&vod_id&ep   → {url, danmakuUrl, cached:true}

# 新增前缀分支（不在 /api/ 下）
GET    /cache/{site}/{vod_id}/{ep}/{file}  ← 本地静态服务，必须支持 Range/206
```

最后一条是本地静态文件服务。仓库里唯一的 Range 实现是 `handleStream` 的透传分支
（`:4477-4490` 附近：抄 `Content-Range`、硬写 `Accept-Ranges: bytes`），可以照抄写法，
但**不能直接复用**——它要求上游是一个 http 源。

---

## 五、分期与验收

排序原则：**先打通播放链路，再扩协议，最后做离线。** 前一期的验收不过，后一期不许开工。

| 期 | 内容 | 工时 | 验收标准（可验证） |
|---|---|---|---|
| **P0** | 播放链路认证透传：`handleStream` 加凭据通道（形式见 §1.7 的「凭据不能放 query string」）；`proxyStream` 配合 | 1d | 对带 Basic 认证的 WebDAV mp4 拖进度条得到 **206**；`curl` 该代理地址返回 `Content-Range` |
| **P1** | `GET /api/library/dav` + `NfoParser`（`.nfo` + 同目录图片） | 2d | 见下方「P1 的可执行验收」 |
| **P2** | `/library` 路由 + `ChoiceDialog` + 设置页「本地片库」分区 + `/api/library/detail` 与 `/api/library/play` | 2d | Web 点「添加」弹出居中模态、三按钮等宽竖排、Esc 与点遮罩都能关；TV 遥控器能聚焦三按钮、BACK 关闭且**停在设置页不退到首页**；点片库条目能进详情页**不出现 `cannot load spider`** |
| **P3** | AList 源（ext 注入 + `/api/fs/list`） | 2d | 填 AList 地址（含 `login`）→ 列出目录 → 点进去能播；`/api/health` 的 `ext` 计数 +1；**换一个加密目录**，填 `params[0].pass` 后能进 |
| **P4** | PC 本机目录（Rust 网关 + `read_dir`） | 2d | 见下方「P4 的可执行验收」 |
| **P5** | 弹幕落盘 + 本地读序 | 1d | 见下方「P5 的可执行验收」 |
| **P6** | 视频分片下载 + 清单本地重写 | 3d | **断网完成一集**：画面连续、能拖进度、退出再进续播到同一位置（本章唯一口径） |
| **P7** | 缓存清理界面 + LRU 淘汰 | 1d | 设置页「清空本地缓存」后 `data/cache/` 为空；超上限时删最久未访问的集 |
| **P8** | 在线刮削（**可选，不计入总工时**，TMDB + 用户自带 key） | 2d | 有网时补出海报与简介；**断网或 key 无效时退化成文件名，不报错、不空白** |

**核心工时 = 14d（P0–P7：1+2+2+2+2+1+3+1）。P8 是可选增量（+2d），做不做都不影响 P0–P7 的验收。**

P0 是唯一的前置门禁：**它不过，P1/P3/P4 全都只能列目录不能播。**

### 5.1 P1 的可执行验收（前稿写的「换一台 NAS」不可执行）

仓库里没有任何 WebDAV 测试台架，也没有第二台 NAS。改成**可复现的两段**：

1. **对真实 NAS**（§零 那台）：`POST /api/library/dav` 指向 `/视频/`，
   必须返回 5 个目录（`18NO`/`其他`/`动漫`/`电影`/`电视剧`）；
   指向 `/视频/电影/教父/`，必须返回文件条目且 `size` ≈ 8998666874。
2. **对合成 XML 跑单测**（这部分才真正验证「命名空间前缀容错」）：
   仓库现有测试只在 `client/apps/web/tests/`（9 个 `.test.ts`，vitest），
   **`server/host/test/` 不存在**，后端也没有测试框架。所以有两个选择：
   （a）把 XML→数组的解析逻辑放在前端（`api/davXml.ts`），在 `client/apps/web/tests/`
   里加 `dav-parse.test.ts`——**推荐**，零新依赖、能直接跑；
   （b）放后端就得先引入测试框架（属于新增工程）。
   fixture 至少覆盖三种真实变体：`<D:href>`（大小写混合）、`<d:href>`（全小写）、
   无前缀 `<href>`；以及两种缺字段：没有 `getcontentlength`、没有 `resourcetype`。
   **每条 fixture 断言解析结果**，不是断言「不抛异常」。

### 5.2 P4 的可执行验收

前稿的「访问根外路径返回 403」没有网关设计支撑（§2.5.2 已补设计）。可执行步骤：

1. 设白名单根为 `D:\test`，请求 `http://127.0.0.1:<port>/media?p=D:\test\a.mp4` → 200。
2. 请求 `p=D:\other\b.mp4` → **403**。
3. 请求 `p=D:\test\..\other\b.mp4` → **403**（`..` 穿越，验证 canonicalize 生效）。
4. 带 `Range: bytes=0-1023` → **206** + `Content-Range: bytes 0-1023/<total>`。
5. **不带 token** 请求 → 401。
6. 地址**不经过** `/api/proxy/stream`（浏览器 Network 面板里不应出现该请求）。

### 5.3 P5 的可执行验收（前稿的顺序不可执行）

前稿写「关掉后端，对比 `X-Danmaku-Count`」——**后端关了就没有响应头**。正确顺序是
**先取基线、再断网**：

1. **在线**：正常播一集，记录 `X-Danmaku-Count` 的值 `N`（该响应头在
   `ApiServer.java:3783` 设置）与 `data/cache/.../danmaku.xml`
   的字节数 `B`。
2. **在线**：确认 `danmaku.xml` 已落盘且能按 `<d>` 解析出 `N` 条
   （用 `parseDanmakuXml` 的同一逻辑调一次）。
3. **断网**（关后端进程或拔网线）：从 `/history` 进到同一集，**弹幕条数仍为 `N`**。
4. 断言请求走的是本地文件：DevTools 里 `danmaku` 相关请求应指向 `/cache/...` 或
   `file://`/端内网关，**不应出现 `/api/proxy/danmaku`**。

**验收必须逐项跑过再汇报**。本章不做「代码改好了」式的结论——
P1–P8 全部是未实现的，没有任何一项可以在本轮声称通过。

---

## 六、与当前版本的关系

**本文全部是增量设计，不改变现有任何行为。** 具体：

1. **不改现有端点语义**：`/api/webdav`、`/api/proxy/stream`、`/api/proxy/image`、
   `/api/state/*` 的入参与返回形状保持不变。P0 只是给 `handleStream` **增加**
   可选的凭据通道，缺省时行为与现在逐字节一致。
2. **不动同步链路**：`webdavUrl/user/pass/dir` 与 `sync.ts` 的快照逻辑不受影响。
   片库配置走独立 key（`meow.library`）——`WebdavConfig` 与它本来就不是同一个
   localStorage key（`prefs.ts:153` vs `:399`），且**`WebdavConfig` 从不进备份**
   （`makeBackup` 在 `:433` 只序列化 `getPrefs()`）。
   后端侧的真正的防护是 `STATE_PREFS_SYNC` **白名单**（`ApiServer.java:5211` 起，
   不在名单里的键不落盘、不上传）；新 key 天然不在里面。
   > **不要引用 `STATE_PREFS_SKIP` 当防护**——它在 `:5222` 只有声明，
   > **全仓无任何读取点**（`grep -rn STATE_PREFS_SKIP --include=*.java .` → 1 行）。
3. **不动现有源**：片库不注册进 `SITES`，因此不计入 `/api/sites` 的 44 条静态注册、
   不参与 `searchAll`/`liveAll` 的全量扇出、不影响健康降级。
   **代价是详情/播放必须走新端点**（§2.4），这一点已写进 P2 验收。
4. **不动现有 UI**：设置页只**新增**一个分区与一项导航，不重排既有 10 个分区
   （含 TV 专属的 `localexec`）；顶栏只新增一个 `RouterLink`。
5. **顺手修的两处注释与实现不符**（纯文本，无行为变化）：
   - `ApiServer.java:4757` 图片代理注释声称「并做本地缓存」，实现没有
     （`:5384` 只有响应头）；
   - `SettingsView.vue:1476` 注释写「8 个分区块」、`:2339` 与 `:2558` 两个注释都编号「8.」，
     实际是 10 个分区（比写这段注释时又多了一个 `localexec`）。改动时一并订正。
6. **一个已知风险，本轮不处理**：`handleWebdav`（`:4776`）没有 SSRF 校验，
   且能用 `GET` 带 body 绕开 `writeRequiresAuth`（`:468-475`）。
   新增的 `/api/library/*` **不要**复用它的实现；现有行为保留不动，
   单独排期（属于安全整改，不属于本文范围）。

---

## 七、实现后的六个维护判据（改这块之前必读）

设计已完成、代码已上线。下面六条是**实现时踩出来的约束**，改动时违反会直接坏功能。

**① 片库与 `/api/proxy/*` 刻意分离，不要合并**

代理接受任意 URL；片库只访问配置里声明过的那个根，路径由服务端拼接（`core.Library`）。
把两者合并等于把"任意 URL 访问"能力交给片库入口。

**② `/api/library/stream` 必须支持 Range**

否则 2GB 一集没法 seek。

**③ 整季下载走 `/api/cache/batch`，不要用 `POST /api/cache` 的 `items` 分支**

后者每集再 4 路分片并发，整季 20 集 = 80 条连接打同一源站，实测拿 429/断流。
`batch` 走全局 2 路队列（`VideoCache.BATCH_POOL`）。

**④ 断点续传判据是"文件存在且非空"，不比对字节数**

上游分片会随广告插入变化，比字节数会让"已下载但上游改了"的分片被判失败。
分片先写 `.part` 再 rename，避免 kill 时留下"非空但截断"的文件被当成已下好。

**⑤ `policy.cacheDir` 进程内只解析一次**

每次重读会让任务跑到一半换盘、分片散落两个目录。改它必须重启后端
（`GET /api/cache` 的 `cacheDirReloadRequired` 会告诉你是否还没生效）。

**⑥ `degraded`（自动降级）与 `disabled`（手动禁用）是两个字段，别合并**

混成一个布尔，重启后就分不清"该自动恢复"还是"用户要禁用"。
判定统一走 `ApiServer.isSiteSkipped()`——搜索、直播、探活三处都调它。
新增聚合入口也要调，否则会出现"手动禁用了但某个入口还在打它"。

**★ 转码不能拿首次响应判成败**：`POST /api/transcode` 只是把任务排上，此时
`state=running` 且 playlist 还是空，必须轮询等分片就绪（实测踩过：界面报
"转码不可用"，后端其实已经有 79 个分片）。

---

## 附：本文用到的核对命令

> 下面每条都在写作时跑过。**注意：涉及 `|` 的必须写 `-E` 或 `\|`**——
> 裸 `|` 在 BRE 里是字面量，会得到永远为 0 的假阴性
> （实测：`printf 'role="dialog"\n' > /tmp/x && grep -c 'role="dialog"|aria-modal' /tmp/x`
> → `0`，而 `grep -cE` → `1`）。本文初稿有两处写成裸 `|`，结论碰巧正确但方法是错的，
> 已在下面改对。

```bash
# 片库已实现（2026-11-04 核对）
grep -rnE "api/library|LocalLibrary" server/host/src/shared client/apps/web/src   # 13
grep -rnE "Files\.list|Files\.walk|walkFileTree|newDirectoryStream|listFiles" server/host/src/shared   # 18
grep -rn "sendLocalLibraryFile" server/host/src/shared                  # 2（routes/LibraryRoutes.java）

# 刮削四条路线
grep -rniE "xbmc|kodi"       --include=*.java --include=*.ts --include=*.vue server/ client/  # 0
grep -rniE "themoviedb|tmdb" --include=*.java --include=*.ts --include=*.vue server/ client/  # 0
grep -rnE  "\.nfo|parseNfo"  --include=*.java --include=*.ts --include=*.vue server/ client/  # 0

# 协议注册
grep -c 'SITES.put("' server/host/src/shared/ApiServer.java   # 44
grep -c 'EXT.put("'   server/host/src/shared/ApiServer.java   # 10 行 / 11 个独立 key
grep -n 'EXT.put("AList"' server/host/src/shared/ApiServer.java  # 无

# 播放链路不转发认证头（行号按旧 HEAD 3eeaacc，现文件已 10361 行；结论待复核）
awk 'NR>=4502 && NR<=4700' server/host/src/shared/ApiServer.java | grep -cE 'Authorization|Cookie|userInfo'  # 0（旧范围）

# 死代码：STATE_PREFS_SKIP 只有声明，无读取
grep -rn 'STATE_PREFS_SKIP' --include=*.java .          # 1（仅 5222 行声明）

# 缓存全无
ls data/cache 2>/dev/null || echo absent                # absent
grep -rn 'DataPaths.dir(' --include=*.java server/      # 0

# 文件名解析实测（模块单独加载，绕开包初始化）
py -3 -c "import importlib.util;s=importlib.util.spec_from_file_location('fp','上游参考项目);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.extract_season_episode('[Group] Anime - 05 [1080p].mkv'))"
# -> (None, None)
```
