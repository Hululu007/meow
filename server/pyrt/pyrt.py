# -*- coding: utf-8 -*-
"""Python 源侧车：与 drpy 运行时同协议，给 meow 后端当 jsRuntime 用。

  POST /{site}/{action}
    X-DRPY-Api  脚本地址（URL 编码）：.js -> 转发给 drpy；.py -> 本地执行
    X-DRPY-Ext  站点 ext（URL 编码）

为什么做成"路由器"而不是新加一个 policy 键：
  后端只认 policy.json 的 jsRuntime 一个地址；把 .js 转发给 drpy(19330)、
  .py 自己执行，就不必改 Java 侧分派（改动面最小）。
"""

import importlib.util
import json
import os
import sys
import threading
import traceback
import urllib.parse
import urllib.request
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

"""
vbox 客户端本身给 requests 打了「代理 + verify=False」补丁（上游逆向文档原文），
这批站点大量用过期/自签证书（实测 91porna 直接 SSLError）。侧车保持同样行为，
否则明明客户端能用的源在我们这里全是证书错。
"""
warnings.filterwarnings("ignore")
try:
    import requests as _requests

    _orig_request = _requests.Session.request

    def _insecure_request(self, method, url, **kwargs):
        kwargs.setdefault("verify", False)
        return _orig_request(self, method, url, **kwargs)

    _requests.Session.request = _insecure_request
except Exception:
    pass

PORT = int(os.environ.get("PYRT_PORT", "19331"))
"""
监听地址。桌面/插件跑回环（默认），容器里必须 0.0.0.0 —— 否则跨容器
（apiserver → http://pyrt:19331 走网桥）连不上，表现是"容器健康但源全超时"。
与 drpy 的 DRPY_BIND 同一个坑，同一个解法。
"""
BIND = os.environ.get("PYRT_BIND", "127.0.0.1")
DRPY_UPSTREAM = os.environ.get("PYRT_DRPY", "http://127.0.0.1:19330").rstrip("/")
HERE = os.path.dirname(os.path.abspath(__file__))
"""
脚本根目录。默认 `<pyrt.py 所在目录>/scripts`；容器/插件把数据卷挂进来即可。

为什么单独给环境变量：源脚本是**私有内容**（不入公开库），加载器本身要入库。
部署时脚本放数据卷（如 `/data/py-scripts`）、代码放镜像，两者生命周期不同——
改源不用重建镜像，升级镜像也不会冲掉用户导入的源。
"""
SCRIPTS_DIR = os.environ.get("PYRT_SCRIPTS") or os.path.join(HERE, "scripts")
PY_DIR = os.path.join(SCRIPTS_DIR, "py")
BASE_DIR = SCRIPTS_DIR

sys.path.insert(0, BASE_DIR)
sys.path.insert(0, PY_DIR)
"""
镜像/插件自带的 scripts 目录永远在 sys.path 上。

为什么必须加这一条：容器里 `PYRT_SCRIPTS=/data/py-scripts`（数据卷），
于是 `sys.path` 只有数据目录。而 `base/spider.py` 是**随镜像发布**的
（在 /app/scripts/base），数据卷里通常没有 —— 挂上卷之后
`from base.spider import Spider` 就 ImportError，所有 .py 源全挂，
但 /health 仍然 ok（它是纯静态响应），非常难查。
数据目录里有同名 base 时仍优先用数据目录的（insert 在更前面）。
"""
_DEFAULT_SCRIPTS = os.path.join(HERE, "scripts")
if _DEFAULT_SCRIPTS not in sys.path:
    # append 而不是 insert(0)：数据目录里的 base 优先，镜像自带只作兜底
    sys.path.append(_DEFAULT_SCRIPTS)
# 插件包自带依赖（pip --target vendor），不要求用户先装到系统 Python。
# 目录不存在时静默跳过：开发机上用系统 site-packages 更方便。
_VENDOR = os.path.join(HERE, "vendor")
if os.path.isdir(_VENDOR):
    sys.path.insert(0, _VENDOR)

_lock = threading.Lock()
_instances = {}
_seq = 0


def log(*a):
    print("[pyrt]", *a, flush=True)


def load_spider(api, ext):
    """按 (脚本路径, ext) 缓存实例；ext 变了要重新 init。"""
    if not os.path.isabs(api):
        api = os.path.join(PY_DIR, api)
    if not os.path.exists(api):
        raise FileNotFoundError("py script not found: " + api)
    key = api + "|" + (ext or "")
    with _lock:
        if key in _instances:
            return _instances[key]
    global _seq
    _seq += 1
    name = "_pyrt_%d_%s" % (_seq, os.path.splitext(os.path.basename(api))[0])
    spec = importlib.util.spec_from_file_location(name, api)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    cls = getattr(mod, "Spider", None)
    if cls is None:
        raise RuntimeError("no Spider class in " + api)
    sp = cls()
    init = getattr(sp, "init", None)
    if callable(init):
        try:
            init(ext or "")
        except Exception as e:
            log("init warn", os.path.basename(api), type(e).__name__, str(e)[:120])
    with _lock:
        _instances[key] = sp
    log("loaded", os.path.basename(api))
    return sp


def _params(fn):
    """取位置参数列表 [(name, default)]（排除 self），拿不到就返回 None。"""
    try:
        import inspect
        return [(p.name, p.default) for p in inspect.signature(fn).parameters.values()
                if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.name != "self"]
    except Exception:
        return None


def _call_named(fn, values):
    """按函数签名的参数名逐个填值；未知参数用默认值/空串。

    这批脚本签名不统一（实测 searchContent 有 (key)/(key,quick)/(key,quick,pg) 三种，
    pg 的默认值还有 int 1 和 str "1" 两种）。按名字填比按位置猜稳。
    """
    import inspect
    params = _params(fn)
    if params is None:
        return fn(*values.get("_fallback", []))
    args = []
    for name, default in params:
        if name in values:
            v = values[name]
            if name in ("pg", "page") and isinstance(default, int) and not isinstance(default, bool):
                try:
                    v = int(v)
                except Exception:
                    pass
            args.append(v)
        elif default is inspect._empty:
            args.append("")
        else:
            break
    return fn(*args)


def dispatch(sp, action, body):
    b = body or {}
    if action == "home":
        fn = getattr(sp, "homeContent", None)
        if not callable(fn):
            return {}
        return fn(False)
    if action == "category":
        fn = getattr(sp, "categoryContent", None)
        if not callable(fn):
            return {}
        return _call_named(fn, {
            "tid": str(b.get("tid") or b.get("id") or ""),
            "id": str(b.get("tid") or b.get("id") or ""),
            "pg": str(b.get("pg") or b.get("page") or "1"),
            "page": str(b.get("pg") or b.get("page") or "1"),
            "filter": bool(b.get("filter")),
            "extend": b.get("extend") or {},
        })
    if action == "search":
        fn = getattr(sp, "searchContent", None)
        if not callable(fn):
            return {}
        key = str(b.get("wd") or b.get("key") or "")
        return _call_named(fn, {
            "key": key, "wd": key, "searchkey": key,
            "quick": b.get("quick") is True,
            "pg": str(b.get("pg") or "1"),
            "page": str(b.get("pg") or "1"),
            "_fallback": [key],
        })
    if action == "detail":
        fn = getattr(sp, "detailContent", None)
        if not callable(fn):
            return {}
        ids = b.get("ids")
        if not isinstance(ids, list):
            ids = [b.get("id") if b.get("id") is not None else ids]
        ids = [str(x) for x in ids]
        return _call_named(fn, {"ids": ids, "id": ids, "array": ids,
                                "_fallback": [ids]})
    if action == "play":
        fn = getattr(sp, "playerContent", None)
        if not callable(fn):
            return {}
        flag, vid = str(b.get("flag") or ""), str(b.get("id") or "")
        return _call_named(fn, {
            "flag": flag, "id": vid, "url": vid, "vodId": vid,
            "vipFlags": b.get("vipFlags") or [],
            "_fallback": [flag, vid],
        })
    if action == "proxy":
        fn = getattr(sp, "localProxy", None)
        if not callable(fn):
            return {}
        return fn(b)
    raise ValueError("unknown action: " + action)


def _is_js_api(api):
    """判"这个 api 该转给 drpy 还是本地 Python 执行"。

    三个都要认（配置里都真实出现过）：
    - `.../drpy2.min.js`（标准）
    - `.../a.js?v=3`（带版本参数；只判 endswith 会漏，这类源会被当 py 路径去 import）
    - `js:<内联源码>`（drpy 的调试语法，实测用来验证链路）
    """
    if not api:
        return False
    a = api.lower()
    if a.startswith("js:"):
        return True
    path = a.split("?")[0].split("#")[0]
    return path.endswith(".js") or path.endswith(".mjs")


def forward_drpy(handler, body):
    """把 `.js` 请求原样转给 drpy。

    参数是 BaseHTTPRequestHandler 实例，不是 dict：
    路径用 `handler.path`，请求头在 `handler.headers` 里（一个 email.message.Message）。
    实测踩过：直接 `handler.get("X-DRPY-Api")` 会报
    `'Handler' object has no attribute 'get'` —— 转发链路整条不可用，
    而 `.py` 源照常能跑，所以很容易漏测。
    """
    url = DRPY_UPSTREAM + handler.path
    req = urllib.request.Request(url, data=body, method="POST")
    for h in ("X-DRPY-Api", "X-DRPY-Ext", "Content-Type"):
        v = handler.headers.get(h)
        if v:
            req.add_header(h, v)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def parse_ext(ext):
    if not ext:
        return ""
    try:
        obj = json.loads(ext)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return ext


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, data, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/health"):
            self._send(200, b'{"ok":true,"service":"pyrt"}')
        else:
            self._send(404, b'{"code":-1,"msg":"not found"}')

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        api = urllib.parse.unquote(self.headers.get("X-DRPY-Api") or "")
        ext = urllib.parse.unquote(self.headers.get("X-DRPY-Ext") or "")

        # .js 统一转发给 drpy，让后端只需要认一个 jsRuntime 地址
        if _is_js_api(api):
            try:
                data = forward_drpy(self, body)
                self._send(200, data)
            except Exception as e:
                self._send(200, json.dumps({"code": -1, "msg": "drpy forward: %s" % e},
                                           ensure_ascii=False).encode("utf-8"))
            return

        path = urllib.parse.urlparse(self.path).path
        # ── 脚本注入端点（跨进程/跨 uid 用）──
        # 模块跑在独立进程时，宿主的 filesDir 它读不到；容器场景同理。
        # 宿主把这些脚本 POST 过来，这里落到本进程可写的 PY_DIR。
        if path.startswith("/_put/"):
            name = os.path.basename(urllib.parse.unquote(path[len("/_put/"):]))
            try:
                os.makedirs(PY_DIR, exist_ok=True)
                with open(os.path.join(PY_DIR, name), "wb") as f:
                    f.write(body)
                with _lock:
                    _instances.clear()
                self._send(200, json.dumps({"ok": True, "name": name}).encode())
            except Exception as e:
                self._send(200, json.dumps({"ok": False, "msg": str(e)}).encode())
            return
        if path == "/_ping":
            self._send(200, b'{"ok":true,"service":"pyrt"}')
            return

        parts = [p for p in path.split("/") if p]
        action = parts[-1] if parts else "search"
        try:
            payload = json.loads(body.decode("utf-8", "replace") or "{}")
        except Exception:
            payload = {}
        try:
            sp = load_spider(api, ext if isinstance(parse_ext(ext), str) else str(ext))
            out = dispatch(sp, action, payload)
            text = json.dumps(out, ensure_ascii=False, default=str)
        except Exception as e:
            tb = traceback.format_exc(limit=2)
            log("ERR", action, api, type(e).__name__, str(e)[:160])
            log(tb.replace("\n", " | ")[:400])
            text = json.dumps({"code": -1, "msg": "%s: %s" % (type(e).__name__, e)},
                              ensure_ascii=False)
        self._send(200, text.encode("utf-8"))


def serve(port=None, scripts_dir=None, drpy_upstream=None):
    """启动 HTTP 服务（阻塞）。

    <p>为什么要这个函数而不只靠 `__main__`：Chaquopy 里 `pyrt` 是被 **import** 的
    （`Python.getModule("pyrt")`），模块级常量的初值来自进程启动时的环境变量，
    而 Android 上的端口/脚本目录是 Java 侧运行时才知道的。所以这里接受参数、
    重设全局，再起服务。

    @param port          监听端口（None = 用 PYRT_PORT 初值）
    @param scripts_dir   脚本根目录（其下需有 `py/`；`base/` 可来自本 APK 的 scripts）
    @param drpy_upstream `.js` 转发目标（TV 上指向同机 QuickJS 的端口）
    """
    global PORT, DRPY_UPSTREAM, SCRIPTS_DIR, PY_DIR, BASE_DIR
    if scripts_dir:
        SCRIPTS_DIR = scripts_dir
        PY_DIR = os.path.join(scripts_dir, "py")
        BASE_DIR = scripts_dir
        # 数据目录优先；APK 自带的 scripts/base 已在模块底部 append 过，作兜底
        for p in (PY_DIR, BASE_DIR):
            if p not in sys.path:
                sys.path.insert(0, p)
        # 脚本目录变了，旧实例（按绝对路径缓存）必须丢弃
        with _lock:
            _instances.clear()
    if drpy_upstream:
        DRPY_UPSTREAM = drpy_upstream.rstrip("/")
    if port:
        PORT = int(port)
    log("serve on %s:%d, scripts=%s, drpy=%s" % (BIND, PORT, PY_DIR, DRPY_UPSTREAM))
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    serve()
