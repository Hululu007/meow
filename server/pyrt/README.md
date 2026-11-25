# pyrt · Python 源侧车

给 meow 后端当 `jsRuntime` 用的 Python 运行时。**一个地址同时服务两种源**：

| 源类型 | 处理 |
|---|---|
| `.js` / `.mjs` / `js:<内联>` | 原样转发给 drpy（`PYRT_DRPY`） |
| `.py` | 本地 CPython 执行 |

协议与 drpy 完全同形，所以后端、前端、配置都不用改分派逻辑：

```
POST /{site}/{action}
X-DRPY-Api: <脚本地址，URL 编码>
X-DRPY-Ext: <站点 ext，URL 编码，可选>
Body:       {"wd": "...", "quick": false, "pg": "1"} 等
```

## 为什么是"路由器"而不是新增一个 policy 键

后端只认 `policy.json` 的 `jsRuntime` 一个地址。让 pyrt 接管这个地址、
内部再按 api 后缀分流，Java 侧一行都不用改；反过来新增 `pyRuntime` 键
要动 shared 源码（JVM/Android 两端都编），且要维护两套健康检查与熔断。

## 三种部署形态

### 1. PC 插件

`server/plugin-manifests/pyrt.manifest.json`，与 drpy 并列。要求本机有 Python 3.9+。

```bash
pip install -r server/pyrt/requirements.txt
```

插件启动时把 `jsRuntime` 写进 policy.json。

### 2. Docker 容器

`deploy/docker/Dockerfile.pyrt` + `docker-compose.yml` 的 `pyrt` 服务。
源脚本挂到 `/data/py-scripts`（不进镜像）。

### 3. 飞牛 fpk

`install_dep_apps` 里有 `python312` 时装（官方文档：
`install_dep_apps=python312` → `/var/apps/python312/target/bin/python3`）。
三方包用 venv 装到应用目录，不污染系统 Python：

```bash
python3 -m venv "$TRIM_APPDEST/py-venv"
"$TRIM_APPDEST/py-venv/bin/pip" install -r requirements.txt
```

`meowd` 的 `Deps::python_path()` 已把 `python312`/`python311`/`python310`/`python3`
都纳入探测，装完不用重启应用（设置页「运行时 → 重新检测」会热重扫）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PYRT_PORT` | `19331` | 监听端口 |
| `PYRT_BIND` | `127.0.0.1` | 容器里必须改 `0.0.0.0`，否则跨容器连不上 |
| `PYRT_DRPY` | `http://127.0.0.1:19330` | `.js` 转发目标 |
| `PYRT_SCRIPTS` | `<pyrt.py>/scripts` | 脚本根目录，其下需有 `py/` 与 `base/` |

## 目录结构

```
server/pyrt/
├── pyrt.py              # 侧车主程序（入库）
├── requirements.txt     # 依赖（入库）
├── scripts/
│   ├── base/spider.py   # vbox 基类契约（入库）
│   └── py/*.py          # 各站点实现（.gitignore，由源包导入）
```

`scripts/py/` 是私有内容，与 `spider.jar` / `config.sites.json` 同性质，
不入公开库。

## 实测记录（2026-11-25）

```
1) .py 本地执行
   list: 40 first: 小少婦背著老公出來掙外快,叫聲淫蕩口活一
2) .js 转发 drpy（内联脚本）
   {"list":[{"vod_id":"f1","vod_name":"forward-ok:hello"}]}
```

两个真 bug 是这一轮修掉的：
- `forward_drpy(handler, body)` 里写成 `handler.get(...)`，Handler 没有这个方法
  （应为 `handler.headers.get`）→ 所有 `.js` 转发报
  `'Handler' object has no attribute 'get'`
- `.js` 判据只看 `endswith(".js")`，漏了带 query 的 `a.js?v=3` 和 `js:` 内联形式
  → 这些 api 被判成 py 路径去 import，报 `py script not found`
