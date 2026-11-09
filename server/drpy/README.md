# drpy 运行时插件

把 `.js`（drpy）源接到 Node 里执行。后端不内置 JS 引擎，而是把请求转给这个进程。

## 为什么独立进程

- CatVod 上游自己就是外挂 Node 服务（`NodeRuntimeApi.SERVICE_CLASS = ...NodeService`）；
- drpy 脚本按 Node/QuickJS 的全局（`req` / `pdfh` / `pdfa`）编写，Node 下行为最一致；
- PC 发布包里本来就有 `node.exe`（danmu 插件带），Docker 侧加一个容器即可。

## 协议

后端发 `POST /{site}/{action}`，body 与 `/api/{site}/{action}` 完全一致，
另外两个头告诉运行时加载什么：

| 头 | 含义 |
|---|---|
| `X-DRPY-Api` | 脚本地址（绝对 http/https，或本地绝对路径） |
| `X-DRPY-Ext` | 站点 ext（URL 编码，避免中文乱码） |

运行时用 HTTP 状态 + JSON body 回应；脚本出错也返回 `200` + `{"code":-1,"msg":...}`，
这样后端只记一次"源失败"，不会当成运行时崩了。

## 远程模块策略（重要）

生态里 `drpy2.min.js` 是 ES 模块，除了 `assets://js/lib/*` 还会**纯副作用地**
`import` 三个混淆命名的远程脚本（实测为 `https://down.nigx.cn/qu.ax/{cLFE,kOUW,ucoN,XUKQ}.js`）。
默认策略：

| 环境变量 | 行为 |
|---|---|
| （默认） | 遇到远程 import 直接报错，说明缺哪个 |
| `DRPY_STRIP_REMOTE=1` | 当作空模块跳过（**不执行**远程代码） |
| `DRPY_ALLOW_REMOTE=1` | 真拉取并执行（有供应链风险，仅在明确信任时用） |

打包清单默认写 `DRPY_STRIP_REMOTE=1`。

## 已支持 / 未支持

已支持：`req`（同步 HTTP，含 `returnObj`）、`pdfh`/`pdfa`/`pd`（`a&&href`、`&&Text`、`:eq(n)` 这类链式选择器）、`joinUrl`、`md5`、`base64Encode/Decode`、`local`、`log`、`sleep`、`json2str`、`pick`。
模块：`assets://js/lib/x.js`（优先读插件 `lib/`，缺失时退到 npm 同名包）、npm 裸名、远程（受上表控制）。

已支持（2026-10-23 补齐）：**drpy2 按站规则文件**（`ext: "./js/xxx.js"` 或绝对 URL）。

规则文件的取值方式是「我们自己预取源码，再走 init 的字符串分支」，不交给引擎自己取——
引擎的 `request()` 会把结果吞成空串，表现为 `init` 成功但 `home` 永远空。

为对齐 CatVod 的 JS 宿主，运行时还做了几处契约修补（都有注释说明原因）：
`req()` 返回 `{code,headers,content}`（可字符串化）、vm 上下文内注入 `String.prototype.rstrip`、
`cheerio.jinja2` 模板渲染、`CryptoJS` 全局、`import` 默认导入兼容 CJS、
剥离远程模块时给递归桩、以及把引擎里的 `let d=[]` 改成 `var`（QuickJS 允许、V8 不允许的 var/let 冲突）。

未支持：`aes/rsa/jsp/xbpq` 等扩展算法（`CryptoJS` 已可用）、`openWeb`（需要浏览器）。

## 本地跑

```bash
cd server/plugins/drpy
npm install
DRPY_PORT=9330 node server.js
```

健康检查：`curl http://127.0.0.1:9330/health`
