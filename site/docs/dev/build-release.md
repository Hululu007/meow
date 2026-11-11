# 构建与发版

**唯一操作手册是仓库根目录的 [`deploy/README.md`](https://github.com/upchr/meow/blob/main/deploy/README.md)**，
这一页只说明它的结构、几个容易出错的机制，以及和 CI 的关系。

## 一、唯一真源：`deploy/units.json`

所有构建单元、链路脚本、产物清单位于 `deploy/units.json`。加一个产物 = 改这一个文件，
不要再去改脚本数组或 workflow 步骤。

```json
{
  "chains": { "pc": {...}, "tv": {...}, "docker": {...} },
  "plugins": [ { "id": "apiserver", ... }, { "id": "drpy", ... } ],
  "index": { "script": "server/build-release.ps1" },
  "version": { "script": "deploy/scripts/bump-version.ps1" }
}
```

改完跑自检：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/verify.ps1
```

它会检查文件存在、脚本语法、清单覆盖、文档引用是否一致。

## 二、版本号：13 处一次改齐

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/bump-version.ps1 -Version 1.2.0
```

覆盖范围包括 `client/package.json`、TV 的 `versionCode`、fnOS 的 `fpk/manifest`、
`meowd` 的 `Cargo.toml`、compose 的兜底 tag 等。**漏一处会导致 health 报旧版本或包内版本与清单不符**，
所以有 `-Check` 模式做只读校验，CI 每次都会跑。

::: danger 版本线不统一
应用、`apiserver` 插件、`danmu-api`、Node 运行时是四条独立版本线。
`release.yml` 里对 tag 的校验按域区分，不要为了「看起来整齐」强行对齐。
:::

## 三、tag 与链路的对应

| tag | 构建什么 | 是否建 Release |
|---|---|---|
| `release-v*` | 全量（含资产复制） | ✅ |
| `tv-v*` | TV APK | ✅ |
| `pc-v*` | PC 安装包 + apiserver | ✅ |
| `plugins-v*` | 插件 | ✅ |
| `tv-plugins-v*` | TV 运行时模块 | ✅ |
| `docker-v*` | 镜像推送 | ❌ 不建 Release |
| `fpk-v*` | 飞牛套件 + FnDepot 回写 | ✅ |

`publish` job 的判据是「任一链被选中且无 failure」——**skipped 视为通过**。
所以只打 `tv-v*` 也会建 Release，但只包含 TV 产物。

## 四、Release 与在线更新清单

```
CI 建 Release（draft）
      ↓  发布：gh release edit --draft=false
release: published 事件
      ↓
sync-packages 生成 packages.json / index.json / SHA256SUMS
      ↓
客户端「检查更新」读清单
```

三个容易忘的点：

1. **draft 不会触发清单生成**，必须 `--draft=false`
2. **已发布的版本可以改描述**，但要重传 `packages.json` 才会生效
3. 客户端**不用** GitHub 的 `/releases/latest`，自己按版本号挑

## 五、本地发版 vs CI 发版

| | 本地 | CI |
|---|---|---|
| 入口 | `deploy/scripts/release.ps1` | 打 tag |
| 默认 | ✅ 默认路径 | 需显式同意 |
| 产物 | 落 `release/<版本>/` | 上传到 Release 资产 |
| 适合 | 全量、可控 | 单链、并行 |

`release.ps1 -Plan` 可以只列计划不执行。

## 六、几条硬约束

- **不要主动用 CI 发版**，每次都要显式确认；本地是默认路径
- **不要改 `units.json` 以外的地方加构建单元**
- **TV keystore 永不入库**（见 [TV 接入 · 签名](./tv-integration.md#七五签名与分发-密钥备份)）
- 打 fpk 后**必须回读包内版本串**，manifest 与 Cargo.toml 漂移过一次

## 七、相关

- 完整命令与排障：[deploy/README.md](https://github.com/upchr/meow/blob/main/deploy/README.md)
- 版本号来源：[版本兼容矩阵](/reference/compatibility)
- 签名细节：[TV 接入](./tv-integration.md)
