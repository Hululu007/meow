# Fongmi 加载器内置化验证（2026-11-24，`feat/fongmi-loaders`）

> 目标：核实"直接参考 Fongmi 四套加载器，各端是否可以去掉 node/py 外挂插件"。
> 验证脚本：[`smoke/fongmi_loader_probe.py`](../smoke/fongmi_loader_probe.py)（本分支新增）
> 参考源码：`research/upstream/Fongmi-TV`（本地只读上游快照）

## 一、Fongmi 到底有几套加载器

源码 `app/.../api/loader/BaseLoader.java` 实查，**四套**（不是只吃 jar）：

| api 判据 | 加载器 | 引擎 | 执行位置 |
|---|---|---|---|
| `csp_` | `JarLoader` | ART / DexClassLoader | App 进程内 |
| 含 `.js` | `JsLoader` | **QuickJS**（`libquickjs-wrapper.so`） | App 进程内 |
| 含 `.py` | `PyLoader` | **Chaquopy / CPython**（`libchaquopy_java.so`） | App 进程内 |
| `node:` 开头 | `NodeLoader` | **Node.js**（`libnode.so`，独立 :node 进程） | 独立进程 |

运行时是**独立 APK 模块**：`com.fongmi.runtime.{python,nodejs,quickjs,thunder,mpv}`，
各自带 native 库，由 `RuntimeModule` 管理安装/签名校验/加载。

Python 模块自带 `base/spider.py` 和依赖（`chaquo/runtime/requirements.txt`）：
`lxml / pyquery / requests / pycryptodome / cryptography / beautifulsoup4 / certifi …`。

## 二、关键结论：不能"去掉外挂插件"，因为它们本来就是同一类东西

Fongmi 的 QuickJS / Python / Node **也是以独立运行时模块 APK 下发**的，并不是编译在主 App 里。
所谓"内置加载器"指的是 **`BaseLoader` 的四种分派逻辑**，运行引擎仍然由外挂模块提供。
也就是说：

- 我们现在的 drpy 插件（PC）、NodeService（TV）、pyrt（新增）↔ Fongmi 的 runtime 模块，**是同一个架构位置**。
- 差别只是 Fongmi 把引擎做成 Android 模块 APK，我们把引擎做成 PC 插件 / Docker 容器 / TV :node 进程。
- 真正可以"复用"的是**分派契约**（按 api 后缀选加载器），不是"把引擎塞进 App 就不用装运行时"。

## 三、实测：Fongmi 的 PyLoader 契约能否直接跑我们这批 .py

方法：用 Fongmi 真实的 `chaquo/src/main/python/base/spider.py`（不是我们的桩）+
最小 Java 桩（`com.github.catvod.Proxy` / `crawler.Spider`），并发跑 110 个脚本的 `searchContent`。
脚本：`smoke/fongmi_loader_probe.py`。

| 场景 | 有数据 | 主要失败原因 |
|---|---|---|
| Fongmi base 原样 | **13 / 110** | 81 空（站点失效为主）；5×`getCache` 缺失；2×`fetch`；2×`host`；1×`getProxyUrl` |
| 补 vbox 方法后（`--shim`） | **40 / 110** | 65 空（站点失效）；其余为 SSL/超时 |

**结论**：
1. Fongmi 的 Python 运行时**能执行**这批脚本（40 个有数据是证明）。
2. 但约 10 个脚本因 `base.spider` 契约不同（vbox 版有 `getCache/fetch/host`，Fongmi 版没有）直接异常——需要一层兼容 shim。
3. "空"的大头是站点本身失效/被墙（与我们 pyrt 实测一致，非运行时问题）。

## 四、JS 侧的契约差异（不能直接搬）

Fongmi 的 `JsLoader` 要求脚本是 **ES module + `export default class extends Spider`**，
由 `spider.js` 包装成 `homeContent/searchContent/playerContent`（见 `quickjs/src/main/assets/js/lib/spider.js`）。

我们这 14 个 vbox JS 是 `var spider = { __jsEvalReturn(){...} }` + 全局 `req/print`：

- 全局差异：Fongmi QuickJS 提供 `req / htmlQuery / sleep / proxyUrl / aesX / desX / rsaX…`（39 个绑定），**没有 `print`**（它用 `console`）；我们脚本 14/14 都用了 `print`。
- 导出差异：`__jsEvalReturn()` 形态 Fongmi 不认。

→ **JS 脚本不能直接在 Fongmi 上跑**，要转换：加 `const print=console.log` + 改成 ES module 类导出。
→ 反过来说，我们 drpy 侧已加的 `print` + `__jsEvalReturn` 兼容补丁是对的路线。

## 五、danmu_api 与 Fongmi 的关系

两边都用 Fongmi 兼容路由：
- 我们后端 `Bridge.installDanmakuHost` → `http://127.0.0.1:<node-port>/api/v2/fongmi/danmaku?name=&episode=`
- TV 的 NodeService 载荷就是 `danmu_api/server.js`（`RuntimePayloadHost.PKG_ID=danmu-payload`）
- 上游 `danmu_api/worker.js:132` 已实现 `/api/v2/fongmi/danmaku`

这部分**已经对齐**，不需要改。

## 六、最终判断

| 问题 | 答案 |
|---|---|
| 参考 Fongmi 四加载器，各端能去掉 node/py 插件吗？ | **不能**。Fongmi 的四套也是"运行时模块 APK"外挂；引擎不可能凭空存在 |
| 我们能复用什么？ | ① 按 api 后缀分派的契约（已一致）；② Python 依赖清单（可照抄进 pyrt 镜像）；③ `base.spider` 契约差异表（做 shim） |
| 必须保留什么？ | PC 的 drpy 插件、TV 的 NodeService、新增的 pyrt 运行时 |
| Python 源要不要适配 Fongmi base？ | 要：补 `getCache/fetch/host/getProxyUrl` shim（本分支验证脚本已能测） |
| JS 源要不要转 ES module？ | 要：给 Fongmi 用时转成 `export default class extends Spider` + `print=console.log` |

## 七、验收复现

```bash
# 无 shim（Fongmi base 原样）
python smoke/fongmi_loader_probe.py --scripts <py目录>

# 有 shim（补 vbox 方法后）
python smoke/fongmi_loader_probe.py --scripts <py目录> --shim
```

输出含每个脚本的 stage（search/empty/exception）与 top_errors，13/110 与 40/110 为本轮实测。
