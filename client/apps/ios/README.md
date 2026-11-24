# iOS 独立端（内嵌 OpenJDK 9 Zero + ApiServer）

目标：iPhone / iPad 上**不连外部后端**也能跑完整猫窝——同一份 `web/dist`、
同一套 `/api` 契约、同一个 `ApiServer`，源（包括 jar 生态）在端内执行。
形态对齐 TV 的「壳 + 端内网关 + dex」，区别是 iOS 用 **JVM 解释器**替代 ART。

## 结论与边界

| 能力 | 状态 |
|---|---|
| WKWebView 加载同一份前端 | ✅ |
| 端内 `ApiServer`（Java）监听 9978 | ✅ 真机（静态链接 JDK9 Zero） |
| `spider.jar`（class 形态）`URLClassLoader` 加载 | ✅ 路径已接好，需导入源包验证 |
| dex 形态 jar | ⚠️ 端上不转；用配置里的 `spiderJvm`/上游转成 class jar |
| 带 native `.so`/JNI 的 jar（Guard 加密） | ❌ iOS 加载不了 Android ELF |
| 转码（ffmpeg） | ❌ 端上没有 ffmpeg，路由会报不可用 |
| App Store | ❌ 侧载（GPL OpenJDK + 动态 jar）；不打算上架 |

## 架构

```
Meow.app
├─ web/                    同一份 web/dist（静态服务 9979）
├─ openjdk/                OpenJDK 9 Zero 运行时（lib/modules + conf + cacerts）
├─ jvm/
│   ├─ host.jar            ApiServer（--release 9 编译，Dex2Jvm 换桩）
│   └─ libs/*.jar          okhttp / gson / android-json / bcprov / smbj ...
└─ Meow (Mach-O)
    ├─ WKWebView  http://127.0.0.1:9979/
    ├─ 静态文件服务（Network.framework，仅 GET/HEAD）
    └─ JvmBridge.mm  JNI_CreateJavaVM → ApiServer.main(--port=9978 --data-dir=...)
```

- 前端 `resolveBase()` 通过注入的 `localStorage['meow.api']` + `meow.api.scope=ios`
  取到 `http://127.0.0.1:9978`；页面从 9979 加载，跨源由宿主 CORS（localhost 放行）处理。
- `JvmBridge.mm` 里的 `_dlopen` 包装是静态 JVM 的必要接法：libjvm 用
  `dlopen(NULL, RTLD_FIRST)` 找自己的 JNI 原生方法，包装器把句柄指向主镜像。

## 构建

macOS + Xcode CLT（XcodeGen、libtool、xcrun）：

```bash
cd client && pnpm install && pnpm build

bash client/apps/ios/scripts/prepare-runtime.sh   # 下载 JDK9 bundle、合并 libOpenJDK.a、裁运行时
bash client/apps/ios/scripts/build-host.sh        # --release 9 编 ApiServer

cd client/apps/ios
xcodegen generate

# 真机未签名 IPA
xcodebuild -project Meow.xcodeproj -scheme Meow -configuration Release \
  -sdk iphoneos -derivedDataPath build/dd-device \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
mkdir -p build/ipa/Payload
cp -R build/dd-device/Build/Products/Release-iphoneos/Meow.app build/ipa/Payload/
(cd build/ipa && zip -qry Meow-unsigned.ipa Payload)
```

模拟器（不内嵌 JVM，用 `--api-base` 连 macOS 上的同一个 ApiServer 做 UI 验证）：

```bash
xcodebuild -project Meow.xcodeproj -scheme MeowSim -configuration Debug \
  -sdk iphonesimulator -derivedDataPath build/dd-sim \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
xcrun simctl launch <udid> com.meow.player.ios.sim --api-base=http://127.0.0.1:9978
```

CI：`.github/workflows/_ios.yml`（推 `feat/ios-jvm` 触发）——构建模拟器包、启动
macOS 宿主、截图、出未签名 IPA、上传 artifacts。

## 已知风险 / 待验证

1. **JDK 9 静态库是 2020 年的构建**（Oct4Pie/lib-openjdk-9-ios）。它能在
   iOS 15~18 上启动与否只能在真机验证；现代 iOS 的信号/线程差异可能要补丁。
2. **cacerts**：预编译包里是 32 字节占位文件；构建脚本会换成构建机的真实信任库
   （PKCS12）。若 CI 没装 JDK，HTTPS 会失败。
3. **JVM 进程内、不能隔离**：一个坏 jar 只能靠 JVM 异常边界；native 崩溃会带走 App。
4. **性能**：Zero 是解释器，比 JIT 慢 5–20 倍；HTML 解析/搜索扇出要在真机量。
5. **9000 个 node_modules 的 danmu_api** 没有塞进 JVM；弹幕先走
   `/api/proxy/danmaku` 的后端/内置路径，端内 Python/Node 聚合器不在本分支范围。

## 许可

端内 JVM 来自 OpenJDK 9（GPLv2 + Classpath Exception），属于**侧载实验**，
不用于 App Store 分发；详见 `THIRD-PARTY-NOTICES.md`。
