# 加密 Guard 壳（aiwex / wex 系）JVM 加载器

`assets/*guard_v*.so` + `assets/*shinidie.guard` 这类加固壳的 spider jar，JVM 端不能
`System.load` ARM .so。这里用两段子进程把它变成普通 class jar：

1. **GuardShellMain**：unidbg 跑壳的 ARM so → `DexNative.getLoader(Context)` →
   壳写出的 `sharedb/config.db`（明文 zip）→ `dex2jar -r` → `GuardRepair`
   （按解密后的 dex 还原 `new-instance` 类型、补缺失构造/父类构造链、重算栈帧）。
2. **GuardServeMain**：装载明文 jar、`InitOrigin.init` + wex 远程配置，暴露本地
   socket 入口；ApiServer 通过 `Jars.forwardGuard()` 把 guard 站点转发进来。

**为什么站点调用不直接在 ApiServer 进程里跑**：宿主自己的 HTTP 栈/线程池会让壳的
`y0.g` 请求被中断（实测：同一 payload，独立进程 search→detail→play 全通，ApiServer
内恒空）。所以 guard 站点走 companion；companion 的请求**必须在 main 线程串行处理**，
换到工作线程同样会写超时（实测）。

## 构建

```bash
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File server/tools/guard/build-guard-helper.ps1
# Linux / Docker / fpk
sh server/tools/guard/build-guard-helper.sh
```

产物：`server/host/guard-libs/guard-helper.jar`。
`guard-libs/` 里是 unidbg 0.9.9 + **unidbg-unicorn2 0.9.9** + unicorn 1.0.15 + dex2jar 2.4 + ASM
（源目录约 34MB，**构建期按目标平台裁剪到 15~16MB**，见下节），**不要**
放进 `server/host/libs/`（宿主 javac 不需要）；PC 插件/Docker/fpk 构建脚本会自动
把它复制到 `apiserver.jar` 同级的 `guard-libs/`，并按目标平台裁剪。

## 按平台裁剪原生库（2026-11-25）

六个 jar 里约 18MB 是"别的 CPU 平台"的 `.so/.dll/.dylib`，运行期永远不会被打开
（`NativeLoader` 只按 `os.name`/`os.arch` 选一个目录；keystone/capstone/jna/demumble
同理）。构建期用 `trim-guard-libs.sh|ps1` 裁掉，1.2.22 实测 34MB → 15~16MB：

| 目标 | 保留（jar 内路径） | 谁在用 |
|---|---|---|
| `win-x64` | `unicorn-1.0.15`: `natives/windows_64/`；`unidbg-unicorn2`: 无；`keystone`: `win32-x86-64/`；`capstone`: `win32-x86-64/`；`jna`: `com/sun/jna/win32-x86-64/`；`demumble`: 无 | PC 插件（`build-plugin.ps1`） |
| `linux-x64` | `unidbg-unicorn2`: `natives/linux_64/`；`unicorn-1.0.15`: 无；`keystone`: `linux-x86-64/`；`capstone`: `linux-x86-64/` + `natives/linux_64/`；`jna`: `com/sun/jna/linux-x86-64/`；`demumble`: `natives/linux_64/` | Docker 构建阶段 |
| `linux-arm64` | 同 linux-x64，平台名换 `linux_arm64` / `linux-aarch64` | fpk arm（`build-fpk.sh`） |

★ **unicorn 的两份原生库不能搞反**：Linux 走 unicorn2（`libunicorn.so` 自包含），
Windows 走默认 legacy（`unicorn_java.dll`）。这也是上面"Linux 必须用 unicorn2"那段的
另一半：把 legacy 的 natives 留在 Linux 上没用（`libunicorn_java.so` 加载会
`undefined symbol: helper_div_i32`），把 unicorn2 的留在 Windows 上也没用。

裁剪后必须跑 `jvm.GuardNativeProbe`（已接进三个打包脚本）：它按平台加载对应的
unicorn，并用 JNA `NativeLibrary.getInstance` 真正 dlopen `keystone` / `capstone`
（静态块里的失败会被上游吞掉，不能只 `Class.forName`），缺任一库构建期即红。

**Linux 必须用 unicorn2 后端**：`unicorn-1.0.15.jar` 的 `linux_64/libunicorn_java.so`
是瘦身版（1.8MB，`AES_isbox`/`helper_div_i32` 未定义，`System.load` 直接失败）；
`unidbg-unicorn2` 自带自包含 `libunicorn.so`（linux/x86_64、linux/arm64、win、mac），
`GuardShellMain` 在 Linux 上清掉默认 backend 列表并 `addBackendFactory(new Unicorn2Factory(true))`。
Windows 保持默认 unicorn1（DLL 正常），不要盲目全平台切 unicorn2。

## 缓存

- `data/guard/payload-r<REPAIR_VERSION>-<壳 md5>.jar`：解密+修复后的 class jar。
- **改 `GuardShellMain` / `GuardRepair` 后必须把 `GuardShell.REPAIR_VERSION` +1**，
  否则旧缓存会继续命中（`payload-r2-` 的 `r2` 就是版本号）。
- 解密日志：`data/guard/decrypt-r<ver>-<md5>.log`；companion 日志：
  `data/guard/serve-<payload>.log`。

## 配置

- `-Dmeow.guard.proxyPort=<port>`：覆盖壳 `ProxyOrigin` 的本地代理端口（默认取
  `Jars.proxyPort()`，即 ApiServer 端口）。壳的 danmaku/网盘代理会拼
  `http://127.0.0.1:<port>/proxy?...`；搜索/详情/直链播放不依赖它。
- 壳识别：`Jars.reload()` 里 `GuardShell.isGuard()`（`assets/*.guard` + `*guard_v*.so`）。
- 站点类名：`csp_XxxGuard` → payload 的 `Xxx`（`Jars.load()` 自动去 Guard 后缀）。
- companion 端口：临时端口，`GuardShell` 启动时读 `PORT=`。

## 已验证 / 未覆盖

- ✅ Wex 系（WexAiDuBoKu 等）：JVM 搜索/详情/播放全链路，结果与 Android 逐字一致；
  PC（Windows JVM）与 Docker（Linux x86_64）同一套代码。
- ⚠️ AiNew 系的部分站点：解密/加载成功，但 HTML 解析路径仍受 dex2jar 寄存器复用
  影响；需要继续补 `GuardRepair` 的规则，不是逐站适配。
- ⚠️ `LoadNiMa` / `MyCrypto` 的 native 方法：Wex 搜索/详情/播放未触发；若某站触发，
  需要把 xiugou-tv 的纯 Java 替身/ unidbg crypto 服务补进来（按壳家族，不是按站）。
