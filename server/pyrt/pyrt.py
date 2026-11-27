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
import shutil
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
import warnings

# ---------------------------------------------------------------------------
# iOS 端内 CPython（Python-Apple-support）默认不配置 C stdio：sys.stdout /
# sys.stderr 可能是 None。后果不是"日志少了"——第一次 print() 就抛
# AttributeError，pyrt 起来即退出，而 PyErr_Print 也写不出任何东西
# （真机实测 2026-11-26：py.log 里只有 "[meow-py] pyrt exited with error"，
# 没有 traceback）。这里显式接到 MEOW_PY_LOG；其它端该变量为空且流本来可用，
# 行为不变。
# ---------------------------------------------------------------------------
_MEOW_PY_LOG = os.environ.get("MEOW_PY_LOG", "")
if sys.stdout is None or sys.stderr is None:
    try:
        _fallback_stream = open(_MEOW_PY_LOG or os.devnull, "a", buffering=1,
                                 encoding="utf-8", errors="replace")
    except Exception:
        _fallback_stream = None
    if sys.stdout is None:
        sys.stdout = _fallback_stream
    if sys.stderr is None:
        sys.stderr = _fallback_stream if _fallback_stream is not None else sys.stdout

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

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
DRPY_UPSTREAM = os.environ.get("PYRT_DRPY", "").rstrip("/")
"""
`.js` 转发目标。启动时会主动解析（见 `_resolve_drpy`），不依赖写死的端口。

★ 为什么要探测（2026-11-27）：drpy 的端口是**协商**出来的（9330 被占会顺延到
  9331…，PC/fpk 的插件管理器就是这么做的），而以前这里写死 9330 —— drpy 一
  顺延，pyrt 转发 `.js` 就 Connection refused，表现是「.js 源全部 drpy forward
  失败」而 `.py` 正常。现在按候选端口探一遍 `/health`，转发失败时再探一次。
"""
_DRPY_CANDIDATE_PORTS = (9330, 9331, 9332, 9333, 9334)
_drpy_ok = False
_drpy_at = 0.0

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

"""远程脚本落盘后的复用时长（秒）。

源包规范要求站点 api 是**绝对 URL**（脚本由源服务托管，壳子只管加载），
所以 pyrt 必须能自己把脚本取下来。取下来的副本复用一天：源站换了实现
隔天能跟上，又不至于每次搜索都拉一遍。
"""
_REMOTE_TTL = 86400

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

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
    # stdout 不可用时不要因为日志把服务本身带走（端内 CPython 的流是 None 的历史坑）
    try:
        print("[pyrt]", *a, flush=True)
    except Exception:
        pass


def _fetch_remote(api):
    """把 http(s) 上的源脚本按需落盘到 PY_DIR，返回本地路径。

    为什么要有这个：源包规范写死了"站点 api 必须是绝对 http(s) URL"
    （脚本由源服务托管，不归壳子维护），而 pyrt 只能 import 本地文件。
    没有这一步，PC / fpk / TV 上的 .py 源一律 `FileNotFoundError`。

    落在 PY_DIR 而不是独立缓存目录：这样三端的脚本目录天然一致，都由
    PYRT_SCRIPTS 决定，不需要各端导入流程各写一份"把 py 落盘"的逻辑。

    只读挂载（Docker 常见：`py-scripts:/data/py-scripts:ro`）写不进去时
    退到临时目录 —— 本次进程内照样能跑，只是不跨重启缓存。
    """
    name = os.path.basename(urllib.parse.urlparse(api).path) or "spider.py"
    if not name.endswith(".py"):
        name += ".py"

    def download(dst_dir, tag):
        os.makedirs(dst_dir, exist_ok=True)
        dst = os.path.join(dst_dir, name)
        tmp = dst + ".part"
        req = urllib.request.Request(api, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=45) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(tmp, dst)
        log("fetched" + tag, name, "<-", api[:90])
        return dst

    local = os.path.join(PY_DIR, name)
    try:
        if os.path.exists(local) and (time.time() - os.path.getmtime(local)) < _REMOTE_TTL:
            return local
    except OSError:
        pass
    # 先探可写性再下载，不能靠 `except OSError` 兜底判断只读：
    # urllib.error.URLError 是 OSError 的子类，网络不通会被误判成"目录只读"，
    # 日志把排查方向指错（实测 Docker 里踩到：明明只是容器连不上宿主）。
    if _can_write(PY_DIR):
        return download(PY_DIR, "")
    log("cache dir not writable, falling back to temp:", PY_DIR)
    return download(tempfile.mkdtemp(prefix="pyrt-remote-"), "(temp)")


def _can_write(d):
    """目录能不能写（真正建个文件试，别靠 stat 猜）。"""
    try:
        os.makedirs(d, exist_ok=True)
        probe = os.path.join(d, ".write-probe")
        with open(probe, "wb"):
            pass
        os.remove(probe)
        return True
    except OSError:
        return False


def load_spider(api, ext):
    """按 (脚本路径, ext) 缓存实例；ext 变了要重新 init。

    三种坏 api 都要给明确错误：`spec_from_file_location` 对空串（拼成目录）和
    未知扩展名都返回 None，随后 `module_from_spec(None)` 抛
    `AttributeError: 'NoneType' object has no attribute 'loader'` —— 这个报错
    完全不指向真正原因（漏发请求头），实测排查了两轮才定位。
    """
    if not api:
        raise ValueError("missing X-DRPY-Api header（只有路径段不够，pyrt 靠这个头找脚本）")
    if api.startswith(("http://", "https://")):
        # 源包规范下的正常形态：脚本由源服务托管，本地只留副本
        api = _fetch_remote(api)
    elif not os.path.isabs(api):
        api = os.path.join(PY_DIR, api)
    if os.path.isdir(api):
        raise IsADirectoryError("api 是目录而不是脚本: " + api)
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
    # 注入代理基址：源脚本的 _proxy_base() 先调 getProxyUrl(True)，拿不到才兜底
    # 127.0.0.1:18080（vbox 客户端的约定）。不注入的后果是"能搜、封面裂、播不了"——
    # vod_pic 与 m3u8 全指向一个不存在的服务，而搜索接口本身完全正常。
    try:
        _pkey = getattr(sp, "PLATFORM_KEY", "") or os.path.splitext(os.path.basename(api))[0]
        _pbase = "http://127.0.0.1:%d/proxy?do=py&key=%s" % (PORT, _pkey)
        sp.getProxyUrl = lambda *a, **k: _pbase
    except Exception:
        pass
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


def _drpy_alive(base):
    """这个地址是不是一个活着的 JS 运行时（drpy 或 TV 的内置 QuickJS）？

    两种 /health 形状都要认：
      drpy      → {"ok":true,"service":"meow-drpy","py":false,"js":true,...}
      QuickJS   → {"ok":true,"service":"quickjs","py":false,"caps":{"js":true,...}}
    只判 `"js":true` 字样即可覆盖两者；不能判 `py`（QuickJS 也是 py:false）。
    """
    if not base:
        return False
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/health", timeout=1.5) as r:
            if r.status != 200:
                return False
            body = r.read(1024).decode("utf-8", "replace")
            # 别把自己当上游（误配 PYRT_DRPY 指向 pyrt 自己时会无限自转发）
            if '"service":"pyrt"' in body.replace(" ", ""):
                return False
            return '"js":true' in body.replace(" ", "") or "drpy" in body.lower()
    except Exception:
        return False


def _resolve_drpy(force=False):
    """确定 `.js` 转发目标：已配置地址优先，其次按候选端口探测。

    ★ 只在启动与「转发失败」时调用，**不要放进 /health** —— 宿主探活用 800ms
      超时，探测多端口会把健康检查拖成假死（2026-11-27 实测过同类问题）。
    """
    global DRPY_UPSTREAM, _drpy_ok, _drpy_at
    now = time.time()
    with _lock:
        # 刚确认过且仍然活着：直接用，省一次探测
        if not force and _drpy_ok and (now - _drpy_at) < 60:
            return DRPY_UPSTREAM
        cands = []
        if DRPY_UPSTREAM:
            cands.append(DRPY_UPSTREAM)
        for p in _DRPY_CANDIDATE_PORTS:
            u = "http://127.0.0.1:%d" % p
            if u not in cands:
                cands.append(u)
        for u in cands:
            if _drpy_alive(u):
                if u != DRPY_UPSTREAM:
                    log("drpy upstream -> %s" % u)
                DRPY_UPSTREAM = u
                _drpy_ok = True
                _drpy_at = now
                return u
        _drpy_ok = False
        _drpy_at = now
        log("drpy upstream 不可用（试过 %s）—— .js 源会报转发失败" % ",".join(cands))
        return DRPY_UPSTREAM


def forward_drpy(handler, body):
    """把 `.js` 请求原样转给 drpy（地址失效时重探一次再试）。

    参数是 BaseHTTPRequestHandler 实例，不是 dict：
    路径用 `handler.path`，请求头在 `handler.headers` 里（一个 email.message.Message）。
    实测踩过：直接 `handler.get("X-DRPY-Api")` 会报
    `'Handler' object has no attribute 'get'` —— 转发链路整条不可用，
    而 `.py` 源照常能跑，所以很容易漏测。
    """
    for attempt in (0, 1):
        url = DRPY_UPSTREAM + handler.path
        req = urllib.request.Request(url, data=body, method="POST")
        for h in ("X-DRPY-Api", "X-DRPY-Ext", "Content-Type"):
            v = handler.headers.get(h)
            if v:
                req.add_header(h, v)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except (urllib.error.URLError, ConnectionError, OSError):
            # 第一跳失败：drpy 可能换了端口（协商顺延/重启）→ 重探后重试一次
            if attempt == 0 and _resolve_drpy(force=True):
                continue
            raise


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

    def _serve_proxy(self):
        """图片/流代理（vbox 同形：?do=py&key=<site>&type=img|video&u=<url>&r=<referer>）。

        为什么必须有：源脚本的 getProxyUrl() 拿不到壳注入的方法时会兜底到
        127.0.0.1:18080/proxy（vbox 客户端的约定）。缺这个端点时 vod_pic 与
        播放地址全指向一个不存在的服务——表现为"能搜、封面裂、播不了"，
        而搜索接口本身完全正常，很容易漏掉。

        Range 必须透传：视频拖动、部分播放器起播都靠 206。
        """
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = (qs.get("u") or [""])[0]
        referer = (qs.get("r") or [""])[0]
        if not target:
            self._send(400, b'{"code":-1,"msg":"missing u"}')
            return
        try:
            hdrs = {
                "User-Agent": self.headers.get("User-Agent")
                or "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/87 Mobile Safari/537.36",
                "Accept": "*/*",
            }
            if referer:
                hdrs["Referer"] = referer
            rng = self.headers.get("Range")
            if rng:
                hdrs["Range"] = rng
            up = urllib.request.Request(target, headers=hdrs)
            with urllib.request.urlopen(up, timeout=45) as r:
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type") or "application/octet-stream")
                for h in ("Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"):
                    v = r.headers.get(h)
                    if v:
                        self.send_header(h, v)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                while True:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            self._send(e.code, json.dumps({"code": -1, "msg": "upstream %d" % e.code}).encode())
        except Exception as e:
            self._send(502, json.dumps({"code": -1, "msg": "proxy: %s" % e}).encode())

    def do_GET(self):
        # 图片/视频流走 GET（源站的 <img src> 与 m3u8 分片都是 GET）
        _p = urllib.parse.urlparse(self.path).path
        if _p == "/proxy":
            return self._serve_proxy()
        if self.path in ("/", "/health"):
            # caps：宿主据此判断该运行时能不能执行 .py（iOS 端内只有 drpy）
            caps = {
                "ok": True,
                "service": "pyrt",
                "py": True,
                # 用启动时解析的结果，不在这里探测（宿主探活只有 800ms）
                "js": _drpy_ok,
            }
            # ★ 必须紧凑分隔符：插件健康检查是按 contains('"ok":true') 判活的，
            #   json.dumps 默认带空格（"ok": true）会判死 → 启动 20s 超时后回滚
            #   （2026-11-26 实测：pyrt 插件装上就「启动失败」，手跑却正常）。
            self._send(200, json.dumps(caps, separators=(",", ":")).encode("utf-8"))
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
        if path == "/proxy" or path.startswith("/proxy?"):
            return self._serve_proxy()

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
            msg = "%s: %s" % (type(e).__name__, e)
            # iOS 端内运行时是裁剪版（无 lxml/pyquery）；把"依赖缺失"与"源坏了"区分开
            if os.environ.get("MEOW_PY_TRIM"):
                if "lxml" in msg or "pyquery" in msg:
                    msg += "（iOS 端内运行时未包含 lxml/pyquery；可改用远端 pyrt）"
            text = json.dumps({"code": -1, "msg": msg},
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
    # 起服务前先把 `.js` 上游定下来（drpy 端口可能是协商出来的）
    _resolve_drpy(force=True)
    log("serve on %s:%d, scripts=%s, drpy=%s (js=%s)"
        % (BIND, PORT, PY_DIR, DRPY_UPSTREAM, _drpy_ok))
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


if __name__ == "__main__":
    try:
        serve()
    except KeyboardInterrupt:
        raise
    except BaseException:
        # 端内 CPython 的 stderr 可能不可用（见文件头的流兜底）；这里再直接
        # 往 MEOW_PY_LOG 写一份 traceback，保证真机失败时一定留得下原因。
        if _MEOW_PY_LOG:
            try:
                with open(_MEOW_PY_LOG, "a", encoding="utf-8", errors="replace") as _f:
                    _f.write("[pyrt] fatal:\n")
                    traceback.print_exc(file=_f)
                    _f.flush()
            except Exception:
                pass
        raise
