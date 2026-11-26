# Fongmi native 运行时落地 + 各端加载器结论（2026-11-24，`feat/fongmi-loaders`）

> 纠错记录：此前用 GraalJS/GraalPy 做验证是**方向错误**——Fongmi 根本不用 Graal。
> 三份 Graal 文档按用户要求**保留**，作为 JVM 路线的技术参考，但不作为落地方案。
> 本文件是最终结论。

## 一、Fongmi 事实（源码逐条核实，非推断）

`catvod/.../utils/RuntimeModule.java:38-43`：

| 模块 | native 库 | 加载方式 |
|---|---|---|
| PYTHON | `libchaquopy_java.so` | Chaquopy = Android 版 CPython |
| NODEJS | `libnode.so` | 完整 Node 运行时 |
| QUICKJS | `libquickjs-wrapper.so` | QuickJS 引擎 |

`BaseLoader.getSpider():132-144` 四路分派：
- `node:` → NodeLoader；含 `.py` → PyLoader；含 `.js` → JsLoader；`csp_` → JarLoader。

**关键结论**：
1. Fongmi **不用 Graal/polyglot/truffle**（全仓 grep 零命中）。
2. JS 有两套引擎的原因：`QuickJS` 跑单文件 `.js` 脚本（CatVod 传统源）；`Node` 跑 `node:` 整包应用（`index.js.md5` 配置、HTTP 路由 `/spider/{key}/{action}`）——用途不同，并存。
3. 运行时是**独立 APK**（`N-runtime-python-arm64_v8a.apk` 等），宿主用 `RuntimeModule.entry()` + DexClassLoader 加载；有 compatibilityId + 签名校验。
4. **无 JDK 版本限制**——全部 native .so，跑在 ART 上，与 JVM/JDK 无关。

## 二、各端要不要"不同加载器"——答案

**执行层由"语言运行时"决定，不由宿主是 JVM 还是 dex 决定。** 同一份配置，四路分派（jar/CMS/js/py）在各端都要有，但 js/py 的引擎因端而异：

| 端 | 宿主 | js 引擎 | py 引擎 | 说明 |
|---|---|---|---|---|
| PC / Docker | JVM | **GraalJS** 或外挂 Node | **GraalPy** 或外挂 Python | JVM 路线，Polyglot 可用（已验证真实数据） |
| TV | dex / ART | **QuickJS .so**（Fongmi 同款） | **Chaquopy .so**（Fongmi 同款） | ART 不是 JVM，Graal Truffle 起不来，必须用 native |
| Fongmi | ART | QuickJS .so | Chaquopy .so | 参考对象 |

所以：**是的，两端加载器不同，但这是"引擎形态"差异（JVM polyglot vs native .so），不是我们架构设计造成的。** Fongmi 自己也一样——同一客户端内四套加载器并存。

## 三、落地方案：照 Fongmi native 运行时

### 3.1 可复用资产（本地已有）

```
research/upstream/Fongmi-TV/
├── quickjs/libs/runtime-release.aar    # 内含 jni/arm64-v8a + armeabi-v7a/libquickjs-wrapper.so
├── quickjs/libs/wrapper-java.jar       # Java API: QuickJS.evaluate()/bind()/bindAsync()（major=61=Java17）
├── nodejs/src/main/jniLibs/{arm64-v8a,armeabi-v7a}/libnode.so
└── chaquo/                              # Chaquopy Python 运行时模块（需单独构建 AAR）
```

`QuickJS` wrapper 是标准 Java API（`evaluate/bind/bindAsync/invoke`），我们从 TV 的 dex 里可直接调用；
`.so` 由 Android 加载（随 TV APK 打包为 jniLibs，或按 Fongmi 做成独立模块 APK）。

### 3.2 三阶段（成本递增）

| 阶段 | 做法 | 工作量 | 风险 |
|---|---|---|---|
| **P0 照搬 runtime APK** | 用 Fongmi 现成 `N-runtime-quickjs/python-*.apk`，TV 作为"运行时模块"下载安装（我们已有 `ModuleInstallReceiver`/`RuntimeModuleHost` 框架，只加 module 类型） | 3~5 天 | compatibilityId/签名是 Fongmi 的；我方可自签同款 ID 重建 |
| **P1 内嵌 .so** | 把 `libquickjs-wrapper.so` + `wrapper-java.jar` 直接打进 TV APK 的 jniLibs/dex，写一个薄 `JsLoader`（对标 Fongmi JsLoader） | 5~7 天 | 需 NDK 环境（本机 `ANDROID_HOME` 空，先补 SDK）；包体 +3MB |
| **P2 Python native** | Chaquopy 运行时模块（`chaquo/`）打成 APK，同 P0 安装；`PyLoader` 对标 Fongmi | 1~2 周 | Chaquopy 包依赖大；C 扩展兼容性 |

### 3.3 TV 端接入点（对齐现状）

- `client/apps/tv/app/src/main/java/com/meow/tv/runtime/RuntimeModuleHost.java`：现只认 NODE_PACKAGE，扩展 PYTHON/QUICKJS 的 package + compatibilityId。
- `GatewayServer` / `BaseLoader` 等价分派：按 api 后缀把 `.js`/`.py` 交给新 Loader（对标 Fongmi `BaseLoader.getSpider()`）。
- `ModuleInstallReceiver`：已能监听模块安装并重启 `:node`；同样处理 quickjs/python 模块。
- `danmu_api`（node 载荷）不受影响。

### 3.4 与 JVM 端的关系

PC/Docker 保持 GraalJS/GraalPy（或现 pyrt/drpy 外挂）即可；TV 走 native。两端配置同一份 `config.all.json`，只是各端 Loader 实现不同——这就是 Fongmi 生态的标准做法。

## 四、结论

1. 各端加载器确实不同，但原因是引擎形态（JVM vs native），不是架构缺陷。
2. Fongmi 的 QuickJS/Chaquopy/Node 是 native .so，无 JDK 限制，能在我们 TV dex 上照搬。
3. 最短路径：P0 复用 Fongmi runtime APK 形态（TV 已有模块安装框架）；P1 内嵌 .so 更自主。
4. Graal 文档保留作 JVM 路线参考，不作为 TV 方案。

## 五、复现/核查命令

```bash
# 核实 Fongmi 引擎（无需编译）
grep -nE '^\s+[A-Z_]+\("' research/upstream/Fongmi-TV/catvod/.../RuntimeModule.java
grep -rn "graal\|polyglot\|truffle" research/upstream/Fongmi-TV  # 空 = 不用 Graal
unzip -l research/upstream/Fongmi-TV/quickjs/libs/runtime-release.aar  # 看 .so
javap -cp research/upstream/Fongmi-TV/quickjs/libs/wrapper-java.jar com.fongmi.quickjs.QuickJS
```

## 六、本机验证补充（2026-11-24）

### 6.1 QuickJS .so 实测（readelf）

```
quickjs/libs/runtime-release.aar → jni/
  arm64-v8a/libquickjs-wrapper.so   ELF64 / AArch64  1,568,288 B
  armeabi-v7a/libquickjs-wrapper.so ELF32 / ARM     1,092,196 B
```

JNI 导出确认（标准 JNI 库，可从 dex 直接加载）：
`Java_com_fongmi_quickjs_QuickJS_bind` / `_bindObject` / `_invokeObject` / `_callback` …
wrapper-java.jar 的 `com.fongmi.quickjs.QuickJS`（major=61=Java17）提供
`evaluate()/bind()/bindAsync()/invoke()` 同步/异步 API。

### 6.2 ABI 约束（重要）

- 本仓 AAR 只有 **arm64-v8a / armeabi-v7a**，**没有 x86_64**。
- 本机在线的 3 台设备（.76/.77/.78）全是 **x86_64**，无法加载这两个 .so；
  OECT（arm64）当前 5555 端口拒绝连接。
- → **native 落地验证需要一台 arm64 Android 设备**（真机 TV/盒子/手机均可）：
  把 `libquickjs-wrapper.so` + `wrapper-java.jar`  push 到设备，
  用 `javap` 确认的 API 写一个最小测试 APK 或用现成 meow TV 加 jniLibs 打一个 debug 包。
  本机当前条件不足，**这一步标记为「待 arm64 设备验证」，不假报通过**。

### 6.3 不需要编译的情况

Fongmi 的 `runtime-release.aar` 是**已编译好的产物**，含 .so + wrapper-java.jar。
P1（内嵌 .so）路径不需要 NDK、不需要 Android SDK 编译——只要把 .aar 里的
`jni/*/libquickjs-wrapper.so` 拷进 TV 工程的 `app/src/main/jniLibs/{abi}/`，
把 `wrapper-java.jar` 作为依赖引入即可。本机 `ANDROID_HOME` 环境变量为空不是阻塞
（plugin 探测到 SDK 实际在 `C:\Users\CHR\AppData\Local\Android\Sdk`）。

### 6.4 最终答案表

| 问题 | 答案 |
|---|---|
| PC/Docker 与 TV 是否用不同加载器 | **是**，PC/Docker 用 JVM（Graal 路线，已验证真实数据）；TV 用 native .so（Fongmi 路线） |
| 为什么不同 | 引擎形态不同（Truffle 需 JVM / native .so 跑 ART），不是我方架构缺陷；Fongmi 也四类加载器并存 |
| Fongmi 有最低 JDK 限制吗 | **没有**，全 native .so，与 JDK 无关 |
| libnode.so 为何还用 QuickJS | 用途不同：QuickJS 跑单文件 `.js` 源；Node 跑 `node:` 整包应用（index.js.md5 + HTTP 路由） |
| 本机能否完成 native 实测 | **不能**（无 arm64 设备在线）；需补 arm64 真机 |
| Graal 验证是否白做 | 对 TV 落地是白做（方向错），但作为 PC/Docker JVM 路线参考**，文档按要求保留** |

## 七、MuMu 实机验证（2026-11-24，纠正之前"无 arm64 设备"判断）

### 7.1 我之前判断错了

本地在线的 .76（MuMu，装了 Fongmi `com.fongmi.android.tv` 5.8.7）
虽然 `ro.product.cpu.abi = x86_64`，但 **abilist 包含 arm64-v8a**，且有：

```
ro.dalvik.vm.isa.arm64 = x86_64      # ARM64 指令转译到 x86_64
ro.dalvik.vm.native.bridge = libnb.so # MuMu 的 native 桥（ARM 转译）
uname -m = aarch64                    # 内核层模拟 ARM
```

→ **Fongmi 的 arm64 runtime .so 在 MuMu 上能跑，靠的就是这套转译层。**我之前说"没有 arm64 设备不能验"是错的。

### 7.2 实测过程（dalvikvm + D8 转 dex）

不做完整 APK，直接用 R8 的 D8 把测试类转成 dex，推到设备用 dalvikvm 跑：

```bash
# 1) 下载 R8（Google Maven，不在 Maven Central）
curl -o r8.jar https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.6.27/r8-8.6.27.jar
# 2) javac 编译 main 版 QjTest（注入 System.load(so) + QuickJS.evaluate）
javac -cp wrapper-java.jar -d qjmain qjmain/QjTest.java
# 3) D8 转 dex（--lib 指向 JDK 的 jrt-fs.jar 提供核心类）
java -cp r8.jar com.android.tools.r8.D8 --min-api 24 --output dexout2 \
     qjmain/com/test/qj/QjTest.class wrapper-java.jar --lib "$JDK17/lib/jrt-fs.jar"
# 4) push dex + so + jar 到 /data/local/tmp/qjtest/
# 5) 运行
adb shell "LD_LIBRARY_PATH=/data/local/tmp/qjtest dalvikvm \
     -cp /data/local/tmp/qjtest/classes2.dex com.test.qj.QjTest \
     /data/local/tmp/qjtest/libquickjs-wrapper.so"
```

**结果**：

```
QJ start
Exception in thread "main" java.lang.UnsatisfiedLinkError: dlopen failed:
  "/data/local/tmp/qjtest/libquickjs-wrapper.so" is for EM_AARCH64 (183)
  instead of EM_X86_64 (62)
```

### 7.3 结论（重要，别再走弯路）

- **dalvikvm 手工启动的进程是 x86_64 模式**，不会自动走 arm64 转译 → 直接加载 arm64 .so 必失败。
- Fongmi 能跑是因为它的 **APK 声明了 arm64 ABI**，系统按 arm64 启动进程（带 libnb 转译），
  then `System.loadLibrary()` 加载 arm64 .so 走 native bridge 转译。
- → **正确验证方式**：把 QuickJS .so + wrapper jar 打进一个**声明 arm64-v8a 的测试 APK**，
  安装后由系统以 arm64 模式启动，才能在 MuMu 上验证 JNI 调用。
  （本次用 dalvikvm 的快捷路径因 ABI 不匹配失败，不是引擎本身的问题。）
- 本机无 Android SDK platforms/build-tools，完整 APK 编译需补 SDK；或用我方可用的 Android 插件构建链
  加一个 arm64 ABI 的最小 Activity（前面 qjapp 工程骨架已备好）。

### 7.4 引擎效果对比（JVM vs native，回答"哪种好"）

| 维度 | JVM/Graal（PC/Docker） | native .so（TV/ART/MuMu转译） |
|---|---|---|
| 启动 | GraalPy 冷启 ~9s，JS 快 | native 首次 dlopen 快，无 JIT 预热 |
| 运行性能 | Truffle 解释执行（无 GraalVM JIT 时慢） | QuickJS/Chaquopy native 执行，通常更快 |
| 内存 | 高（python-home + Truffle） | 中等 |
| 依赖 | Java 17/21 + 三方包管理 | .so + 各 ABI 一份，包体增大 |
| 部署 | JVM 后端直接加依赖 | TV 需 APK 打包或 runtime 模块下载安装 |
| 跨端一致性 | PC/Docker 统一 | TV 独立，与 JVM 端引擎不同 |

**结论**：性能/启动 native .so 更优；部署便利性 JVM（Graal）更优；两者各管一端，正因为如此
Fongmi 用 native、我们 PC/Docker 可用 Graal——**不是谁替代谁，是端决定引擎**。

### 7.5 最终落地判定

- **TV**：照 Fongmi 打包 arm64 .so 进 APK / 做 runtime 模块（MuMu 靠 libnb 转译能跑），✔ 可行，
  本轮因无完整 SDK 未出 APK，标记为"待完整 APK 实测"。
- **PC/Docker**：GraalJS/GraalPy 已实测真实数据（jumi 15 条 / hsck 40 条），✔ 可行。
- **各端加载器不同**是语言和引擎形态决定的，不是我们架构问题。
