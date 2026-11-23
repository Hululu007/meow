# 播放与转码

播放链路的复杂度集中在两个判断上：**这次失败该换线还是转码**，以及**倍速下要不要降档**。
两者都抽成了纯函数（`playError.ts` / `playbackPolicy.ts`），可以用单测钉死边界。

> 代码引用按**符号名**找（函数名 + 文件）；行号会随改动漂移，引用前先 grep，不要按行号找。

## 一、错误分八类

`client/apps/web/src/components/player/playError.ts`：

```ts
export type PlayErrorKind =
  | 'media'    // 解码/容器不支持（MEDIA_ERROR、video.error 3/4）
  | 'network'  // 清单/分片网络错误（重试耗尽、连接断开）
  | 'timeout'  // 起播看门狗超时（连清单/首帧都没拿到）
  | 'stall'    // 清单能开、分片全部失败（假死）
  | 'http'     // 源站返回 4xx（404/410/403 等）
  | 'fake'     // 源站把分片换成了图片（伪流）
  | 'src'      // 地址本身不是媒体（解析器给错）
  | 'unknown'
```

`VideoPlayer` 的分类：`video.error` 2→`network`、3→`media`、4→`src`
（`VideoPlayer.vue` 的 `MediaError` 映射）；hls.js 只给 detail 字符串，`classifyHlsDetail()`
按关键字猜：4xx→`http`、5xx→`network`，`bufferAppend/bufferStalled/decode/remux`→`media`，
其余→`network`（`VideoPlayer.vue`）。**宁可归 network 去换线，也不要把抖动错归成 media 白等转码**。

## 二、转码只在三类失败时走

只有 `shouldTranscode()` 为真的 `media` / `src` / `fake` 值得转码——**同一集在不同源上的
编码基本一样**，换源大概率还是同一个编码：

| 错误 | 换线有用吗 | 转码有用吗 | 为什么 |
|---|---|---|---|
| `media` | ❌ | ✅ | 编码/容器问题，换源大概率还是同一个编码 |
| `src` | ❌ | ✅ | 地址给错了，转码不解决根因但能兜住 |
| `fake` | ❌ | ✅ | 分片是图片，只能靠转码后的代理路径绕 |
| `network` / `timeout` / `stall` / `http` | ✅ | ❌ | 源站或网络问题，换线立刻见效 |

- 可转码的三类**先转码、只试一次**（`transcodeTried`）；其余先换线，没有未试过的线路才停
  错误页。转码前 `transcodeAvailable()` 探 ffmpeg——TV 网关常没有，文案要给可执行建议。
- **首次响应只代表任务排上**（`state=running`、`playlist` 为空），必须每 2s 轮询 status
  等 `playlist` 出现。URL 转码 90s 超时（`waitTranscode`，`api/library.ts:557`），
  片库转码 600s（`waitLibraryTranscode`，`api/library.ts:513`）。
- **返回里带 `duration`**（源真实总时长）：转码未完成时 `video.duration` 只是已转出时长，
  进度条必须用 `duration`（`api/library.ts` 的 `TranscodeResult.duration`、`VideoPlayer.vue`
  按真实时长优先取值）。
- 产物是增量 HLS，前几个分片就绪即可起播，可边转边看；**源文件不动**。
- 片库没有"线路"概念：失败时传 `lib + path` 让后端自己读文件转码。不能把 `127.0.0.1`
  的流（被 SSRF 防线拒）或 SMB 地址交给 ffmpeg。

### 转码入口的两个硬约束（2026-11-23 咕噜4K 实报）

后端拉流的是**另一个进程**，前端能播不等于 ffmpeg 能拉。两件事必须随请求带上：

1. **源站请求头**：`/api/transcode?src=…&header=…`（`Transcode.ensure(src, false, headerJson)`）。
   点播线路常校验 UA/Referer；ffmpeg 侧转成 `-user_agent` / `-headers`。
   前端在 `PlayView.vue` 的 `tryTranscode()` 里从 `play.value.header` 透传。
2. **伪装扩展名的 HLS**：部分源把 TS 分片写成 `.png`（响应 `image/png`）。ffmpeg 7 起
   `extension_picky` 默认 true 会直接拒；按 major 给 `-extension_picky 0`（≥7）或
   `-allowed_extensions ALL`（≤6）。**参数名互不兼容**，传错会让 ffmpeg 以
   `Option not found` 不启动，所以要版本门控（`addHttpInputOptions`）。

实测（OECT RK3566）：4K HEVC 10-bit → 1080p H.264/AAC，`rkmpp` 硬解硬编 **1.6–1.8 倍速**，
首片约 15 秒，ffmpeg 单进程约 27% CPU / 66MB RSS。

### 播放中卡缓冲：先判"洞"，不要转码（2026-11-23 用户实报）

现象是「同一集某一段很顺、某一段直接不动」，面板里 `lastError=bufferStalledError`。
**不是网络抖动**：抖动是瞬时的，而这是播放点落进了缓冲区空洞或后续分片不再增长。

| 成因 | 判据 | 处理 |
|---|---|---|
| 分片时间戳不连续留下空洞 | `bufferStalledError` + 前后分片都正常 | hls.js 只处理 `maxBufferHole=0.5` 内的空隙；更大要自己跳 |
| 源站 token 中途过期 | 后续分片 403、`frags` 停在某一片 | 4xx 走换线（已有） |
| 转码任务被抢占/空闲取消 | 后端 job `cancelled`、清单停止增长 | 换线或重试；轮询状态能暴露 |
| 解码/性能跟不上 | `currentTime` 不走但 `bufferedAhead` 很大 | 降档/换线路，转码救不了 |

现在播放器有三层自愈：非致命 `bufferStalledError` 主动跳洞（≤10 秒，每源最多 3 次）→
播放进度看门狗（2 秒一次，5 秒不动就先跳洞、再重拉取流两次）→ 报 `stall` 交给换线。
**`bufferStalledError` 绝不能归成 `media`**：那会把已经能播的流送去做一次无意义的转码。

三处补充（2026-11-23）：

- **token 中途过期**：已播过分片后遇 403/401 → 播放器发 `stale-src`，父组件重新调
  `/api/{site}/play` 拿新地址，`seekAt` 回到原位置续播（每源一次，失败落回换线）。
- **事件上报**：`buffer_hole` / `buffer_stall` / `token_stale` 节流上报到
  `POST /api/state/player-events`（JSONL 落盘、2MB 轮转、只存 host 不存 URL）；
  `GET` 同一路径返回 `total / byKind / bySite / recent 20`，用来找"哪个源容易出洞"。
- **跳片尾**：不再把 `currentTime` 拉到 `duration-1`（用户看到的是"先跳最后一秒"），
  直接发 `ended`，最终进度用 `pos=duration` 上报 → 父组件清掉续播点。

### 两台设备抢 4K：拒绝而不是杀掉正在看的

`stopOtherJobs` 的硬件抢占加了保护：30 秒内有分片访问（播放器 5 秒一轮询）的任务
视为"真的在看"，新硬件任务不杀它，直接返回 `hw_busy`。前端文案：
「另一台设备正在转码这部 4K 片源，请稍后再试，或换 1080p / H.264 线路」。
软件任务仍按原规则（不打断正在观看的旧任务）。

## 三、两级错误展示

失败页的**主文案**是播放器/源站原因（没有才用兜底文案），**括号**里是兜底这一跳失败的原因
（转码没起来、代理 502……）。转码失败**不能覆盖主文案**，否则用户看到"找不到 ffmpeg"而
不是真实原因（`PlayView.vue` 的转码兜底）；只有主文案说明还没走到兜底。

## 四、倍速与 ABR

`client/apps/web/src/components/player/playbackPolicy.ts` 里的四个数值：

```ts
export const ABR_HEADROOM = 0.8              // 码率×倍速 超过带宽 80% 就降档
export const UNDERRUN_BUFFER_SEC = 1.5       // 缓冲垫低于 1.5 s 算见底
export const RATE_RESTORE_OBSERVE_MS = 8_000 // 降速后至少观察 8 s 才恢复
export const RATE_RESTORE_BUFFER_SEC = 20    // 缓冲到 20 s 才恢复倍速
```

`capLevelForRate()` 按 `码率 × 当前倍速 ≤ 带宽 × 0.8` 选最高可用档。1x 或没有带宽数据时
返回 `-1`（不限制）；一档都不满足时**落到最低档 0**，而不是保持 `-1`——否则会在高码率档上
反复欠载。hls.js 的 ABR 不知道 `playbackRate`，所以必须手动设 `autoLevelCapping`。
留 20% 余量是因为代理跳一次、CDN 抖一下都会吃掉带宽；按 100% 估算会在临界点反复横跳。

欠载降速：`waiting` 在 20s 窗口内累计 2 次且缓冲垫 ≤1.5s → **临时降到 1x**，HUD 明示
"网络跟不上，已临时恢复 1x"；观察满 8s 且缓冲 ≥20s 后自动回到用户选的倍速，不静默改掉。

## 五、起播与假死看门狗

两只计时器判据完全不同（`armWatchdogs()`，`VideoPlayer.vue`）：

| 计时器 | 预算 | 判据 | 失败类型 |
|---|---|---|---|
| 起播 | 20s；`MANIFEST_PARSED` 后放宽到 35s | `readyState ≥ 2` 或 `currentTime > 0` 视为已起播，不判死 | 有 `lastHlsError` 按它分类，否则 `timeout` |
| 假死 | 12s；每来一个分片续 12s，总时长不超过 `loadStartedAt + 45s` | HLS 看 `fragLoadedCount > 0`；原生看 `readyState ≥ 1` | `stall`（或按 `lastHlsError` 分类） |

- **4xx 快速判死写在 `if (!data.fatal) return` 之前**，且要求 `fragLoadedCount === 0`：
  hls.js 的 404 会退避重试 20 多秒才 fatal；播过片段后的个别 404 可能只是空洞，交给它跳过。
  **403 例外**（Referer/token 过期，换一轮有机会带上新头）。
- `manifestParsingError` 允许**回退一次**原生 `v.src`（可能把单文件猜成了清单），不能反复重建 MediaSource。
- 看门狗只负责"第一帧之前"；播放中的卡顿交给 `waiting` → 降速，接进看门狗会误杀正常缓冲。
- `failPlay()` 必须先撤看门狗再报错，否则 3 秒报错换线后 20 秒定时器到点会再报一次，
  父组件重复换线/转码。

## 六、续播

- 进度存在**历史记录**里（localStorage），按 `site + vod_id` 一条，带 `ep_url`/`ep`；换线路时
  url 变、集名相同仍认作同一集，进度保留（`stores/history.ts`）。
- 本地门禁：`pos > 5`，且已知时长时不在结尾 10 秒内（`PlayView.vue` 的 `applyResume`）。源站 `position`
  也参与，和本地进度取**较大者**（提示"继续播放"/"开始播放"）；提示条 8 秒，可清进度重看。
- 跨端：`capabilities` 含 `state` 时才推 `/api/state/progress`，且必须带 `ep_at`（缺省会被
  后端按当前时间打戳，压掉别处更新的进度；`api/index.ts` 的 `pushStateProgress`）；WebDAV 另走
  `{dir}/history.json`（`stores/sync.ts`）。
- **刷新/重试续播**（1.2.16 起）：顶部 ⟳ 刷新与错误页「重试」都走 `reloadSrc()`，它记住刷新前
  位置（`resumeAfterReload`），第二次 loaded 时自行 seek 回位（父组件的 `applyResume` 有一次性
  守卫，只覆盖首次 loaded）；只有「重播」才从头。
- 下集地址在本集播放 30 秒后预取，取走即删、TTL 10 分钟（源站直链带时效签名）。

## 七、代理与请求头

- 外部 `http(s)` 地址在 `playableSrc` 里统一包 `/api/proxy/stream`（`PlayView.vue` 的 `playableSrc`）。
- `proxyStream()` 把 `Referer`/`User-Agent` 拆成独立参数，其余头（Cookie、Origin、token）
  序列化进 `headers`，后端按白名单过滤。**只透传 Referer/UA 会让"原生能播、Web 永久 403"**。
- 自家的 `/api/...`（缓存清单、转码产物）和片库直链**不能再包一层代理**：相对分片会按
  代理地址解析，必然 404。前端没有"按 host 决定是否代理"的逻辑，是否真代理由后端决定。
- 跨源 `<track>` 不能直接吃代理地址（会要求 `<video crossorigin>`），字幕须转成 VTT 后用
  `blob:` URL 喂给播放器。

## 八、改这块之前

- 加错误类型：`playError.ts` union + `VideoPlayer` 的错误映射 + `PlayView` 兜底顺序；
  边界钉在 `player-error-kind.test.ts`。
- 调 ABR/降速：`playbackPolicy.ts` 常量，边界钉在 `playback-policy.test.ts`。
- 改看门狗：`armWatchdogs()` / `extend*()`；别把播放中的缓冲算进去
  （`player-stall-watchdog.test.ts`、`player-watchdog-and-line-hint.test.ts`）。
- 改代理头：`proxyStream()`、后端白名单、`hopError` 文案要一起看。
  以上改完跑 `npx vitest run`。

## 相关

- 弹幕同步：[弹幕](./danmaku.md)
- 片库直连与转 HLS：[片库与离线缓存](./library-cache.md)
- 用户侧排障：[播放与弹幕](/guide/playback)
