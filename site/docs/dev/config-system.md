# 配置系统

一份 `config.json` 从导入到「某个站点能被搜索」，中间经过四步：**解析 → 落盘 → 加载 jar → 分派站点**。
这一页把这条链路的每一段说清楚，改源类型或加载逻辑时按图索骥。

## 一、链路总览

```
用户导入（URL / 文件 / 粘贴）
      ↓  POST /api/config/import
解析 + 探测 + 预览
      ↓  确认后落盘
data/config.sites.json          ← 站点表、parses、lives、rules…
      ↓  启动 / 导入后触发
Jars.prepare()                  ← 读 spider / spiderJvm，下载 + md5 校验 + 缓存
      ↓
Bridge.installClassLoaderIfAbsent()   ← 装 URLClassLoader（JVM）或 DexClassLoader（TV）
      ↓
站点分派（csp_ → jar / .js → drpy / CMS → 直连）
```

## 二、导入：三种模式与三个开关

`POST /api/config/import` 的请求体：

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `replace` / `merge` | **`replace`** | 整表替换，或追加 |
| `onConflict` | `keep` / `replace` / `both` | `keep` | merge 时同名 key 怎么处理 |
| `replaceSpider` | 布尔 | `false` | 用导入配置的顶层 `spider` 覆盖本地 |

::: warning 接口默认是 replace
前端下拉默认选的是「追加」，但**接口不传 `mode` 时按 `replace` 处理**。
脚本调用必须显式写 `mode`，否则会清空现有站点。
:::

`replaceSpider` 是迁移专用：旧安装的 `spider` 指向已失效的 jar，不勾选就继续用旧地址，
表现为「站点全红 + ClassNotFound」。

导入流程本身分两段：**探测**（拿配置、解析站点数、检测可用性）和**确认**（写入）。
预览阶段不落盘。

## 三、落盘：数据目录

```
data/
  config.sites.json     站点表（核心）
  policy.json           用户策略（弹幕 API、DNS、代理…）
  state-*.json          收藏 / 进度
  cache/                转码与 TTL 缓存（可丢）
  jar/                  spider jar 缓存
  posters/              刮削封面
```

数据根目录的解析优先级（`server/host/src/shared/core/DataPaths.java`）：

```
-Dmeow.data  >  MEOW_DATA  >  --data-dir=...  >  ./data
```

四端实际位置见 [数据与状态](./data-state.md)。

## 四、jar 加载：`spider` 与 `spiderJvm`

配置里的两个字段：

```json
{
  "spider": "https://example.com/spider-dex.jar;md5;<hex>",
  "spiderJvm": "https://example.com/spider-class.jar;md5;<hex>"
}
```

读取顺序（`core/Jars.java`）：

1. `spiderJvm` 非空 → 用它（JVM 端）
2. 否则回退 `spider`

TV 端只读 `spider`，Fongmi 也一样——它们不认 `spiderJvm`。

### 加载时做了什么

| 步骤 | 行为 |
|---|---|
| 下载 | 按 URL 拉取；已有同 md5 缓存则跳过 |
| 校验 | md5 不匹配 → **拒绝加载**（不会用半截文件启动） |
| 缓存 | 落在 `data/jar/` |
| 装载 | JVM：`URLClassLoader`；TV：`DexClassLoader` |

### ClassLoader 只装一次

`Bridge.installClassLoaderIfAbsent()` 名字里的 `IfAbsent` 是关键：**已经装过就不再覆盖**。
TV 端有 DexClassLoader 钩子，重复安装会把钩子顶掉，导致 jar 站全部失效。

## 五、站点分派：三种形态

配置里每个站点的 `api` 决定走哪条路：

| `api` 形态 | 走哪 | 实现位置 |
|---|---|---|
| `csp_XXX` | spider jar（反射 `crawler.Spider`） | 后端 `call()` 的 jar 分支 |
| 以 `.js` 结尾 | drpy 运行时（Node） | 转发到 `policy.json` 的 `jsRuntime` |
| `http(s)://...` 且 `type: 1` | 苹果 CMS 直连 | `CmsSource` |
| 空 / 原生源 | 内置实现（如豆瓣） | `NativeSources` |

分派顺序是**原生源 → CMS → drpy → jar**，前一个能处理就不看后面的。

::: tip 为什么原生源排最前
公开壳没有内置 jar，如果原生源排在 jar 后面，没有 jar 时整个后端会被判成「不可用」。
原生源存在的意义就是「没 jar 也能出内容」。
:::

## 六、站点级 `jar`（TV 专用）

TV 端逐个站点构造 `DexClassLoader`，所以**每个 `csp_` 站点要有 `jar` 字段**（或顶层 `spider` 可用）。
JVM 端则优先用顶层字段，站点级 `jar` 可选。

这也是一份配置能同时给两端用的前提：顶层给 TV，`spiderJvm` 给 JVM，站点级 `jar` 只在需要多 jar 时写。

## 七、多仓与探测

导入 `{"urls": [...]}` 形式的多仓索引时：

1. 逐个拉取子仓
2. 单个仓失败 → 跳过，不阻断其他仓
3. 全部失败 → 报错并保留原有配置

探测结果会写进 `site-health.json`，站点管理页的「可用 / 不可用」来自这里。

## 八、改这块之前

| 要改什么 | 先看 |
|---|---|
| 加一种源类型 | `call()` 的分派顺序 + `CmsSource` / drpy 转发 + 前端站点形态判断 |
| 改导入语义 | `ApiServer` 的 import 处理 + 前端设置页三处文案（模式/冲突/jar 覆盖） |
| 改 jar 加载 | `Jars.java` + `Bridge.installClassLoaderIfAbsent`（别改成无条件覆盖） |
| 改数据目录 | `DataPaths` 的优先级链，四端启动参数都要跟着改 |

## 相关

- 字段逐个说明：[源包与配置格式](/ecosystem/source-format)
- 导入操作：[导入源包](/guide/source-pack)
- 插件与 jar 的关系：[插件系统](./plugin-system.md)
- TV 端消费路径：[TV 接入](./tv-integration.md)
