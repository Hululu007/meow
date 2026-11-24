# 源包规范（meow-source-pack/1）

> 目标：一份 **dex 为主**的源包，同时服务 Fongmi/TVBox、猫窝 TV 和猫窝 JVM。
> CatVod 的 dex jar 是唯一主产物；JVM 是附加消费方，用 `Dex2Jvm` 在导入时把
> dex 转成 class，不要求源包准备两套 jar。

## 1. 目录

```text
sources/
├── config.all.json       # 唯一入口（Fongmi / 猫窝 TV / 猫窝 JVM 都填它）
├── source-pack.json      # 机器可读清单（版本、产物、hash、profile）
├── spider-dex.jar        # 主产物：ZIP 内 classes.dex
├── spider.jar            # 可选：class 形态，仅兼容旧 JVM / config.jvm.json
├── config.jvm.json       # 可选：旧 JVM 兼容 profile（不推荐新部署使用）
├── config.tv.json        # 可选：显式 TV profile（config.all 已可在 TV 用）
└── SHA256SUMS.txt
```

**`config.all.json` 是唯一需要维护的配置。** `config.jvm.json` / `config.tv.json`
是为旧客户端保留的兼容 profile，不应该再手工维护；新部署可以只放
`config.all.json + source-pack.json + spider-dex.jar`。

## 2. 硬规则

| 规则 | 要求 |
|---|---|
| 顶层 `spider` | **必须**是绝对 `http(s)` URL，指向 **dex** jar（ZIP 内有 `classes.dex`） |
| 站点 `jar` | 可选。省略时用顶层 `spider`；写了就必须是 **dex** jar |
| `spiderJvm` | 可选。class jar，仅 JVM 优化/旧版兼容；Fongmi/TV 会忽略；**不能作为唯一产物** |
| jar URL | 必须带 `;md5;<32位小写 hex>`，或使用带版本的不可变文件名；推荐 `;md5;` |
| 地址 | 绝对 URL；禁止 `file:`、相对路径、`127.0.0.1`、`localhost` |
| `spider` 地址 | 同一个 URL 的内容必须稳定；换 jar 必须换 md5 或换文件名 |
| 编码 | UTF-8，无 BOM |
| 配置缓存 | `config.all.json` 用 `Cache-Control: no-cache`；jar 用 md5/版本号破缓存 |

### 为什么必须带 md5

Fongmi、猫窝 TV 和猫窝 JVM 都会按 jar URL 缓存。只替换服务器上的
`spider-dex.jar` 而不改 URL，客户端可能永远用旧缓存。`;md5;` 是 CatVod 标准写法，
三端都认：

```json
{
  "spider": "http://192.168.1.20:18080/spider-dex.jar;md5;5d41402abc4b2a76b9719d911017c592"
}
```

也可以用内容寻址文件名（如 `spider-dex-5d41402a.jar`），但不要两种都不做。

## 3. 三端行为

| 端 | 读取 | 加载方式 |
|---|---|---|
| Fongmi / TVBox | `spider` + `sites[].jar` | Android `DexClassLoader` |
| 猫窝 TV | `spider` + 站点 `jar`（缺省回退顶层） | `DexClassLoader`，不转换 |
| 猫窝 JVM（Docker/PC/fpk） | 优先 `spiderJvm`；没有则 `spider` | `URLClassLoader`；dex 由 `Dex2Jvm` 导入期转换并缓存 |

因此：

- **Fongmi 和猫窝 TV 不需要 `spiderJvm`**。
- **猫窝 JVM 不要求 `spiderJvm`**：没有它就走 dex2jvm。
- 推荐 `config.all.json` **不写 `spiderJvm`**，让 JVM 走统一转换链路；
  只有在明确要优化 JVM 冷导入时才加它。

## 4. 站点级 jar

绝大多数源包只需要顶层 `spider`，站点不写 `jar`。只有某个站点确实需要
**另一个 dex jar** 时才写站点级 `jar`：

```json
{
  "key": "特殊站点",
  "name": "特殊站点",
  "type": 3,
  "api": "csp_Special",
  "jar": "http://host:18080/special-dex.jar;md5;..."
}
```

- 站点级 `jar` 也必须是 dex；class-only 的站点 jar 在 TV/Fongmi 无法加载。
- JVM 会把每个不同的 dex jar 各自转换并缓存：**不只是导入期**，
  `Jars` 挂载前会调 `Dex2Jvm.convertLocal`（所以直接改 `config.sites.json`、
  或用源服务下发的站点级 dex 也会被转）。转换产物在 `<data>/jars/converted/`，
  缓存键 = sha256 + 转换器指纹（带 `-fix1` 后缀，见下条）。
- **转换产物会被 `core.DexJvmFix` 自动修补 d2j 的翻译缺陷**：dex 里合法的
  `new-instance C` + `invoke-direct {v}, Object.<init>()V` 会被 d2j 2.4 翻成
  `new java/lang/Object`，实例运行时类型错成 `Object` —— JVM 端调用 `C.f()`、
  或把对象塞进 `C[]` 时抛 `ArrayStoreException: java.lang.Object`。
  实测肥猫那版 jar 里 `AppDrama`（干饭/一碗/再来/行动）的 detail/player 全中招：
  **能搜不能播，TV（直接吃 dex）却正常**。修补尽力而为（失败保留原产物），
  只改「真实类直接继承 Object」的点位；缓存键带 `-fix1`，升级后不会命中旧的坏产物。
- **JVM 端启动必须关 jar 内字节码校验**（`-XX:+UnlockDiagnosticVMOptions
  -XX:-BytecodeVerificationRemote`）：dex2jar 产物的 stackmap 不完整，默认校验会
  `VerifyError`。三处参数位置见 `AGENTS.md` §4.12。
- 不要给每个站点重复写同一个 `spider-dex.jar`：省略 `jar` 更省流量，也更不容易漏改。

## 5. `source-pack.json`

机器可读清单，源服务健康检查和校验脚本都依赖它：

```json
{
  "schema": "meow-source-pack/1",
  "entry": "config.all.json",
  "primaryRuntime": "dex",
  "generatedAt": "2026-11-11T06:00:00Z",
  "profiles": {
    "all": { "config": "config.all.json", "runtimes": ["fongmi", "android", "jvm"] },
    "jvm": { "config": "config.jvm.json", "runtimes": ["jvm"], "deprecated": true },
    "tv": { "config": "config.tv.json", "runtimes": ["android"], "deprecated": true }
  },
  "artifacts": [
    {
      "name": "spider-dex.jar",
      "role": "dex-spider",
      "bytes": 1704212,
      "md5": "…",
      "sha256": "…"
    }
  ]
}
```

`profiles.jvm` / `profiles.tv` 可以省略；只要 `entry` 存在即可。

## 6. 源服务（nginx）

compose 分工：

- `docker-compose.yml` / `docker-compose.build.yml`：主栈，不含 sources；
- `docker-compose.with-sources.yml`：主栈 + sources 一键启动；
- `docker-compose.sources.yml`：只启动源服务。

官方镜像 `chrplus/meow-sources:latest`（当前指向 2.0.0）内置主爬虫 + Jable 扩展 + 54 站默认源；
自定义完整源包通过 `/mounted-sources` 只读挂载覆盖。`Dockerfile.sources` /
`nginx.sources.conf` / `entrypoint.sh` / `default-sources` 是私仓构建资源，
已在公开库 gitignore。

规则一致：

- 默认源与用户挂载源分离，挂载源不 COPY 进镜像；
- 禁止 SPA fallback（找不到必须 404，不能返回 index.html）；
- `.jar` 显式 `application/java-archive`；
- 关闭目录列表，开启 `Cache-Control: no-cache` 和 CORS；
- 健康检查同时检查 `config.all.json` 和 `source-pack.json`。

## 7. 更新流程

```bash
# 1. 替换 dex jar
cp new-spider-dex.jar sources/spider-dex.jar

# 2. 计算 md5，更新 config.all.json 里 spider（以及站点级 jar）的 ;md5;
md5sum sources/spider-dex.jar

# 3. 重新生成 source-pack.json 和 SHA256SUMS.txt
python3 deploy/source-pack/validate.py --dir sources --base-url http://<HOST>:18080

# 4. 回验
curl -fsS http://<HOST>:18080/source-pack.json
curl -fsS http://<HOST>:18080/config.all.json
```

只换文件不需要重启 nginx；开源版改 nginx 规则要改 compose 的内联
`configs.content`，私仓版改 `nginx.sources.conf` 后重建镜像。
**不要**把源包放进 `meow-web` 的 web 根目录。

### 同步 latest（发新版本必做）

多架构镜像**不能** `docker tag` 后 `push`——那会把 manifest list 覆盖成单架构。
用仓库侧复制，保留所有平台：

```bash
docker buildx imagetools create \
  -t chrplus/meow-sources:latest \
  chrplus/meow-sources:<版本>
```

2026-11-23 的教训：2.0.0 推送时漏了 latest，`latest` 停在 11-11 的旧构建
（41 站），而 2.0.0 是 54 站。镜像内容里 `config.all.json` 的站点数可直接验证：

```bash
docker run --rm -d -p 18080:8080 --name src-check chrplus/meow-sources:latest
curl -s http://127.0.0.1:18080/config.all.json | grep -o '"key"' | wc -l
docker rm -f src-check
```

## 8. Fongmi 兼容字段

`config.all.json` 使用 CatVod 标准字段：

- 顶层：`spider`、`sites`、`lives`、`parses`、`headers`、`hosts`、`ads`、`rules`、`doh`、`wallpaper`、`logo`
- 站点：`key`、`name`、`api`、`type`、`ext`、`jar`、`searchable`、`changeable`

猫窝自定义字段：

- `spiderJvm`：Fongmi 会忽略；可选。
- `proxy`：猫窝是字符串数组；Fongmi 期望对象数组，会忽略。给 Fongmi 用时可以删掉。
- `parses` 里的 `Demo` / `Web` 是猫窝内置名；Fongmi 不认识，建议给第三方用时删掉或改写成标准 URL。

## 9. 校验

```bash
python3 deploy/source-pack/validate.py --dir /vol2/1000/meow-sources \
  --base-url http://192.168.1.20:18080
```

校验内容：

- `source-pack.json` schema / entry / artifacts hash；
- `config.all.json` 的 `spider`、站点 `jar` 是否绝对 URL、是否 dex；
- `;md5;` 是否存在且与本地文件一致；
- `spiderJvm`（如果存在）是否 class jar；
- `SHA256SUMS.txt`；
- Fongmi 兼容性 warning（`proxy` 形态、缺失 `key/name/api` 等）。

退出码非 0 即不通过。

## 10. jar 从哪来、类名会漂

`spider-dex.jar` / `spider.jar` 是**上游仓的 dex jar** 及其 `d2j-dex2jar` 转换产物，
不是手写。上游会重构类名，**换 jar 时必须重跑一遍全站可用性探测，不能只换文件**。

2026-11-23 那版（125 类）相对旧快照（47 类）的实测映射：

| 旧类名 | 新类名 | 说明 |
|---|---|---|
| `Dm84` | `AnimeBashi` | 动漫巴士 |
| `GuaziTY` | `SportsGuazi` | 瓜子体育 |
| `Kanqiu` | `Sports88` | 看球 |
| `Jianpian` | `JianPian` | 荐片（新类只吃 JSON ext，给 URL 字符串会 `JSONException`） |
| `AppDrama2` | `AppDrama` | 干饭/行动/再来/一碗 |
| `PanSearch` | `PanSou` | 盘搜 |
| `AppFQ` | — | 番薯，新版没有对应，直接消失 |

另外两条硬事实：

- **同一站点的 `ext` 也可能换格式**，一律以上游仓里的 `ext` 为准，不要沿用旧包的。
- 两个版本的 `merge/*` 混淆包**同名不同实现、互不兼容**，所以不能把两批类合进
  一个 jar；换 jar 是**整体替换**（实测 `merge/c/c`：旧版 3 字段 vs 新版 14 字段）。

### 10.1 d2j 会翻错 `new-instance`（2026-11-24 实测）

新版混淆器给没有显式构造器的类写成
`new-instance C` + `invoke-direct {v}, Object.<init>()V`（dex 合法，ART 下实例仍是 C）。
`d2j-dex2jar 2.4` 按构造器目标推断类型，翻成 `new java/lang/Object` —— JVM 上实例
类型真成了 `Object`，后续 `invokevirtual C.f` / `aastore` 进 `C[]` 直接
`ArrayStoreException: java.lang.Object`。

症状很有欺骗性：**搜索正常、首页正常，只有详情/播放报错**，而且只在 JVM 端
（TV/Fongmi 吃 dex 完全正常）。肥猫那版 125 个类里命中 17 个类、37 个点位，
`AppDrama` 的 detailContent/playerContent/categoryContent 全在名单里。

处理方式：`core.DexJvmFix` 在转换后自动修（数据流把每个 `new Object` 追到
真实接收者类，只改 NEW 的类型）。**手工换 jar 时不要绕过它**——用旧的
`spider.jar`（已经翻错的那份）就会带着 bug 一起发出去。校验方法：

```bash
# 命中数应为 0；非 0 说明遇到未修补的点位
javap -p -c -cp . com.github.catvod.spider.AppDrama | grep -c "new .*java/lang/Object"
```

