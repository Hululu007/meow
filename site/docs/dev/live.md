# 直播

直播页是**聚合视图**，不是逐站浏览。输入有两类：spider 的 `liveContent`（`/api/live`）与
IPTV 播放列表（`config.sites.json` 的 `lives` + 两条内置源）。后端只返回站点分组和播放列表
清单，不解析 m3u；播放列表由前端逐条交给 `/api/live/playlist` 解析，再由 `liveMerge.ts` 合并。
现有 jar 里没有类实现 `liveContent`，播放列表是实际来源。

## 一、两个来源

| 来源 | 从哪来 | 谁解析 | 现状 |
|---|---|---|---|
| 站点直播表 | spider 的 `liveContent` | 后端 `/api/live` 直接给 `groups` | jar 里 72 个类 0 个实现（`ApiServer.java:11926-11927`），通常为空 |
| IPTV 播放列表 | `config.sites.json` 的 `lives` + 内置两条 | 前端逐条调 `/api/live/playlist` | 事实上的唯一来源 |

- 用户源**存在后端**（`/api/lives` → `saveLives` → `config.sites.json`），不是前端本地；
  设置页「直播源」只动 `lives` 表，不碰 `sites`（`ApiServer.java:2885-3075`）。
- 内置源由 `livesWithBuiltin()` 注入，与用户源**并存**，不是二选一（`:12001-12027`）。

### 1.1 内置的两条源

`BUILTIN_LIVES` 预置两条（`ApiServer.java:11943-11956`）：

| 名称 | 地址 | 量级（上游会变） |
|---|---|---|
| 公共直播源（每日更新） | `https://guovin.github.io/iptv-api/result.m3u` | 约 836 条 → 332 个唯一台 |
| iptv-org 中文台 | `https://iptv-org.github.io/iptv/languages/zho.m3u` | 222 个唯一台 |

**为什么用语言包而不是国家包**：zho 有 222 个唯一台，cn 只有 152 且 145 个被 zho 覆盖；
zho 独有 78 个（港澳台、CCTV-4 各洲版、CGTN 等）。一条顶替 cn+hk+tw 三条，代价是解析
0.7s 而不是 0.15s（`ApiServer.java:11946-11954`）。数量会变，判断源是否可用看
`/api/live/playlist` 的 `ok` / `channels`；Guovin 条数在代码注释里一处 836（`liveMerge.ts:11`）、
一处 837（`ApiServer.java:11931`），都是抓取快照，不必互相"纠正"。

| 行为 | 说明 |
|---|---|
| 逐条删除 | `DELETE /api/lives {url}`；内置源不在表里时写 `builtinLiveOff` **URL 数组**（兼容旧 boolean，`ApiServer.java:11965-11988`） |
| 不会自动回来 | 未清标记前不再追加。注意不是「表空/首次启动才补」——每次读列表都追加未禁用的内置源（`:12011-12027`；`:11937` 的旧注释与实现不符） |
| 恢复默认 | `POST /api/lives {resetBuiltin:true}` 清标记（`:2995-3006`） |

**三条风险**（设置页说明文字里也写了）：①第三方转播流，版权状况不明；②别人的服务器，
挂了就是挂了；③走 CDN/GitHub Pages，国内网络可能不稳（`ApiServer.java:11939-11941`）。

## 二、后端聚合：`/api/live`

返回 `{tried, failed, groups[], playlists[]}`：

| 字段 | 含义 |
|---|---|
| `tried` / `failed` | **站点数**，不是播放列表数；空返回、异常、解析失败都计入 `failed`（`ApiServer.java:2833-2854`） |
| `groups` | 只有 `liveContent` 有实现时才非空；`urls` 里的 `$备用名` 原样透传（`:2759-2760`） |
| `playlists` | `livesWithBuiltin()` 的 `{name,url}`，**没有 count**（`:2861-2872`） |

`tried == failed` 只说明所有站点的 `liveContent` 没给东西，播放列表仍可能完全可用——这正是默认状态。

- 总预算 **12 秒**（`LIVE_TOTAL_TIMEOUT_MS`，`ApiServer.java:2745`）。`CompletionService` 谁先回谁先收，但响应在预算结束（或全部返回）时**一次发出**，不是流式（`:2796-2873`）。
- body 可带 `sites` 收窄目标；默认全量并跳过 `isSiteSkipped`（`:2768-2782`）。
- 只有 `/api/live` 没给分组时才自动解析并合并播放列表；有分组就直接用站点分组（`LiveView.vue:696-712`）。

### 2.1 播放列表解析 `/api/live/playlist`

- `POST {url}`。同时认 m3u（`group-title`）与 txt（`分组名,#genre#`）（`ApiServer.java:3115-3126`）。
- 没有分组信息归「未分组」；非 http 地址丢弃（`:3226-3227`）。「更新时间 / 更新日期」这类元数据分组整组丢弃，它不是频道（`:3228-3239`、`:3265-3267`）。
- 走宽松档 SSRF：允许局域网（自建 IPTV hub 是真实场景），仍拒回环与链路本地；8s connect / 20s read（`:3131-3145`、`:3154-3155`）。
- 响应带 `updated`（取自 `Last-Modified`），前端据此显示「更新于 X 天前」（`:3148-3175`）；前端单条请求超时 30s（`api/index.ts:587-596`）。

## 三、前端合并：`liveMerge.ts`

六个纯函数：`normChannelName` / `cleanChannelName` / `zhGroupName` / `mergeSources` /
`sourceCountOf` / `describeSources`。`mergeSources` 是两遍式（`liveMerge.ts:140-160`）：

1. 逐源逐分类建结构，**分类内**同名台只建一行；同时把每条线路塞进「归一化台名 → 线路」全局池。
2. 回填：每个分类里的台从池里取全部线路。

- **分类之间不合并行**：CCTV-1 在「央视」和「4K 专区」各出现一次，用户看到两行。全局去重
  会让分类里的台被搬走甚至整类消失（反例见 `liveMerge.ts:147-160` 的注释）。
- **线路池是全局的**：同一个台在任意分类里点，都能切它全部线路——跨源提可播率正是
  合并的目的。规范名取首次出现的写法，清掉 `[Geo-blocked]` 这类噪音（`liveMerge.ts:199-204`）；
  分类归属由源顺序决定（前端不重排，`grep -n "\.sort(" LiveView.vue` 无结果）：**有用户源时
  用户源在前**、其分类先出现；默认空表时 Guovin 才在列表首位（`ApiServer.java:12011-12027`）。
  `:11999` 与 `:12007-12009` 的 javadoc 写「内置的排前面」，与实现相反——只存在于注释里。

归一化刻意不做两件事（`liveMerge.ts:53-59`）：不去 `4k` / `8k`——`CCTV-4K` 是独立频道；
不做中英互译——`Anhui TV` 与 `安徽卫视` 无法可靠关联，宁可并列两行。英文分组名按 `GROUP_ZH`
映射，未命中保留原文，不塞进「其他」。`preferUrl` 只重排线路池顺序，不改分类归属
（`:219-233`）；同一 URL 在池内去重（`:205-210`）。设置页可关掉多源合并（`prefs.liveMerge`）：
关掉就只打开上次用的那条源，退回单源行为（`LiveView.vue:468`、`:704-706`）。

实测两源归一化交集只有 14 个台（合并后约 471 个）：重复台不是主要矛盾，**分类名中文化**
才是（`liveMerge.ts:9-16`）。

## 四、坏台与坏线

```
起播 6 秒没画面（readyState < 2 且 currentTime == 0）
  ├─ 同台还有线路 → 换线路（lineTryCount++，上限 urls.length-1）
  └─ 线路试完     → 换下一个台（autoSkipCount++，到 5 就停）
```

- 起播窗口 `BAD_CHANNEL_MS = 6000`（`LiveView.vue:335-342`）。原来 3 秒会把「慢但能播」的
  HLS 台判成坏台（实测首屏 5–8 秒），整组跳完还报「全都放不出来」。
- 两个计数器**必须分开**（`LiveView.vue:325-332`）。混用会让「试试下一条线路」被算成
  「跳了 N 个台」，整组很快被误判成全坏，用户看到的是「换台了但没播」。
- `MAX_AUTO_SKIP = 5`，超过就停下提示（`LiveView.vue:334`、`:1873-1914`）。换台/换线定位
  用对象引用或下标，不能用台名：同名频道很多（CCTV1 × 200），按名字 `findIndex` 会
  「换到自己」（`LiveView.vue:90-96`）。

## 五、缓存

- **模块级会话缓存**必须写在普通 `<script>` 而不是 `<script setup>`：后者每个组件实例一份，
  退出再进就重新初始化，缓存永远命不中（`LiveView.vue:1-16`）。
- 磁盘缓存 `meow.live.disk.v1`（localStorage），TTL **6 小时**，只存「拿到分组」的结果；
  900 台约 120KB（`LiveView.vue:378-390`）。
- stale-while-revalidate：命中缓存先起播，后台再拉 `/api/live` 与 m3u，新数据回来才替换，
  正在播的流不受影响（`LiveView.vue:603-627`）。写盘防抖 **800ms**：渐进合并时每条源回来
  都会触发快照（`LiveView.vue:401-431`）。
- m3u 解析结果按 URL 缓存（`PARSE_TTL` = 10 分钟，`LiveView.vue:23`）；手动刷新会先清掉它
  （`:624-625`）。
- 初次 `loading` 是 `false`：有缓存时不能再用全屏转圈盖住已起播的画面（`LiveView.vue:59-70`）。

## 六、EPG

不做节目单。全仓没有 EPG / XMLTV 解析代码，频道数据只有名字与线路。

## 七、改这块之前

| 要改什么 | 先看 |
|---|---|
| 加 / 改内置源 | `BUILTIN_LIVES` + `builtinLiveOff`；设置页「836 / 222」是写死文案（`SettingsView.vue:5455-5457`），改常量要同步改 |
| 改去重 / 合并规则 | `liveMerge.ts` + `tests/live-merge.test.ts`。仓库没有 `test` 脚本，在 `client/apps/web` 下跑 `./node_modules/.bin/vitest run tests/live-merge.test.ts` |
| 改换台策略 | 两个计数器 + `MAX_AUTO_SKIP` / `BAD_CHANNEL_MS`，见 §四 |
| 改缓存时长 / 首屏 | `DISK_KEY` / `DISK_TTL` / `PARSE_TTL`，注意模块级 `cache` 的位置 |
| 改播放列表格式 | `parsePlaylist` + `isMetadataGroup`；txt 的 `#genre#` 是行业写法，不能删 |

## 相关

- 用户操作：[点播与直播](/guide/vod-live)
- 源包 `lives` 字段：[源包与配置格式](/ecosystem/source-format)
- 前端整体结构：[前端手册](./frontend.md)
