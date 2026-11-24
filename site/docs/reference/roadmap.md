# 应用计划

这一页说明各个端与能力的**当前状态**和**接下来要做什么**。

::: warning 计划不是承诺
排序看两件事：公开 issue 里的实际反馈量，以及我们有没有设备能实测。
没有官方验证条件的能力不会进发布计划：iOS 因此停在实验分支（只有自签环境能验），macOS 则直接不做。
:::

## 状态怎么读

| 标记 | 含义 |
|---|---|
| ✅ 已发布 | 官方包 / 官方镜像里就有，文档按它写 |
| 🧪 实验 | 有可跑的产物，但在分支或自签通道里，未进主线、未发官方资产 |
| 🚧 处理中 | 已有公开 issue，正在改 |
| 📋 计划中 | 方向定了，还没排期 |
| ⛔ 暂不做 | 明确不做，原因写在下文或 [已知限制](/reference/limits) |

## 端

| 端 | 状态 | 说明 |
|---|---|---|
| Windows 10 / 11 | ✅ | NSIS 安装版 / 免安装版 |
| Android TV / 盒子 / 投影仪 | ✅ | APK，Android 8.0+ |
| Android 手机 / 平板 | ✅ | 同一个 APK，竖屏布局 |
| 飞牛 fnOS | ✅ | 应用中心套件 |
| NAS / 服务器 / Mac | ✅ | Docker 镜像 + 浏览器 |
| iPhone / iPad | 🧪 | 官方路径是 Safari；IPA 工程在实验分支，见下 |
| 电视自带系统（Tizen / webOS） | ⛔ | 不提供，见 [已知限制](/reference/limits) |

## iPhone / iPad：IPA 到哪一步了

**现在就能用（官方路径）**：Safari 打开后端地址 →「分享 → 添加到主屏幕」，
功能与 Web 完全一致。平台边界（全屏、后台播放、弹幕帧率、离线）见
[已知限制 → 在 iPhone 和 iPad 上](/reference/limits#在-iphone-和-ipad-上)。

**IPA 的进展**：实验分支 [`feat/ios-jvm`](https://github.com/upchr/meow/tree/feat/ios-jvm/client/apps/ios)
里已经有一个可跑的 iOS 工程，和 TV APK 同一形态（WKWebView 装同一份 `web/dist`），
区别是**端内用 JVM 解释器跑 `ApiServer`**，所以不连外部后端也能导源、搜索、播放。

边界先讲清楚，免得期待错位：

| 事项 | 结论 |
|---|---|
| 端内跑源 | 只能跑 **class 形态**的 jar（`spiderJvm`）；dex 在端上不转 |
| 带 native 的 jar | ⛔ 加载不了：Guard 系加密 jar 里的 `.so` 是 Android ELF，iOS 不认 |
| 转码 | ⛔ 端上没有 ffmpeg，转码路由会直接报不可用 |
| 分发 | 没有付费开发者账号 → 只能出**未签名 IPA**，用 AltStore / Sideloadly 自签，**7 天有效**；不进 `packages.json`，**没有自更新** |
| App Store | ⛔ 不上架（GPL 运行时 + 动态加载 jar） |

**接下来**：把实验分支收敛进主线 → 出第一版未签名 IPA 资产 → 在
[版本兼容矩阵](/reference/compatibility) 与本站标成「实验」而不是「已支持」。
在那之前，Releases 里没有 IPA，用 Safari 方案。

想自己从分支构建：需要 macOS + Xcode，步骤在分支的
[`client/apps/ios/README.md`](https://github.com/upchr/meow/blob/feat/ios-jvm/client/apps/ios/README.md)。

## 接下来（按主题）

| 主题 | 状态 | 进度 / 讨论 |
|---|---|---|
| 片库画质：4K HDR 与 10-bit 不再一律转码 | 🚧 | [#12](https://github.com/upchr/meow/issues/12) |
| 起播与线路：坏线路秒切、按成功率排序 | 🚧 | [#16](https://github.com/upchr/meow/issues/16) |
| 转码资源回收：退出播放后不再占 CPU | 🚧 | [#15](https://github.com/upchr/meow/issues/15) |
| 源兼容：drpy 站点、jar md5 不匹配、加密 jar 预判 | 🚧 | [#13](https://github.com/upchr/meow/issues/13)、[#14](https://github.com/upchr/meow/issues/14)、[#10](https://github.com/upchr/meow/issues/10) |
| 片库直链（`.strm` / 302 签名 URL）与盘搜定位 | 📋 | [#6](https://github.com/upchr/meow/issues/6) |
| 片库添加门槛：目录点选与失败归因 | 📋 | [#5](https://github.com/upchr/meow/issues/5) |
| TV / 手机外网访问与多用户登录 | 🧪 | [#4](https://github.com/upchr/meow/issues/4)、[公网部署与访问控制](/dev/public-deployment) |
| Jellyfin 片库接入 | 📋 | [#8](https://github.com/upchr/meow/issues/8)（已回复确认要做） |
| 倒计时电源动作（关机 / 休眠 / 退出应用） | 🧪 | [设计稿](/dev/power-actions) |
| 飞牛网关统一身份 | 🧪 | [设计](/dev/fnos-gateway-auth) |
| iOS IPA | 🧪 | 见上一节 |

## 计划怎么定

1. **同一个问题被反复提**，优先级往前——issue 里 +1 比私信有用。
2. **能实测才排期**：没有设备验证的能力，不写进发布计划。
3. **不做的写清原因**：见 [已知限制](/reference/limits)（电视自带系统、商业授权等）。
4. **不定日期**：只给状态，不给「几月几号」。给了日期做不到，比不说更糟。

## 想要某个功能

- 先搜 [已有 issue](https://github.com/upchr/meow/issues?q=is%3Aissue)，避免重复。
- 没有就按 [反馈与贡献 · 提 Issue](/reference/contributing#提-issue) 选模板提：
  写清要解决什么问题、现在怎么绕，比只写「加个 XX 功能」有用得多。
- 源站失效不属于客户端计划：那是上游，换源或等上游恢复。
