# 版本兼容矩阵

三样东西各自独立演进：**应用**、**插件**、**源包格式**。版本号对不上是正常的，别按「数字应该一致」判断装没装好。

## 三个版本号

| 版本 | 看哪 | 谁决定 |
|---|---|---|
| 应用 | 设置页底部 | 壳与前端一起发布 |
| 插件 | 插件列表 | `apiserver` 通常与应用同版；`danmu-api`、`node` 跟随上游 |
| 源包格式 | 不在界面显示 | 由配置字段决定，见下 |

## 应用 × 源包字段

| 能力 | 最低应用版本 | 不满足会怎样 |
|---|---|---|
| 顶层 `spider`（含 `;md5;`） | 所有版本 | — |
| 站点级 `jar` | TV 端早期版本即有 | 可选；没有时回退顶层 `spider` |
| `spiderJvm`（JVM 优化/旧版兼容） | **1.1.6** | 旧版忽略该字段，回退读 `spider` |
| JVM 导入期 dex→class（dex2jvm） | **1.1.7** | 旧 JVM（≤ 1.1.6）不转换 dex，仍需 class jar |
| 导入模式 `mode` / `onConflict` / `replaceSpider` | 较早版本已有 | 旧版只能整表导入 |

::: warning 旧版 JVM + dex 源包
不认 dex2jvm 的旧 JVM 会拿顶层 `spider`（dex）去 `Class.forName`，报
`NoClassDefFoundError`。旧版要么用单独的 `config.jvm.json`（顶层 `spider` 指向
class jar），要么把 `spider` 直接指向 class jar。
1.1.7 起，猫窝 JVM 导入 `config.all.json` 会自动把 dex 转成 class；Fongmi/TV
一直直接吃 dex，不受影响。
:::

## 应用 × 插件

| 插件 | 最低应用版本 | 其他约束 |
|---|---|---|
| `apiserver` | 与应用版本一致 | 后端插件不跨大版本使用 |
| `danmu-api` | 无强约束 | 需要 `node` 插件或系统 Node |
| `drpy` | 较早版本 | 无 |
| `tv-node-<abi>` | **1.1.0** | `min_sdk` 26（Android 8.0） |

插件清单里不满足 `min_app_version` 时，界面直接禁用下载按钮并说明原因，
不会装上去再崩。

## 应用 × 端能力

| 能力 | 首次可用版本 | 备注 |
|---|---|---|
| 端内网关（TV 不依赖电脑） | 较早版本 | 需要壳内置 |
| 扫码推送配置 | 1.0.7 之前已有 | 1.0.7 起页面显示访问令牌 |
| TV 运行时模块（Node / 弹幕） | **1.1.0** | 与 `min_sdk` 26 绑定 |
| 飞牛版内置弹幕插件 | 1.1.0 | 复用应用中心 Node 22 |
| fnOS 应用内更新 | **1.1.3** | 旧版只能走应用中心 |
| 配置支持 `spiderJvm` | **1.1.6** | 见上 |
| JVM 导入期 dex→class（dex2jvm） | **1.1.7** | 源包只需 dex；旧 JVM 用 `config.jvm.json` |
| 投屏（手机 / PC → TV / 投影） | **1.2.12** | 搜索同一局域网的 DLNA 设备，进度可回传 |

更早的能力没有逐版本记录，以实际界面为准。这张表只列能追溯到 CHANGELOG
或代码里明确门槛的项。

## 端支持

| 端 | 形态 | 状态 |
|---|---|---|
| Windows 10 / 11 | 桌面端（Tauri 壳 + 插件） | ✅ 官方包（NSIS 安装版 / 免安装版） |
| Android TV / 盒子 / 投影仪 | TV 客户端（APK，Android 8.0+） | ✅ 官方包 |
| Android 手机 / 平板 | 同一个 APK，布局自动切竖屏 | ✅ 官方包 |
| 飞牛 fnOS | 应用中心套件 | ✅ 官方包 |
| NAS / 服务器 / Linux | Docker 四容器 + 浏览器 | ✅ 官方镜像（amd64 / arm64） |
| macOS（Apple Silicon / Intel） | Docker 四容器 + 浏览器 | ⭕ 可用，无桌面应用 |
| iPhone / iPad | Safari + 添加到主屏幕 | ⭕ 可用，无客户端 App |
| 电视自带系统（Tizen / webOS） | — | ❌ 不支持 |

⭕ = 功能完整（搜索、播放、弹幕、片库、直播、AI、转码），只是没有原生壳。
macOS 与 iOS 不发布原生包：两者都没有官方验证条件，不发布未经验证的安装包。
启动步骤见 [Web / Docker](/guide/web-docker)，平台限制见
[已知限制 → 在 iPhone 和 iPad 上](/reference/limits#在-iphone-和-ipad-上)。

## 怎么判断自己能不能用

1. **看版本**：设置页底部
2. **看拦截提示**：插件/模块下载按钮被禁用时，提示会写要求的最低版本
3. **看清单**：`packages.json` 里每个条目的 `min_app_version` 与 `min_sdk`
4. **试最小的**：先导入配置，能搜索就说明源包与应用版本匹配

## 升级路径

| 起点 | 建议 |
|---|---|
| 1.0.x → 1.1.x | 直接升；但 TV 运行时模块需要壳先到 1.1.0 |
| 1.1.0–1.1.5 → 1.1.6 | 可用统一配置，旧 `config.jvm.json` 仍兼容 |
| 1.1.6 → 1.1.7 | `config.all.json` 的 dex 由 JVM 导入期转换；旧配置需重新导入一次 |
| 任意 → 降级 | 见 [升级与迁移](/guide/upgrade#降级) |

::: tip 版本号不齐不用管
「应用 1.1.6 + 后端 1.1.5」这种组合是正常的。
强行对齐会让每次改前端都要重发 31 MB 的后端包。
:::

## 相关

- 下载对应安装包：[下载与版本](/reference/downloads)
- 升级步骤与迁移：[升级与迁移](/guide/upgrade)
- 导入选项与字段：[导入源包](/guide/source-pack)、[配置格式](/ecosystem/source-format)
- 实际版本记录：[更新日志](/reference/changelog)
