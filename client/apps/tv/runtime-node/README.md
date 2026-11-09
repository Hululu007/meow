# runtime-node —— TV 端 node 运行时模块（APK）

形态照搬 Fongmi：**不是**塞进主包的 .so，而是一个独立安装的 APK，
宿主动态加载它。

## 为什么必须是"装成 APK"

Android 10+ 禁止从可写目录 dlopen。装成 APK 后 so 位于只读的
`/data/app/.../base.apk!/lib/<abi>/`，动态链接器才能加载。
宿主的做法：

```java
new DexClassLoader(moduleApk, odexDir, moduleApk + "!/lib/" + abi, hostLoader)
```

模块内的 `System.loadLibrary("meow_node_bridge")` 用这个 searchPath，
于是桥 .so + 它 DT_NEEDED 的 libnode.so + libc++_shared.so 一起被解析。

## 构建

```bash
# 1) 放预编译 libnode.so（nodejs-mobile 18.20.4）
#    https://github.com/nodejs-mobile/nodejs-mobile/releases
#    解压后 bin/<abi>/libnode.so → src/main/jniLibs/<abi>/
# 2) 编 JNI 桥（不走 CMake，见脚本注释）
./build-bridge.sh
# 3) 出 APK
gradle :runtime-node:assembleDebug
```

`build.gradle` 的 `abiFilters` 当前只有 `x86_64`（MuMu 试点）。
上真机时加 `arm64-v8a` / `armeabi-v7a` 并补对应 libnode.so。

## 已验证（2026-11-06，MuMu x86_64 / Android 15）

| 项 | 结果 |
|---|---|
| 模块安装 + 宿主识别 | ✅（需 `<queries>`，否则 AppsFilter BLOCKED） |
| DexClassLoader 跨 APK 加载 | ✅ |
| JNI 桥调 `node::Start` | ✅ |
| node 起服务 | ✅ v18.20.4，监听 127.0.0.1:19340 |
| **worker_threads + Atomics.wait** | ✅ `{ok:true, wait:"ok", value:42}` |

## 版本兼容契约（2026-11 定）

模块不是独立产品：它被宿主用 `DexClassLoader` 加载，并**实现宿主里那份
`com.meow.runtime.NodeRuntimeApi`**（见 `plugin-api/`）。因此：

| 变更 | 要不要动模块 | 要不动壳 |
|---|---|---|
| 改载荷（`node-payload-danmu.zip`）/ 桥 / node 版本 | ✅ 重出三个 ABI | 不用（载荷在壳里，壳会重新解包） |
| 改 `NodeRuntimeApi`（加方法/改签名） | ✅ 主版本 +1 | ✅ 新壳仍要兼容老模块，或设 `min_app_version` 抬高门槛 |

**硬约定**

1. `NodeRuntimeApi` 只增不改：新增方法给默认实现，或走"能力探测"（`instanceof` 子接口），
   **不要**直接改已有签名 —— 否则老模块在新壳上直接 `AbstractMethodError`。
2. 清单里模块条目带 `min_app_version`（= 第一个支持运行时模块的壳版本，现为 `1.1.0`）
   与 `min_sdk`（26）。客户端在**下载前**就比对，不满足直接禁用按钮并说明原因。
3. 真出现不兼容（接口改了却没抬头版本），`NodeService` 会把
   `AbstractMethodError/NoSuchMethodError` 翻成「模块与当前应用不兼容（接口已变更），请更新运行时模块」。
