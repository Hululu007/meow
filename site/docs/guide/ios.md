# iPhone / iPad

iPhone / iPad 现在有客户端了（IPA）。但官方只发布**未签名**的 `Meow-unsigned-<版本>.ipa`：
要用自己的 Apple ID 签一次名才能装。不想签名就走 Safari 方案，功能一样，见方式二。

> 端内自带后端（JVM），**不需要**另起 Docker 或 PC 后端；装好导入源包就能用。

## 装它

### 方式一：自签侧载（推荐）

1. 从 [Releases](https://github.com/upchr/meow/releases/latest) 下载 `Meow-unsigned-<版本>.ipa`
   （和 PC / TV 的包在同一个 Release 页）。
2. 按 [LiveContainer / SideStore 侧载教程](https://livecontainer.github.io/zh-CN/docs/installation/lc_sidestore)
   装：一个免费 Apple ID 就够，签名 **7 天有效**，过期重签；付费开发者账号可到 1 年。
3. 首次打开若提示「未受信任的开发者」：设置 → 通用 → VPN 与设备管理 → 信任对应描述文件。

::: tip 为什么没有直接能装的包
iOS 装 App 必须签名。项目没有付费开发者账号，也不上 App Store，
所以只能发未签名 IPA，由你自己签——这是平台限制，不是包坏了。
:::

### 方式二：Safari + 添加到主屏幕

不装 App 也能用：Safari 打开后端地址（`http://<后端 IP>:30010`），
「分享 → 添加到主屏幕」，以后从主屏图标进无地址栏全屏。
这种方式要另有一台机器跑后端（Docker / PC / 飞牛），见 [Web / Docker](/guide/web-docker)。

## 装好之后

IPA 是**独立端**：包内自带 Java 后端，源包在手机本机加载，断网也能搜（源站本身要联网）。
包内还带了 Node 运行时与弹幕聚合，与 TV 运行时模块同源。

1. 打开 App → 设置 →「配置源」，填源包地址或导入文件（和 PC 一样）。
2. 首页出现分类就说明导入成功。
3. 搜索/详情/播放走端内后端，不需要连别的设备。

**iOS 壳固定使用端内后端**（只绑 `127.0.0.1`），设置页里的「后端地址」是只读的，
也不能让别的设备连你这台手机当后端。

## 做不到的事（平台边界）

| 限制 | 表现 | 原因 |
|---|---|---|
| 转码 | 片库转码不可用 | 端内没有 ffmpeg |
| 格式 | MKV / FLV / DTS 等播不了 | 只有 WebKit + AVPlayer（HLS / mp4） |
| 加密源 | 带 `.so` 的 Guard jar 加载不了 | iOS 不认 Android ELF |
| 本地片库 | 没有系统目录可浏览 | 端内不给文件系统遍历；用 WebDAV / SMB |
| 当后端 | 别的设备连不上 | 只绑回环地址 |
| 性能 | 搜索、详情比 PC 慢 | JVM 是解释器（OpenJDK Zero），比 JIT 慢 |
| 上架 | 不上 App Store | GPL 运行时 + 动态加载 jar |

Safari 方案另有平台限制（全屏、后台播放、弹幕帧率、离线），见
[已知限制 → 在 iPhone 和 iPad 上](/reference/limits#在-iphone-和-ipad-上)。

## 出问题

| 症状 | 先查什么 |
|---|---|
| 装不上 / 签名失败 | Apple ID 免费额度是否用满；按侧载教程重来一遍 |
| 7 天后打不开 | 签名过期，重新签一次（LiveContainer 里可直接续） |
| 打开黑屏 | 端内 JVM 启动失败：杀掉重开；仍不行提 issue 带机型与 iOS 版本 |
| 站点全红 / 搜索为空 | 源包问题，见 [导入源包](/guide/source-pack) 与 [常见问题](/guide/faq) |
| 能搜不能播 | 先看格式是不是 MKV/FLV，或源站本身失效 |

## 相关

- 下载与版本：[下载与版本](/reference/downloads)
- 后续计划（含 iOS 改进项）：[应用计划](/reference/roadmap)
- 平台边界：[已知限制](/reference/limits)
- 技术契约（开发者）：[iOS 端接入](/dev/ios-integration)
