# 播放与转码

播放链路的复杂度集中在两个判断上：**这次失败该换线还是转码**，以及**倍速下要不要降档**。
两者都抽成了纯函数（`playError.ts` / `playbackPolicy.ts`），可以用单测钉死边界。

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

`VideoPlayer` 的分类：`video.error` 2→`network`、3→`media`、4→`src`（`VideoPlayer.vue:4284`）；
hls.js 只给 detail 字符串，`classifyHlsDetail()` 按关键字猜：4xx→`http`、5xx→`network`，
`bufferAppend/bufferStalled/decode/remux`→`media`，其余→`network`
（`VideoPlayer.vue:1421`）。**宁可归 network 去换线，也不要把抖动错归成 media 白等转码**。

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
  等 `playlist` 出现。URL 转码 90s 超时，片库转码 180s（`api/library.ts:481`、`:444`）。
- 产物是增量 HLS，前几个分片就绪即可起播，可边转边看；**源文件不动**。
- 片库没有"线路"概念：失败时传 `lib + path` 让后端自己读文件转码。不能把 `127.0.0.1`
  的流（被 SSRF 防线拒）或 SMB 地址交给 ffmpeg。

## 三、两级错误展示

失败页的**主文案**是播放器/源站原因（没有才用兜底文案），**括号**里是兜底这一跳失败的原因
（转码没起来、代理 502……）。转码失败**不能覆盖主文案**，否则用户看到"找不到 ffmpeg"而
不是真实原因（`PlayView.vue:795`）；只有主文案说明还没走到兜底。

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

两只计时器判据完全不同（`armWatchdogs()`，`VideoPlayer.vue:1029`）：

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
  url 变、集名相同仍认作同一集，进度保留（`history.ts:221`）。
- 本地门禁：`pos > 5`，且已知时长时不在结尾 10 秒内（`PlayView.vue:1505`）。源站 `position`
  也参与，和本地进度取**较大者**（提示"继续播放"/"开始播放"）；提示条 8 秒，可清进度重看。
- 跨端：`capabilities` 含 `state` 时才推 `/api/state/progress`，且必须带 `ep_at`（缺省会被
  后端按当前时间打戳，压掉别处更新的进度；`api/index.ts:894`）；WebDAV 另走
  `{dir}/history.json`（`sync.ts:185`）。
- 下集地址在本集播放 30 秒后预取，取走即删、TTL 10 分钟（源站直链带时效签名）。

## 七、代理与请求头

- 外部 `http(s)` 地址在 `playableSrc` 里统一包 `/api/proxy/stream`（`PlayView.vue:292`）。
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
