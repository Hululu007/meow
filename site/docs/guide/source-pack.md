# 导入源包

装完客户端只是空壳。**源包决定你能搜到什么、能播什么**，这一步绕不过去。

::: tip 最省事：不用自己准备源包
跑社区维护的源服务镜像，一条命令就有一份现成的源（自带 41 站 + Jable）：

```bash
docker run -d --name meow-sources -p 18080:8080 \
  -e MEOW_SOURCES_BASE=http://<局域网IP>:18080 \
  chrplus/meow-sources:1.2.0
```

各端「配置地址」填 `http://<宿主局域网IP>:18080/config.all.json` 即可。
参数细节与三个常见坑见下方 [现成的源服务镜像](#现成的源服务镜像)。
:::

## 源包里有什么

规范源包只有一个入口：

```
源包/
├── config.all.json    站点清单：有哪些站、每个站怎么加载、解析表、直播表
├── source-pack.json   机器可读清单（entry / 产物 / hash）
└── spider-dex.jar     爬虫实现：ZIP 内含 classes.dex
```

`config.all.json` 的顶层 `spider` 指向 dex jar。源包以 **CatVod dex 为主**：
Fongmi、TVBox、猫窝 TV 直接加载它；猫窝 JVM 在导入时用 `Dex2Jvm` 把 dex
转成 class 并缓存，不需要源包准备两套 jar。

::: tip 仓库不提供源包
公开库与公开 Release 都不含 spider jar、真实站点配置或第三方令牌。
源包由你从自己信任的渠道获取，放在私有 Release、NAS 或对象存储上都行。
规则与校验脚本见仓库 `deploy/source-pack/`。
:::

## 一份配置通吃三端

| 端 | 读取 | 加载 |
|---|---|---|
| Fongmi / TVBox | 顶层 `spider` + 可选站点 `jar` | `DexClassLoader` |
| 猫窝 TV | 同上；站点不写 `jar` 时回退顶层 `spider` | `DexClassLoader` |
| 猫窝 JVM | 优先 `spiderJvm`；没有则 `spider` | `URLClassLoader`，dex 由 `Dex2Jvm` 转换 |

```json
{
  "spider": "https://example.com/spider-dex.jar;md5;<32位>",
  "sites": [
    { "key": "示例", "name": "示例", "type": 3, "api": "csp_Example" }
  ]
}
```

- **顶层 `spider` 必须是 dex**：Fongmi 会按顶层字段 `DexClassLoader`，指向 class
  jar 会直接加载失败。
- **站点不写 `jar`**：由顶层统一提供。只有站点确实需要另一个 dex jar 时才写站点级
  `jar`，同样必须是 dex。
- **`spiderJvm` 是可选字段**：class jar，只给 JVM 做冷导入优化/旧版兼容；
  Fongmi/TV 会忽略。新源包不需要它，JVM 走 dex2jvm 即可。
- 旧版猫窝不认 `spiderJvm`/dex2jvm 时，才需要单独的 `config.jvm.json`
  （顶层 `spider` 直接指向 class jar）。

## `spider` 字段的 `;md5;` 语义

```json
"spider": "https://example.com/spider.jar;md5;d41d8cd98f00b204e9800998ecf8427e"
```

- 分号后是**这个 jar 文件本身**的 MD5（32 位小写 hex）
- 缓存里已有同 MD5 的 jar 就直接复用，不重复下载
- 下载后 MD5 不匹配**拒绝加载**，不会用半截文件启动
- **规范要求 jar URL 必须带 `;md5;`**（或用版本化文件名）。不写虽然可能跑起来，
  但换 jar 后客户端会继续用旧缓存，Fongmi/TV/JVM 都一样。

## 导入步骤

### Web / PC

设置 →「搜索与源」→「配置源」→ 填地址 → 点「读取」。

读到结果后卡片里才出现「导入方式 / 同名站点 / jar 地址」——先看清这个配置有多少站、会新增多少、哪些会冲突，再决定怎么并，最后点「确认导入」。按钮上会写清这次按哪个策略执行（例如「确认导入（追加 · 两个都要）」）。

没有「上传文件」入口：本地文件请先放到一个电视/电脑能访问的 http 地址（局域网静态服务、对象存储都行），再填它的 URL。

![设置页的「搜索与源」区块：配置地址、读取结果、追加/替换、同名站点处理与 jar 地址覆盖](/screenshots/settings-source.png)

*读完才弹出导入选项；它们决定最终写入的结果*

| 选项 | 说明 | 什么时候用 |
|---|---|---|
| **追加**（merge） | 保留现有站点，只把新的并进来 | 日常增量导入、加一个仓 |
| **替换**（replace） | 整表换掉，现有站点全部消失 | 换源包、首次导入 |
| 同名站点：保留现有的 / 用导入的覆盖 / 两个都要 | merge 时同一个 key 但 api 不同怎么处理 | 多仓里有重名站 |
| **用这份配置的顶层 spider 覆盖本地** | 写入配置里的 jar 地址 | 迁移到新源包时勾选 |

::: danger 这个勾选框平时不要勾
「用这份配置的顶层 spider 覆盖本地」会冲掉你手改过的 jar 地址。
只有从全量版迁移、或明确想换源包时才勾。
:::

导入前会先预览（站点数、新增/更新/冲突），确认后才落盘；覆盖导入会留一份备份，
可以撤销一次。

### TV

设置 →「本机执行」→「配置地址」→ 填入 `config.all.json` 的 URL → **点「导入到本机」**（只填不点不会导入）。

TV 端额外注意：

- `csp_` 站点可以用站点级 `jar`，也可以只靠顶层 `spider`；两种都必须是 dex
- 本机执行只导入 `csp_` + jar 的站点；drpy `.js` 与 CMS 直连站不进来（它们要走后端）
- 端上会维护一份自己的站点表；通过扫码从 Web/PC 推送配置时，两份表会同步
- 配置地址可以是局域网地址，但电视必须能访问到那台机器
- TV 首启会自动装几个内置兜底站——**看到站点不等于你的源包导入成功**，核对站点数

## 可以导入的源形态

| 形态 | 长什么样 | 加载方式 |
|---|---|---|
| CatVod spider jar（`csp_*`） | 站点 `api` 为 `csp_XXX` | JVM `Class.forName` / TV `DexClassLoader` |
| drpy `.js` | 站点 `api` 以 `.js` 结尾 | `drpy` 插件里的 Node 运行时 |
| 苹果CMS 直连 | 站点 `type: 1`，`api` 是 CMS 接口 | 按 CMS 协议直接拉 |
| 多仓索引 | `{"urls": ["https://.../config.json"]}` | 导入时逐个探测可用性 |
| CatVod 出口配置 | 标准 `/config.all.json` 九字段 | 可导入站点 / 直播 / 解析表 |

jar 的**内部形态**决定三端能不能用——同一份配置，端不同结果不同：

| jar 形态 | 猫窝 TV / Fongmi | 猫窝 Web / PC / Docker |
|---|---|---|
| dex jar（ZIP 内含 `classes.dex`） | ✅ 直接加载 | ✅ 支持，导入期 Dex2Jvm 转 class |
| class jar（只有 `.class`） | ❌ 加载失败 | ✅ 原生加载 |
| 加固 jar（含 native `.so`） | ✅ 原生库随设备架构 | ❌ 转不出来，对应站点不可用 |

::: tip 社区聚合配置先看 jar 形态
饭太硬、肥猫、qist 这类社区配置大多是 TVBox 老格式。**三端对 dex jar 都可用**：
TV / Fongmi 直接加载；Web / PC / Docker（JVM 运行时）1.1.7 起在导入期经
Dex2Jvm 自动转 class。唯一例外是含 native `.so` 的加固 jar——TV 能用，
JVM 端对应站点转不出来。导完对照「导入后自检」核对站点数与实际可用数。
:::

## 导入后自检

1. **站点列表**：设置里看站点数与「带 ext」的数量，正常应该和源包声称的一致。
2. **搜索一个常见片名**：能出结果说明至少有一个站活着。
3. **点进详情**：能看到线路与集数说明播放源解析成功。
4. **播一集**：`readyState` 到 4、时间在走、有画面。

哪一步断了，对照 [常见问题](/guide/faq)。

## 源包放在哪

| 方式 | 适合 | 注意 |
|---|---|---|
| 私有 Release | 少量更新、带版本 | 下载需要 token，客户端默认不带 Authorization |
| NAS / 静态服务 | 家里多设备共用 | 电视要能访问；建议同目录放配置与 jar |
| **Docker 源服务** | 一条命令起自带 41 站 + Jable，全家共用 | 见下方「现成的源服务镜像」 |
| 对象存储 | 公网分发、只读 | 配置公开可读即可，jar 可加随机路径 |
| 本机文件服务器 | 调试 | 手机/电视换成局域网 IP，不要用 `127.0.0.1` |

配置里所有地址都会**原样**发给客户端，`127.0.0.1` 指的是客户端自己，
不是你的电脑——这是「配置在电脑上能导入、电视上全红」的头号原因。

### 现成的源服务镜像

不想自己摆文件，可以直接跑社区维护的源服务镜像——镜像里已带主爬虫、Jable 扩展和 41 站默认源，
**不挂载任何文件就能导入**：

```bash
docker run -d --name meow-sources -p 18080:8080 \
  -e MEOW_SOURCES_BASE=http://<局域网IP>:18080 \
  chrplus/meow-sources:1.2.0
```

- 各端配置地址填 `http://<宿主局域网IP>:18080/config.all.json`
- `MEOW_SOURCES_BASE` 是镜像生成 jar 下载地址用的，**必须填客户端能访问的地址**；
  默认的 `127.0.0.1` 只在「导入方和源服务在同一台机器」时成立——Docker 主栈的
  apiserver 去拉 jar 时它指向容器自己，表现为「站点导进来但 jar 下载失败」
- 起容器**不会自动导入**，仍要到设置页填一次上面的地址
- 想用自己的源包：把目录挂到 `/mounted-sources`，整目录覆盖镜像自带的源

部署细节（compose 四形态、变量全表）见 [Docker 部署](/dev/docker)；
目录与字段规范、校验脚本见 [配置格式](/ecosystem/source-format) 与仓库 `deploy/source-pack/`。
