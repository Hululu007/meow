# 下载与版本

所有安装包都在 GitHub Releases。**文件名里的版本号随发布变化**，以 Releases 页实际资产为准。

## 去哪里下

- 最新发布：<https://github.com/upchr/meow/releases/latest>
- 全部版本：<https://github.com/upchr/meow/releases>

## 资产清单

| 文件 | 平台 | 说明 |
|---|---|---|
| `meow-setup-<版本>.exe` | Windows | PC 安装版（NSIS），带开始菜单与卸载 |
| `meow-bare-<版本>.exe` | Windows | PC 免安装版，解压即用 |
| `meow-TV-<版本>.apk` | Android TV / 投影仪 / 安卓手机 | TV 壳，release 签名 |
| `apiserver-<版本>.zip` | Windows | PC 后端插件；也可手动导入 |
| `tv-node-arm64-v8a-<node版本>.apk` | arm64-v8a | TV 运行时模块 |
| `tv-node-armeabi-v7a-<node版本>.apk` | armeabi-v7a | TV 运行时模块（老设备） |
| `tv-node-x86_64-<node版本>.apk` | x86_64 | TV 运行时模块（模拟器 / x86 盒子） |
| `meow_<版本>_x86.fpk` | 飞牛 fnOS x86_64 | 原生套件 |
| `meow_<版本>_arm.fpk` | 飞牛 fnOS arm64 | 原生套件 |
| `packages.json` | — | 客户端在线更新清单 |
| `SHA256SUMS.txt` | — | 所有资产的校验和 |

::: warning 公开 Release 不含源包
没有 spider jar、没有站点配置、没有弹幕载荷（TV 运行时模块除外，它是执行环境）。
装完是空壳，需要自己导入源包，见 [导入源包](/guide/source-pack)。
:::

## Docker 镜像

Web 形态直接拉镜像，不需要源码：

| 镜像 | 内容 |
|---|---|
| `chrplus/meow-web` | nginx + 静态前端 |
| `chrplus/meow-apiserver` | JVM + spider jar + ffmpeg |
| `chrplus/meow-drpy` | Node 运行时（**独立版本线**，不跟应用版本） |
| `logvar/danmu-api` | 弹幕聚合（上游镜像） |
| `chrplus/meow-sources` | 源服务：自带主爬虫 + Jable + 41 站默认源（**独立版本线**），见 [源包与配置格式](/ecosystem/source-format) |

`web` 与 `apiserver` 均含 amd64 + arm64，Docker 按本机架构自动选。

## 校验

```bash
# 下载 SHA256SUMS.txt 后
sha256sum -c SHA256SUMS.txt
```

Windows PowerShell：

```powershell
Get-FileHash .\meow-setup-<版本>.exe -Algorithm SHA256
```

值应与 `SHA256SUMS.txt` 中对应行一致。

## 版本号怎么读

三个版本号是**独立**的，不要试图对齐：

| 版本 | 来源 | 说明 |
|---|---|---|
| 应用版本 | `client/package.json` | 壳与前端 |
| `apiserver` 版本 | 插件 manifest | 后端插件，通常与应用同版发布 |
| `danmu-api` / `node` | 各自上游 | 跟随上游版本号 |

文档页显示的 <VersionBadge /> 是**源码版本**，可能领先于最近一次发布。
客户端内的「检查更新」读的是 `packages.json`，以它为准。

## 系统要求

| 端 | 要求 |
|---|---|
| Web | Docker 24+ / Compose 插件；2 GB 可用内存 |
| PC | Windows 10 1809 及以上 |
| TV | Android 8.0（API 26）及以上；壳与运行时模块的 minSdk 相同 |
| fnOS | 飞牛系统；x86_64 或 arm64 |

## 历史版本

Releases 页可以展开旧版本。跨大版本升级前建议先备份数据目录：

- Web：`MEOW_DATA` 挂载目录
- PC：`%APPDATA%\com.meow.player\data`
- fnOS：应用数据目录

## 相关

- 每版改了什么：[更新日志](/reference/changelog)
- 装完下一步：[导入源包](/guide/source-pack)
