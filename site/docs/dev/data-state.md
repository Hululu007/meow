# 数据与状态

用户的收藏、进度、站点配置、策略都存在本地数据目录。项目没有账号体系，**这些数据不会上传到任何服务器**。
这一页说明每份文件归谁管、能删不能删、跨端怎么同步。

## 一、数据根目录怎么定

`server/host/src/shared/core/DataPaths.java` 的优先级链：

```
-Dmeow.data  >  MEOW_DATA  >  --data-dir=...  >  ./data
```

四端的实际位置：

| 端 | 路径 | 说明 |
|---|---|---|
| Web / Docker | 容器内 `/data`，宿主挂 `deploy/docker/../../data` | `MEOW_DATA=/data` |
| PC | `%APPDATA%\com.meow.player\data` | 插件启动参数 `--data-dir` |
| TV | 应用私有目录 | 端内网关读写 |
| 飞牛 fnOS | 应用的 `var/data` | 升级不覆盖 |

::: danger 相对路径是历史坑
早期用 `new File("policy.json")`，工作目录一变配置就丢——Docker 里会写到 `/` 下，容器重建即消失。
现在统一走 `DataPaths`，**新增文件必须用它，不要自己拼路径**。
:::

## 二、目录里有什么

| 文件 / 目录 | 内容 | 丢了会怎样 | 能删吗 |
|---|---|---|---|
| `config.sites.json` | 站点表、parses、lives、rules、spider | 要重新导入源包 | ❌ |
| `policy.json` | 用户策略（见下） | 弹幕地址、DNS、代理设置丢失 | ❌ |
| `state-favorites.json` | 收藏 | **不可恢复** | ❌ |
| `state-progress.json` | 观看进度 | **不可恢复** | ❌ |
| `site-health.json` | 站点探测结果 | 重新探测即可 | ✅ |
| `cache/` | 转码分片、TTL 缓存 | 重新生成 | ✅ |
| `posters/` | 刮削封面 | 重新刮 | ✅ |
| `danmu/` | 弹幕缓存 | 重新拉 | ✅ |
| `jar/` | spider jar 缓存 | 重新下载 | ✅ |

备份策略见 [备份与恢复](/guide/backup)。

## 三、`policy.json` 的字段

用户可在设置页改的运行时策略，全部落在这一个文件里：

| 字段 | 作用 | 谁写 |
|---|---|---|
| `danmakuApi` | 外部弹幕服务地址 | 插件 `inject` 或用户手填 |
| `danmakuOrder` | 弹幕来源顺序 | 设置页 |
| `jsRuntime` | drpy 运行时地址 | drpy 插件 `inject` |
| `searchNoise` / `searchNoiseMode` | 搜索屏蔽词与处理方式（`filter` / `rank`） | 设置页 |
| `proxy` | 强制走代理的 host 列表（可来自配置） | 配置导入 |
| `dns` / `doh` | 安全 DNS | 设置页 |
| `authToken` | 写操作令牌 | 环境变量注入 |
| `llmRelay` | 模型转发开关（Web/TV 用） | 设置页同步 |

::: warning `inject` 不覆盖手填值
插件启动后会把地址写进 `policy.json` 的对应键，但**目标键已有非空值且不等于本插件地址时会跳过**。
所以「装了弹幕插件却还在用旧地址」时，先看 `policy.json` 里是不是被手填值占着。
:::

## 四、跨端通道

收藏 / 进度 / 历史 / 偏好有三条独立通道：

| 通道 | 机制 | 是否实时 |
|---|---|---|
| **后端数据目录** | 端内直接读写同一个 `state-*.json` | 实时（同一后端时） |
| **WebDAV 同步** | 快照上传 / 下载 | 手动或按计划 |
| **端内本地存储** | 前端 localStorage / IndexedDB | 实时（单端） |

三条通道**互不阻塞**：后端有就试，没有就跳过；WebDAV 配了才用。

::: tip WebDAV 是快照不是增量
它按整份快照覆盖，多端同时改会互相覆盖；也只同步状态，不同步片库文件与离线缓存。
重要数据额外留本地备份。
:::

## 五、状态写入的时机

| 数据 | 写入时机 | 注意 |
|---|---|---|
| 播放进度 | 每 5 秒 + 暂停/切集/退出时 | 按集隔离，换集不串 |
| 收藏 | 用户操作时立即 | — |
| 历史 | 播放开始后 | 去重按 `site/vodId` |
| 观看统计 | 随进度累加增量 | 换集从 0 重计 |

进度写入是「增量」的：前端上报累计秒数，后端按差值累加，避免重复计入。

## 六、什么能安全删除

```bash
# 可以随时删，会自动重建
rm -rf data/cache data/posters data/danmu data/jar
rm -f data/site-health.json

# 不能删（删了要重新导入 / 数据永久丢失）
# data/config.sites.json
# data/policy.json
# data/state-favorites.json
# data/state-progress.json
```

设置页的「数据维护」提供的清理项对应上面第一组。

## 七、改这块之前

| 要改什么 | 先看 |
|---|---|
| 新增一个状态文件 | `DataPaths`（不要自己拼路径）+ 备份说明页 |
| 改进度写入频率 | 前端上报 + 后端增量累加两处要一起改，否则会重复计 |
| 加跨端字段 | 三条通道都要考虑：后端目录、WebDAV 快照、localStorage |
| 改 `policy.json` 键名 | 插件 `inject` 的 `key`、设置页、后端读取三方同步 |

## 相关

- 备份与恢复：[备份与恢复](/guide/backup)
- 数据目录结构（代码）：`server/host/src/shared/core/DataPaths.java`
- 跨端同步的用户说明：[播放与弹幕](/guide/playback)
