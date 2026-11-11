# 弹幕

弹幕是**多源竞争**的：同一集把可用来源同时发出去，先到先用，剩下的在后台补全。
这一页写清来源、顺序、降级、缓存与播放器侧调度。

## 一、四个来源（先分清两个概念）

`DANMAKU_PRIORITY`（`server/host/src/shared/ApiServer.java:6225`）里有四个值：

```
iqiyi / tencent / danmu_api / aggregator
```

但它**只决定手动搜索候选的排序**（`sourcePriority()`，`:6349`），不决定自动抓取顺序。
自动链由 `danmakuOrder()` 决定，合法值只有三个：`iqiyi`、`tencent`、`aggregator`。

| key | 是什么 | 备注 |
|---|---|---|
| `iqiyi` | 爱奇艺直连 | 最快（搜不到秒回；直连通常 1–3 s），覆盖中等 |
| `tencent` | 腾讯直连（经 360 定位 vid） | 设置页可关：policy `danmakuTencent`，默认开 |
| `aggregator` | 聚合档 | 自建 `danmu_api` 的 host 全部优先并发，没有自建才用内置镜像；回传来源标记统一为 `danmu_api`（`sourceTagOf()`，`:7847`） |
| `danmu_api` | 自建聚合服务 | **不是独立的自动档**，属于 `aggregator` 档；地址在 policy `danmakuApi` |

所以"四源"是优先级表的口径，实际自动抓取只有三档：`iqiyi`、`tencent`、`aggregator`。

## 二、前端可覆盖顺序

`policy.json` 的 `danmakuOrder` 可以改自动链（数组或逗号串都支持）：

```
["aggregator","iqiyi","tencent"]   // 设置页「弹幕 API 优先」
["iqiyi","tencent","aggregator"]   // 默认：内置直连优先
```

- 未知项直接丢弃；解析后为空则回退默认 `iqiyi,tencent,aggregator`（`:7876`）。
- 设置页只暴露两档：「内置直连优先」写默认数组，「弹幕 API 优先」写 aggregator 开头。
- 配了 `danmakuApi` 但没写 `danmakuOrder` 时，设置页显示「API 优先」，**后端仍是默认顺序**——
  要保存一次才真正生效。
- 首屏预算：aggregator 排第一 → 10 s，否则 6 s（`:7933`）。只写一个源时同步执行，不适用预算。
- 不是串行：所有源同时提交，**第一个非空结果立即返回**（通常是 iqiyi/tencent，1–3 s）。

剩余源继续在后台跑；结果**明显更全**（≥1.2 倍条数）才覆盖缓存，下一次 seek / 切回 / 重进
才用上。响应发出后无法替换内容，所以策略是「这次快，下次全」，不是边播边换。

## 三、降级与空结果

- 全部失败返回**空 XML**，并带 `X-Danmaku-Empty: 1`；来源和条数在 `X-Danmaku-Source` /
  `X-Danmaku-Count`（`ApiServer.java:8996`）。前端读响应头，不能只看 body 是否为空。
- 空结果只做 **30 秒负缓存**，不写磁盘（`:7860`）；前端 30 秒后自动重试**一次**
  （`VideoPlayer.vue:4054`），避免无限请求。
- 同一集并发请求会去重：后到的等先到的完成（最多 20 秒，`:7602`），超时才自己抓，
  防止打上游限流。
- 常见空结果：本集确实没有；`danmakuOrder` 只留 aggregator 而自建没起、内置镜像全在冷却；
  片名与平台命名差异；源站风控。

## 四、缓存

| 层 | 位置 | 生命周期 |
|---|---|---|
| 后端内存 | 进程内 TtlCache | 成功 30 分钟；失败 30 秒（`:7855`、`:7860`） |
| 后端磁盘 | `data/cache/danmaku/<md5>.xml` | 30 天（`VideoCache.DANMAKU_TTL_MS`，`VideoCache.java:1407`）；写入即查配额，按 lastModified LRU 淘汰，**正在播的那一集受保护**（`VideoCache.java:1488`） |
| 前端 IndexedDB | `meow-danmaku` | 30 天；单集 ≤2 MB、≤300 集，按 `at` 淘汰最旧（`danmakuStore.ts:18-27`） |

- 前端**本地优先**：命中就先用，省一次往返；空结果不写本地（避免把上游抖动固化）。
- 首次加载后（含本地命中）**12 秒**发一次 `fresh=1` 检查（`scheduleDmUpgrade`，
  `VideoPlayer.vue:4096`；后端据此跳过内存/磁盘缓存与去重等待，`:7560`）。
  新结果 ≥1.2 倍（`:7669`）且处于安全点（`currentTime < 15 s`，或 3 秒内刚 seek，
  `dmUpgrade.ts:41`）才整份替换并提示；播放中途不静默换源，避免弹幕突然变密。
- 后端磁盘命中会刷新"最近使用"并标记"正在播"（`ApiServer.java:8430`），正在播的集
  因此不会被配额清掉；预取写入用额外保护键，不抢占"正在播"标记（`ApiServer.java:8451`）。
  前端淘汰只看 `at`，**没有**"正在播不清理"的保证。

## 五、播放器侧的调度

三条硬规则：

1. **暂停/缓冲跟随视频**：`waiting` → `dm.pause()`；`play` / `canplay` / `timeupdate` 前进 →
   恢复并 `sync()`。全程**不清屏**。`stalled` 不能接进来：它是网络层事件，画面没停也会把
   引擎冻死（实测踩过）。
2. **容差必须大于插值超前量**：`danmaku.ts sync()` 的跳转判据是后退 >0.75 s、前进 >1.5 s；
   rAF 插值最多超前 0.4 s。**0.75 > 0.4**，缓冲恢复（time 最多回退 0.4）不会被误判成 seek。
   旧阈值 -0.3 会让每次缓冲恢复都清屏重打。
3. **倍速只改时间轴**：播放器把 `playbackRate` 传给 `setRate()`，插值按倍速推进。宽度超过
   屏幕 20% 的弹幕按宽度比例缩短时长（下限 0.3×，另有速度上限）——这是防堵轨，
   不是"密度随屏幕宽度收敛"。

过滤在**加载时**做一次，不在渲染帧里（`VideoPlayer.vue:3941`）：屏蔽词（`,` / `，` /
换行分隔）、纯符号、同文本 1.5 秒内重复，三条都直接丢弃。

预取：`min(片尾标记, 时长) - danmakuPrefetchLead 秒`（默认 180，`PlayView.vue:1346`）
请求下一集；后端立刻返回，抓取在后台，和主请求走同一套链路、幂等；
`policy.danmakuPrefetch` 可关（默认开）。

## 六、渲染参数

| 项 | 字段 | 可选值 |
|---|---|---|
| 开关 | `danmaku` | 开 / 关 |
| 密度 | `danmakuDensity` | 稀疏 18s+55% / 标准 12s+70% / 密集 9s+85% / 自定义（`prefs.ts` 的 `DENSITY_PRESETS`） |
| 字号 | `danmakuScale` | 80% / 100% / 120% / 140% |
| 透明度 | `danmakuOpacity` | 50% / 75% / 90% / 100% |
| 速度 | `danmakuDuration` | 8 / 10 / 12 / 15 / 20 秒 |
| 区域 | `danmakuArea` | 40% / 55% / 70% / 85% / 全屏 |
| 屏蔽词 | `danmakuBlock` | 逗号、中文逗号、换行分隔 |

全部存在 `meow.prefs`（localStorage），由设置页读写；**不在 `policy.json`**。

## 七、改这块之前

| 要改什么 | 先看 |
|---|---|
| 加自动来源 | `danmakuOrder()` 的合法值白名单 + `runDanmakuSource()` + `sourceTagOf()` + 前端 `dmSourceLabel` |
| 调顺序/预算 | `policy.danmakuOrder`、`danmakuFirstScreenMs()`、设置页 `orderFirst` |
| 调同步容差 | `danmaku.ts` 的 `sync()`；容差必须 > 0.4 s 插值超前 |
| 改缓存 | `danmakuStore.ts` 的 2 MB / 300 集 / 30 天 + 后端 `VideoCache.DANMAKU_TTL_MS` 与配额保护 |
| 接自建服务 | `policy.danmakuApi`；[插件系统](./plugin-system.md) 的 inject |

## 相关

- 片库与离线缓存：[片库与离线缓存](./library-cache.md)
- 播放与转码：[播放与转码](./playback.md)
- 用户侧操作：[播放与弹幕](/guide/playback)
