#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证上游 Python 蜘蛛在 **Fongmi 的 PyLoader 契约** 下能否跑。

为什么要这个脚本
----------------
我们的 Python 源是照着 vbox（暮色）客户端的 ``base.spider`` 写的；
Fongmi 的 Python 运行时（Chaquopy）自带的 ``base/spider.py`` 是**另一份实现**，
方法集合不一样（实测 Fongmi 版缺 getCache/setCache/delCache/fetch/getProxyUrl/host）。

本脚本直接用 Fongmi 源码里的真实 ``base/spider.py``（不是我们自己的桩）跑一遍，
把"运行时契约差异"和"站点本身失效"两类失败分开计数。

用法
----
    python smoke/fongmi_loader_probe.py --scripts <目录> [--fongmi <Fongmi-TV 目录>] [--shim]

    --shim   给 Fongmi 的 base.Spider 补齐 vbox 版有的方法（模拟"打完补丁"的理想情况）

输出：终端摘要 + JSON（默认写到 stdout 指定的 --out）
"""

import argparse
import importlib.util
import inspect
import json
import multiprocessing as mp
import os
import shutil
import sys
import tempfile
import traceback

STUB_INIT = '''class Proxy:
    @staticmethod
    def getUrl(local=True):
        return "http://127.0.0.1:18080/proxy"
'''

STUB_CRAWLER = '''class Spider:
    siteKey = ""

    @staticmethod
    def danmakuUrl(site_key, vid):
        return ""
'''


def build_stubs(root):
    """生成最小 Java 桩，替掉 Chaquopy 桥过来的 com.github.catvod.*。"""
    pkg = os.path.join(root, "com", "github", "catvod")
    os.makedirs(pkg, exist_ok=True)
    for d in (os.path.join(root, "com"), os.path.join(root, "com", "github")):
        open(os.path.join(d, "__init__.py"), "w", encoding="utf-8").close()
    open(os.path.join(pkg, "__init__.py"), "w", encoding="utf-8").write(STUB_INIT)
    open(os.path.join(pkg, "crawler.py"), "w", encoding="utf-8").write(STUB_CRAWLER)
    return root


def call_named(fn, values):
    """按参数名填值：这批脚本的签名有 (key)/(key,quick)/(key,quick,pg) 等多种。"""
    try:
        params = [(p.name, p.default) for p in inspect.signature(fn).parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) and p.name != "self"]
    except Exception:
        params = None
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


def apply_shim(base_spider_module):
    """补齐 vbox 版 base.Spider 有、Fongmi 版没有的方法。"""
    import requests as rq
    S = base_spider_module.Spider
    if not hasattr(S, "getProxyUrl"):
        S.getProxyUrl = lambda self, *a, **k: ""
    if not hasattr(S, "getCache"):
        S.getCache = lambda self, key: None
    if not hasattr(S, "setCache"):
        S.setCache = lambda self, key, value, expires=0: True
    if not hasattr(S, "delCache"):
        S.delCache = lambda self, key: True
    if not hasattr(S, "fetch"):
        S.fetch = lambda self, url=None, headers=None, timeout=15, verify=False, **kw: rq.get(
            url, headers=headers, timeout=timeout, verify=verify, **kw)
    if not hasattr(S, "get"):
        S.get = S.fetch
    if not hasattr(S, "post"):
        S.post = lambda self, url=None, data=None, json=None, headers=None, timeout=15, verify=False, **kw: rq.post(
            url, data=data, json=json, headers=headers, timeout=timeout, verify=verify, **kw)
    if not hasattr(S, "host"):
        S.host = ""


def run_one(args):
    path, scripts_dir, fongmi_dir, stubs_dir, shim, keyword, timeout = args
    try:
        sys.path.insert(0, stubs_dir)
        sys.path.insert(0, os.path.join(fongmi_dir, "chaquo", "src", "main", "python"))
        sys.path.insert(0, scripts_dir)
        name = "_fongmi_probe_" + os.path.splitext(os.path.basename(path))[0]
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
        cls = getattr(mod, "Spider", None)
        if cls is None:
            return {"file": os.path.basename(path), "ok": False, "stage": "no_spider", "err": ""}
        if shim:
            import base.spider as bs
            apply_shim(bs)
        sp = cls()
        init = getattr(sp, "init", None)
        if callable(init):
            init("")
        r = call_named(sp.searchContent, {"key": keyword, "wd": keyword, "quick": False,
                                          "pg": "1", "page": "1", "_fallback": [keyword]})
        n = len((r or {}).get("list") or [])
        return {"file": os.path.basename(path), "ok": n > 0, "stage": "search",
                "n": n, "err": "" if n else "empty"}
    except Exception as e:
        return {"file": os.path.basename(path), "ok": False, "stage": "exception",
                "err": f"{type(e).__name__}: {str(e)[:160]}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scripts", required=True, help="待测 Python 蜘蛛目录")
    ap.add_argument("--fongmi", default=r"P:\workspace\ai-projects\meow\research\upstream\Fongmi-TV")
    ap.add_argument("--shim", action="store_true", help="给 Fongmi base 补 vbox 版方法")
    ap.add_argument("--keyword", default="国产")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    scripts = args.scripts
    if not os.path.isdir(scripts):
        print("scripts dir not found:", scripts)
        return 2
    stubs = build_stubs(tempfile.mkdtemp(prefix="fongmi-stub-"))
    files = sorted(f for f in os.listdir(scripts) if f.endswith(".py"))

    results = []
    try:
        with mp.Pool(args.workers) as pool:
            asyncs = [(os.path.join(scripts, f), scripts, args.fongmi, stubs, args.shim,
                       args.keyword, args.timeout) for f in files]
            pending = [(f, pool.apply_async(run_one, (a,))) for f, a in zip(files, asyncs)]
            for f, a in pending:
                try:
                    results.append(a.get(timeout=args.timeout + 5))
                except Exception as e:
                    results.append({"file": f, "ok": False, "stage": "timeout", "err": str(e)[:80]})
    finally:
        shutil.rmtree(stubs, ignore_errors=True)

    errors = {}
    for r in results:
        if not r["ok"]:
            k = (r.get("err") or "")[:60]
            errors[k] = errors.get(k, 0) + 1
    summary = {
        "total": len(results),
        "ok": sum(1 for r in results if r["ok"]),
        "shim": args.shim,
        "ok_files": [r["file"] for r in results if r["ok"]],
        "top_errors": sorted(errors.items(), key=lambda x: -x[1])[:10],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    if args.out:
        json.dump({"summary": summary, "results": results},
                  open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("written:", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
