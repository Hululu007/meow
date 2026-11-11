# 播放与转码

播放链路的复杂度集中在两个判断上：**这次失败该换线还是转码**，以及**倍速下要不要降档**。
两者都已经抽成纯函数，可以单测钉死边界。

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

## 二、只有三类值得转码

```ts
export function shouldTranscode(kind: PlayErrorKind): boolean {
  return kind === 'media' || kind === 'src' || kind === 'fake'
}
```

判断依据是**同一集在不同源上的编码基本一样**：

| 错误 | 换线有用吗 | 转码有用吗 | 为什么 |
|---|---|---|---|
| `media` | ❌ | ✅ | 编码/容器问题，换源大概率还是同一个编码 |
| `src` | ❌ | ✅ | 地址给错了，转码不解决根因但能兜住 |
| `fake` | ❌ | ✅ | 分片是图片，只能靠转码后的代理路径绕 |
| `network` / `timeout` / `stall` / `http` | ✅ | ❌ | 源站或网络问题，换线立刻见效 |

::: warning 这个判断救过一次 90 秒的白等
早期实现是「失败先转码」。PC 上 ffmpeg 转码起播要 90 秒，TV 上直接报「找不到 ffmpeg」——
而真实原因只是一次网络抖动。现在网络类错误先换线，转码只在真的编解码不了时才走。
:::

## 三、两级错误展示

播放失败页显示**两个**原因，不要混着看：

| 层级 | 含义 |
|---|---|
| **播放错误** | 真实终止原因（第一次失败的那个） |
| **换线错误** | 换线过程中再次失败的原因 |

如果只有「播放错误」没有「换线错误」，说明还没换过线。

## 四、倍速与 ABR

`client/apps/web/src/components/player/playbackPolicy.ts` 里的四个数值：

```ts
export const ABR_HEADROOM = 0.8              // 码率×倍速 超过带宽 80% 就降档
export const UNDERRUN_BUFFER_SEC = 1.5       // 缓冲垫低于 1.5 s 算见底
export const RATE_RESTORE_OBSERVE_MS = 8_000 // 降速后至少观察 8 s 才恢复
export const RATE_RESTORE_BUFFER_SEC = 20    // 缓冲到 20 s 才恢复倍速
```

`capLevelForRate()` 按 `码率 × 当前倍速 ≤ 带宽 × 0.8` 选最高可用档；一档都不满足时
**落到最低档**（返回 0），而不是保持 `-1`——否则会在高码率档上反复欠载。

恢复路径是滞回的：先降到 1x，缓冲攒到 20 s 且观察满 8 s 才回原倍速。

::: tip 为什么留 20% 余量
代理跳一次、CDN 抖一下都会吃掉带宽。按 100% 估算会在临界点反复横跳，
用户看到的是「一会儿清晰一会儿糊」。
:::

## 五、起播看门狗

| 阶段 | 超时行为 |
|---|---|
| 起播 | 拿不到清单/首帧 → 判 `timeout`，走换线 |
| 播放中 | 时间不推进但 `readyState` 正常 → 续期，不打断 |
| 404 | 分片连续 404 → 判 `http`，走换线 |

看门狗只负责「起不来」，不负责「卡一下」——后者交给缓冲策略，避免误杀正常缓冲。

## 六、续播

- 进度**按集隔离**：换集、换线路后不会从上一集的位置开始
- 位置存在数据目录的 `state-progress.json`，跨端共享（配了通道时）
- 退出再进从上次位置继续
- 连播时下一集地址会在本集播放约 30 秒后预取

## 七、代理与请求头

播放地址默认走客户端代理（`/api/proxy`），只透传 `Referer` 与 `User-Agent`。

后果：源站如果校验 Cookie 或自定义 token，**代理路径会失败，而原生播放器直连能成功**。
「同一地址在别的播放器能播、在我们这报错」时，先怀疑这一点。

配置里 `proxy` 字段列出的 host 会强制走代理；其余直连。

## 八、改这块之前

| 要改什么 | 先看 |
|---|---|
| 加错误类型 | `playError.ts` 的 union + `shouldTranscode()` + 失败页文案 |
| 调 ABR 参数 | `playbackPolicy.ts` 的常量；有单测，改完跑 `pnpm test` |
| 改看门狗超时 | `VideoPlayer.vue` 的起播计时器；注意别把缓冲误判成卡死 |
| 改代理头 | `/api/proxy` 与 `hopError` 两级错误页要一起看 |

## 相关

- 弹幕同步：[弹幕](./danmaku.md)
- 片库直连与转 HLS：[片库与离线缓存](./library-cache.md)
- 用户侧排障：[播放与弹幕](/guide/playback)、[诊断手册](/reference/diagnostics)
