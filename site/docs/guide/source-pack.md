# 导入源包

装完客户端只是空壳。**源包决定你能搜到什么、能播什么**，这一步绕不过去。

## 源包里有什么

一个源包通常包含两样东西：

```
源包/
├── config.json     站点清单：有哪些站、每个站怎么加载、解析表、直播表
└── spider.jar      爬虫实现（class 形态给 JVM，dex 形态给 TV）
```

`config.json` 的顶层 `spider` 指向 jar。部分源会把直播表、解析表拆成单独文件，
或者用一个多仓索引把多个单仓串起来。

::: tip 仓库不提供源包
公开库与公开 Release 都不含 spider jar、真实站点配置或第三方令牌。
源包由你从自己信任的渠道获取，放在私有 Release、NAS 或对象存储上都行。
:::

## 三端要的格式不一样

这是最容易踩的坑：**同一个 `config.json`，JVM 端和 TV 端要的 jar 形态不同**。

| 端 | jar 形态 | 判断依据 | 谁加载 |
|---|---|---|---|
| Web / PC（JVM） | **class 形态**：jar 里是 `.class` | 顶层 `spider` 或 `spiderJvm` | `URLClassLoader` / `Class.forName` |
| TV（Android） | **dex 形态**：ZIP 内含 `classes.dex` | 每个 `csp_` 站点的 `jar` 字段 | `DexClassLoader` |

把 dex 形态塞给 JVM 会报 `NoClassDefFoundError`，把 class 形态塞给 TV 会
`ClassNotFoundException`，两者不通用。

### 一份配置通吃三端：`spiderJvm`

从 1.1.6 起，猫窝认一个自定义字段 `spiderJvm`：

```json
{
  "spider": "https://example.com/spider-dex.jar;md5;<32位>",
  "spiderJvm": "https://example.com/spider-class.jar;md5;<32位>",
  "sites": [ ... ]
}
```

- **JVM 端优先读 `spiderJvm`**，没有才回退到 `spider`
- **TV / Fongmi 只读 `spider`**（`spiderJvm` 是未知字段，直接忽略）
- 站点条目里**不写** `jar`，由顶层字段统一决定

于是同一份 `config.all.json` 可以同时给 Web、PC、TV 和 Fongmi 用。
旧版猫窝不认 `spiderJvm`，仍然需要单独的 `config.jvm.json`（顶层 `spider` 直接指向 class jar）。

::: warning 顺序别搞反
统一配置里顶层 `spider` 必须是 **dex**：Fongmi 会先按顶层字段 `DexClassLoader`，
指向 class jar 会直接加载失败，而它不会回退到 `spiderJvm`。
:::

## `spider` 字段的 `;md5;` 语义

```json
"spider": "https://example.com/spider.jar;md5;d41d8cd98f00b204e9800998ecf8427e"
```

- 分号后是**这个 jar 文件本身**的 MD5（32 位小写 hex）
- 缓存里已有同 MD5 的 jar 就直接复用，不重复下载
- 下载后 MD5 不匹配**拒绝加载**，不会用半截文件启动
- 不写 `;md5;` 也能跑，但每次启动都会重新探测，且无法判断是否需要更新

## 导入步骤

### Web / PC

设置 →「配置源」→ 填地址或上传。

| 选项 | 说明 | 什么时候用 |
|---|---|---|
| **追加**（merge） | 保留现有站点，只把新的并进来 | 日常增量导入、加一个仓 |
| **替换**（replace） | 整表换掉，现有站点全部消失 | 换源包、首次导入 |
| 同名站点：保留现有 / 用导入的 / 两个都留 | merge 时同一个 key 但 api 不同怎么处理 | 多仓里有重名站 |
| **用这份配置的顶层 spider 覆盖本地** | 写入配置里的 jar 地址 | 迁移到新源包时勾选 |

::: danger 这个勾选框平时不要勾
「用这份配置的顶层 spider 覆盖本地」会冲掉你手改过的 jar 地址。
只有从全量版迁移、或明确想换源包时才勾。
:::

导入前会先预览（站点数、新增/更新/冲突），确认后才落盘；覆盖导入会留一份备份，
可以撤销一次。

### TV

设置 →「本机执行」→「配置地址」→ 填入 `config.json` 的 URL。

TV 端额外注意：

- 只导入带 `jar` 字段或顶层 `spider` 可用的 `csp_` 站点，其他形态会被跳过
- 端上会维护一份自己的站点表；通过扫码从 Web/PC 推送配置时，两份表会同步
- 配置地址可以是局域网地址，但电视必须能访问到那台机器

## 可以导入的源形态

| 形态 | 长什么样 | 加载方式 |
|---|---|---|
| CatVod spider jar（`csp_*`） | 站点 `api` 为 `csp_XXX` | JVM `Class.forName` / TV `DexClassLoader` |
| drpy `.js` | 站点 `api` 以 `.js` 结尾 | `drpy` 插件里的 Node 运行时 |
| 苹果CMS 直连 | 站点 `type: 1`，`api` 是 CMS 接口 | 按 CMS 协议直接拉 |
| 多仓索引 | `{"urls": ["https://.../config.json"]}` | 导入时逐个探测可用性 |
| CatVod 出口配置 | 标准 `/config.json` 九字段 | 可导入站点 / 直播 / 解析表 |

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
| 对象存储 | 公网分发、只读 | 配置公开可读即可，jar 可加随机路径 |
| 本机文件服务器 | 调试 | 手机/电视换成局域网 IP，不要用 `127.0.0.1` |

配置里所有地址都会**原样**发给客户端，`127.0.0.1` 指的是客户端自己，
不是你的电脑——这是「配置在电脑上能导入、电视上全红」的头号原因。
