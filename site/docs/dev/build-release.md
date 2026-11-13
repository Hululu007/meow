# 构建与发版

**唯一操作手册是 [`deploy/README.md`](https://github.com/upchr/meow/blob/main/deploy/README.md)**；
这一页只说明它的结构、易错机制与 CI 关系。

## 一、唯一真源：`deploy/units.json`

所有构建单元、链路入口、产物清单都在 `deploy/units.json`；加一个产物 = 只改这一个文件。

它分四段：`chains` 三条链路入口（pc/tv/docker，各带 `runner` 与理由）；`plugins` 五个插件
（`apiserver`/`drpy` 为 required，其余失败不阻断；每个单元用 `chain` 声明归属：
`plugins` 链建 4 个 PC 插件，`tv-node` 归 `tv-plugins` 链）；`index` 指向
`server/build-release.ps1`（打 zip 并生成带 sha256 的 `packages.json`）；`version` 指向
`bump-version.ps1`。

**插件数组的顺序就是执行顺序**（`foreach` 按数组走）：`apiserver` 最慢，放最前。

改完跑自检（十余项，含 `docker compose config` 校验）：
`powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/verify.ps1`。

## 二、版本号：脚本清单里的 17 个位置

`powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/bump-version.ps1 -Version 1.2.0`

覆盖 17 个位置（`deploy/docker/.env` 存在时 18 个）：三个 `package.json`、Tauri 配置与
两个 `Cargo.lock`、`ApiServer.java` 的 `VERSION`、`apiserver.manifest.json`、TV
`build.gradle`、`.env.example`、**四个 compose 的兜底**（`docker-compose.yml` /
`.build.yml` / `.with-sources.yml` / `.standalone.yml`）、fnOS 的 `fpk/manifest` 与
`meowd` 的 Cargo 文件。`standalone.yml` 是站点「下载即用」那份，靠这里自动跟进；
`with-sources.yml` 曾因不在清单里残留过旧版本，现已纳入。

**硬规则**：必须三段数字；**禁止倒退**（`versionCode` 只能增大，镜像 tag 倒退会让人以为
拉到了新包）；`versionCode = major*1000 + minor*100 + patch`（`1.1.6` → `1106`）。写盘后
会重跑 `-Check` 回读校验。

`-Check` 在三个 workflow 都会跑；`Cargo.lock` 未同步时，报错会给出 `cargo update` 的修法。

::: danger 版本线不统一
壳和 `apiserver` 插件跟 `client/package.json`；`drpy`（`0.1.0`）、`danmu-api`（`1.0.0`）、
TV 模块（形如 `18.20.4.x`）是**独立版本线**。`release.yml` 只对壳类 tag 校验“tag 后缀 ==
package.json”，`plugins-v*` / `tv-plugins-v*` 不校验；不要拿壳版本去推模块 tag。
:::

## 三、tag 与链路的对应

| tag | 构建什么 | 建 Release |
|---|---|---|
| `release-v*` | Web + TV + PC + apiserver 插件 + Docker 三镜像 + **fnOS fpk ×2** | ✅ draft |
| `tv-v*` | TV APK（不带运行时模块） | ✅ draft |
| `pc-v*` | PC 壳 + apiserver 插件 | ✅ draft |
| `plugins-v*` | PC 插件 ×4（`chain: plugins`；tv-node 归 `tv-plugins-v*`） | ✅ draft |
| `tv-plugins-v*` | TV 运行时模块 ×3 ABI | ✅ draft |
| `fpk-v*` | 另一 workflow：x86/arm 套件（补包用）；全量 `release-v*` 也调它构建，但包进主 Release | ✅ draft（仅单链） |

**`docker-v*` 单链只推镜像、不建 Release**（2026-11-12 补回）：重发镜像也可以走
`workflow_dispatch`（勾 docker）或 `build-push-docker.ps1`；dispatch 不建 Release
（`publish` 要求 push）。

两条规则：**前缀后必须紧跟数字**（`tv-v[0-9]*`），`tv-verify-1.1.6` 不触发；**壳类 tag
后缀必须等于 `client/package.json` 版本**，否则 `plan` 失败（`plugins-v*` / `tv-plugins-v*`
例外）。

`publish` 的判据是“选中的链没有 failure/cancelled”，**skipped 视为通过**——只打 `tv-v*`
也会建 Release，里面只有 TV 产物。

## 四、Release 与在线更新清单

```
CI 建 draft Release → 人工 Publish → release:published
  → sync-packages 生成并上传 packages.json → 同时 force-push updates 分支 → 客户端读清单
  → index-after-publish（fpk）写 FnDepot fnpack.json + 合并写 fpk-updates 分支
```

- **draft 不产生任何用户可见清单**，必须点 Publish：`sync-packages` 与 fpk 的
  `index-after-publish` 都只在 `release: published` 跑（前者跳过 `fpk-v*`）。
  四条链同构——tag → 构建 → draft → Publish → 写索引，**草稿阶段删掉不会留下索引**。
- **清单只有 `packages.json`**：`SHA256SUMS.txt` 由 `publish` 给 Release
  资产算，`index.json` 只是本地产物的别名，不在 Release 流程里。
- **资产名不能改**：客户端按常量 `packages.json` 找清单，改名等于让所有客户端看不到更新。
- **全量 Release 会复制继承的插件资产**（`release-v*`）；单链发布不复制，url 仍指向旧
  Release——**不要删旧 Release**，否则那条插件 url 失效。同一 tag 重跑幂等（合并、重传、
  回读校验）。
- 客户端**不直接信任 `/releases/latest`**：内置默认源地址虽写成它，但只当入口；实际拉
  `/releases` 列表，过滤 draft/prerelease/模块与插件 tag（`tv-plugins|plugins|docker|fpk-v`
  开头的不要），要求有 `packages.json` 资产，再按 tag 版本号取最大（补发旧版不会降级）。

## 五、本地发版 vs CI 发版

本地入口 `deploy/scripts/release.ps1`，产物落 `release/v<版本>/`；CI 入口是打 tag，
`-Plan` 只列计划不执行。

`-Publish` 会建**无前缀** `v<版本>` tag（带前缀会触发 CI）、推 draft Release 并调
`sync-packages`；前缀在构建前就硬校验。它不代提交源码，产物与 tag 对应的源码可能不一致。

## 六、几条硬约束

- **不要主动用 CI 发版**，每次都要显式确认；本地是默认路径
- **不要改 `units.json` 以外的地方加构建单元**
- **TV keystore 永不入库**（见 [TV 接入 · 签名](./tv-integration.md#七五签名与分发-密钥备份)）
- **公开 Release 不允许出现源包文件**：`spider*.jar`、`config.sites.json`、
  `node-payload-danmu.zip` 会被 `publish` 拦下
- 打 fpk 后**必须回读包内版本串**：CI 解包比对 `manifest`、`ApiServer.class` 与
  `install_dep_apps`（manifest 与 Cargo 漂移过一次）

## 七、相关

- 完整命令与排障：[deploy/README.md](https://github.com/upchr/meow/blob/main/deploy/README.md)
- 版本号来源：[版本兼容矩阵](/reference/compatibility)；签名：[TV 接入](./tv-integration.md)
