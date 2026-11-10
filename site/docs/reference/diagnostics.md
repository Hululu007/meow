# 诊断手册

[常见问题](/guide/faq) 是按症状查的，这一页是按**证据**查的：日志在哪、健康接口怎么看、错误类型分别意味着什么。

## 第一步：确认后端活着

```bash
# Web / 远程后端
curl -s http://127.0.0.1:30011/api/health | jq

# PC 后端（端口可能顺延）
curl -s http://127.0.0.1:9979/api/health
```

返回示例：

```json
{
  "ok": true,
  "version": "1.1.6",
  "sites": 56,
  "ext": 12,
  "spiderJar": true,
  "configLoaded": true,
  "nativeSources": 1,
  "capabilities": ["danmaku", "search", "proxy", "webdav", "dns", "state", "parse"],
  "danmakuApi": "builtin"
}
```

| 字段 | 怎么看 |
|---|---|
| `ok` | 服务活着 **且**（spider jar 已加载 **或** 有原生源）**且** 站点表非空 |
| `sites` | 站点总数；比预期少说明导入不全 |
| `ext` | 带 `ext` 的站点数；jar 站能否工作的关键 |
| `spiderJar` | 公开壳正常是 `false`，导入源包后应为 `true` |
| `configLoaded` | 配置是否加载 |
| `nativeSources` | 原生源数量（豆瓣等），没有 jar 也能靠它出内容 |
| `danmakuApi` | `builtin` 表示只用内置直连，`configured` 表示接了外部弹幕服务 |
| `capabilities` | 前端据此显示/隐藏功能；缺 `webdav` 说明后端不支持片库 |

::: tip `ok:false` 不等于进程没起来
后端活着但没配置时 `ok` 也是 `false`。区分方法：`version` 有值说明进程在，
`sites:0` 说明只是没导入配置。
:::

## 日志在哪

| 端 | 怎么拿 |
|---|---|
| **Web / Docker** | `docker compose logs -f apiserver`（加 `--tail 200`） |
| **PC** | 插件详情里的日志；或 `%APPDATA%\com.meow.player\` 下的日志文件 |
| **TV** | 设置 → 远程调试；或 `adb logcat -s Meow:*` |
| **fnOS** | 应用中心 → 猫窝 → 日志 |

日志是 2000 条环形缓冲，重启就清空。**出问题后尽快取**。

## 播放错误分八类

客户端会把播放失败归类，不同类的处理方式完全不同：

| 类型 | 含义 | 该做什么 |
|---|---|---|
| `media` | 解码/容器不支持 | **转码**或换画质，换线没用 |
| `src` | 地址本身不是媒体（解析器给错） | 换解析器或换源 |
| `fake` | 源站把分片换成了图片（伪流） | 换源 |
| `network` | 清单/分片网络错误、重试耗尽 | **换线** |
| `timeout` | 起播看门狗超时（连清单都没拿到） | 换线 |
| `stall` | 清单能开、分片全失败（假死） | 换线 |
| `http` | 源站 4xx（403/404/410） | 换线 |
| `unknown` | 未归类 | 看日志 |

判断逻辑写死了：**只有 `media` / `src` / `fake` 才值得转码**，其余先换线。
否则一次网络抖动会白等 90 秒转码。

播放失败页会显示两级原因：

- **播放错误**：真实终止原因
- **换线错误**：换线过程中失败的原因

两者不要混着看。

## 站点健康

设置 → 站点管理里有每个站点的状态。三个值：

| 状态 | 含义 |
|---|---|
| 可用 | 最近一次探测通过 |
| 不可用 | 探测失败（域名挂了 / 需要代理 / 解析器不对） |
| 停用 | 手动关掉，不参与搜索 |

批量排查顺序：先看 `ok`，再看站点健康，最后才看单个片。

## 自查命令

```bash
# 端口谁在听
netstat -ano | findstr :9979      # Windows
ss -lntp | grep 9979              # Linux

# 容器网络是否互通（web 能不能解析到 apiserver）
docker compose exec web getent hosts apiserver
docker compose exec apiserver curl -s localhost:9979/api/health

# 源包 jar 是否可下载
curl -I "<spider 里的地址去掉 ;md5;>"
```

## 提 Issue 要带什么

按价值排序：

1. **版本号与端**（设置页底部）
2. **`/api/health` 的完整返回**（脱敏后）
3. **复现步骤**：从哪个页面、点了什么
4. **错误类型**（`media` / `network` / …）与错误原文
5. **日志片段**：`error` 级别的 10–30 行
6. 源包形态（jar / drpy / CMS），**不要贴真实域名与 token**

::: warning 不要上传源包
源包可能涉及第三方授权，贴出来既帮不上排查，也有合规风险。
报错文本 + 结构信息就够了。
:::

## 相关

- 按症状排查：[常见问题](/guide/faq)
- 边界与已知缺陷：[已知限制](/reference/limits)
- 后端接口与错误码：开发文档 [接口契约](/dev/api-contract)
