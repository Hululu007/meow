#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PC 桌面端（Tauri + 内置插件）冒烟脚本。

通道选择：走 MCP 的 HTTP JSON-RPC（POST http://127.0.0.1:<mcp_port>/mcp,
method=tools/call）。理由：
  - MCP 已在应用内跑起来，18 个 pc_* 工具直接复用应用自身的 CDP 连接，
    不用自己开 CDP 客户端、不用管 target 选择与 ws 帧格式（CDP 直连要自己
    处理 attach/webSocketDebuggerUrl，失败模式更多）。
  - 同一通道能同时读到插件状态（pc_plugins）、后端地址（pc_backend）、
    页面 console/network，比"CDP 读页面 + HTTP 读后端"两条腿少一类不一致。
  - 前端真正的运行时断言（readyState、localStorage、getComputedStyle）
    都用 pc_eval 在页面上下文里做，等价于 CDP Runtime.evaluate。

前置事实（全部现读，不写死）：
  MCP 端口：在 9339–9346 探测 /health（新版本不再把端口写进 info 文件）
  ~/.zcode/meow-mcp.json 给 cdp_port / pid / version（pid 是上次运行的，别当活性判据）
  /health 给 cdp_ready 与插件的真实端口（后端会顺延，不能假设 9979）

用法：
  python smoke/pc_smoke.py            # 默认 MCP info 文件
  python smoke/pc_smoke.py --verbose  # 打印每条证据

退出码：0 全绿 / 1 有 FAIL / 2 环境不具备（未执行）
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------- MCP 客户端

INFO_PATH = os.path.expanduser(os.path.join("~", ".zcode", "meow-mcp.json"))


def _probe_port():
    """在 9339–9346 里找 PC 端 MCP，返回端口号；找不到返回 0。

    判据是响应体特征而不是"端口能连上"——这一段区间里可能跑着别的服务。
    新版本自报 server=meow-player；0.9.15 及更早没有这个字段，退回
    cdp_ready + plugins 的组合判据（用户机器上装的往往是已发布版本）。
    区间必须与 mcp.rs 的 PORT_MIN/PORT_COUNT 一致。
    """
    for port in range(9339, 9339 + 8):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:%d/health" % port, timeout=0.8
            ) as r:
                h = json.loads(r.read().decode("utf-8", "replace"))
        except Exception:
            continue
        if not isinstance(h, dict):
            continue
        if h.get("server") == "meow-player":
            return port
        if "cdp_ready" in h and "plugins" in h:
            return port
    return 0

# 公开测试流（2026-10-26 实测 HTTP 200，见 report）
TEST_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
PLAY_HASH = (
    "#/play/lib?direct="
    + urllib.parse.quote(TEST_STREAM, safe="")
    + "&name=smoke-test"
)


class MCP:
    def __init__(self, info):
        # info 文件不再写 mcp_port（见 mcp.rs 的说明）：端口是易变量，
        # 写进文件就会过期。改为在 9339–9346 里探测，判据是 /health
        # 自报 server=meow-player。
        self.mcp_port = info["mcp_port"] if "mcp_port" in info else _probe_port()
        self.cdp_port = info["cdp_port"]
        self.pid = info.get("pid")
        self.version = info.get("version")
        self.url = "http://127.0.0.1:%d/mcp" % self.mcp_port
        self._id = 0

    def _post(self, payload, timeout=60):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self.url, data=body, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def initialize(self):
        self._id += 1
        return self._post(
            {
                "jsonrpc": "2.0",
                "id": self._id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "pc-smoke", "version": "1"},
                },
            }
        )

    def tool(self, name, args=None, timeout=60):
        """调 pc_* 工具，返回 (is_error, text)。"""
        self._id += 1
        d = self._post(
            {
                "jsonrpc": "2.0",
                "id": self._id,
                "method": "tools/call",
                "params": {"name": name, "arguments": args or {}},
            },
            timeout=timeout,
        )
        if "error" in d:
            return True, "rpc-error: %s" % json.dumps(d["error"], ensure_ascii=False)
        res = d.get("result") or {}
        text = "".join(c.get("text", "") for c in res.get("content", []))
        return bool(res.get("isError")), text

    def js(self, expr, timeout=60):
        """在页面上下文求值，返回 Python 对象（约定表达式返回 JSON 字符串）。"""
        is_err, text = self.tool("pc_eval", {"expression": expr}, timeout=timeout)
        if is_err:
            raise RuntimeError("pc_eval failed: %s" % text[:400])
        try:
            return json.loads(text)
        except Exception:
            return text

    def wait(self, **kw):
        return self.tool("pc_wait", kw)


# ---------------------------------------------------------------- 断言框架


class Runner:
    def __init__(self, verbose=False):
        self.rows = []  # (ok, domain, name, actual)
        self.verbose = verbose
        self.skipped = []

    def check(self, ok, domain, name, actual):
        self.rows.append((bool(ok), domain, name, actual))
        if self.verbose or not ok:
            print("  %s [%s] %s | %s" % ("PASS" if ok else "FAIL", domain, name, actual))
        return bool(ok)

    def skip(self, domain, name, reason):
        self.skipped.append("%s / %s: %s" % (domain, name, reason))
        print("  SKIP [%s] %s | %s" % (domain, name, reason))

    def eq(self, domain, name, actual, expected):
        return self.check(actual == expected, domain, name, repr(actual))

    def truthy(self, domain, name, actual, detail=None):
        """断言 actual 为真；detail 只用于展示实测值，不参与判定。

        ★ 踩过的坑：调用方曾把格式化字符串（如 "found=False"）当 actual 传进来，
        非空字符串恒为真 → 断言永远 PASS，6 处可失败项被静默吞掉。
        所以判定只看 actual 的真假，给人看的证据走 detail。
        """
        return self.check(bool(actual), domain, name,
                          str(detail) if detail is not None else repr(actual)[:400])

    def summary(self):
        total = len(self.rows)
        passed = sum(1 for r in self.rows if r[0])
        print("\n" + "=" * 72)
        for ok, domain, name, actual in self.rows:
            print(
                "%s [%s] %s | %s"
                % ("PASS" if ok else "FAIL", domain, name, str(actual)[:220])
            )
        print("=" * 72)
        print("总计: %d/%d 通过" % (passed, total))
        if self.skipped:
            print("未执行:")
            for s in self.skipped:
                print("  - " + s)
        fails = [
            "[%s] %s = %s" % (d, n, str(a)[:300])
            for ok, d, n, a in self.rows
            if not ok
        ]
        if fails:
            print("失败清单:")
            for f in fails:
                print("  - " + f)
        return passed, total


# ---------------------------------------------------------------- 各域断言


def probe_env(r, mcp):
    """1. 应用探活 + 7. 插件能力 + 2. 后端插件"""
    print("\n[1] 应用探活 / MCP")
    code = 0
    body = ""
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/health" % mcp.mcp_port, timeout=10
        ) as resp:
            code = resp.status
            body = resp.read().decode("utf-8")
    except Exception as e:
        r.check(False, "app", "MCP /health 可达", "exception: %s" % e)
        return None
    r.eq("app", "MCP /health HTTP 状态", code, 200)
    h = json.loads(body)
    r.eq("app", "health.ok", h.get("ok"), True)
    r.eq("app", "health.cdp_ready", h.get("cdp_ready"), True)
    # 端口落在文档约定的协商区间（9339 起顺延 8 个）。
    # 原先写成自比较（mcp_port vs mcp_port）恒真，等于没验任何东西。
    r.truthy("app", "MCP 端口在协商区间 9339–9346",
             9339 <= mcp.mcp_port <= 9346, detail="mcp_port=%s" % mcp.mcp_port)

    # app version：MCP initialize 的 serverInfo.version
    init = mcp.initialize()
    v = ((init.get("result") or {}).get("serverInfo") or {}).get("version")
    r.check(
        v == mcp.version,
        "app",
        "app version 与 info 文件一致",
        "MCP=%r info=%r" % (v, mcp.version),
    )

    # tools/list 数量（18 个 pc_*）
    mcp._id += 1
    tl = mcp._post({"jsonrpc": "2.0", "id": mcp._id, "method": "tools/list", "params": {}})
    tools = [t["name"] for t in (tl.get("result") or {}).get("tools", [])]
    r.check(
        len(tools) == 18 and all(t.startswith("pc_") for t in tools),
        "mcp",
        "tools/list 含 18 个 pc_* 工具",
        "%d 个: %s" % (len(tools), ",".join(tools)),
    )

    # 路由回读：确认页面真的在应用里
    try:
        route = mcp.js("location.hash + '|' + document.title")
        r.truthy("app", "页面可达（location.hash）", route)
    except Exception as e:
        r.check(False, "app", "页面可达（location.hash）", "pc_eval 异常: %s" % e)
    return h


def probe_plugins(r, mcp, health):
    """7. pc_plugins 能列出插件与端口"""
    print("\n[7] 插件能力 / pc_plugins")
    is_err, text = mcp.tool("pc_plugins")
    r.check(not is_err, "plugin", "pc_plugins 调用无错", "isError=%s" % is_err)
    try:
        plugins = json.loads(text)
    except Exception:
        r.check(False, "plugin", "pc_plugins 返回 JSON", text[:200])
        return None

    ids = [p.get("id") for p in plugins]
    r.check(
        "apiserver" in ids and "danmu-api" in ids,
        "plugin",
        "插件列表含 apiserver + danmu-api",
        ids,
    )
    apiserver = next((p for p in plugins if p.get("id") == "apiserver"), {})
    r.eq("plugin", "apiserver.phase", apiserver.get("phase"), "ready")
    r.check(
        isinstance(apiserver.get("port"), int) and apiserver["port"] > 0,
        "plugin",
        "apiserver.port > 0",
        "port=%r base=%r" % (apiserver.get("port"), apiserver.get("base")),
    )
    # 与 health 里的插件端口交叉核对
    hplug = {
        p["id"]: p for p in (health or {}).get("plugins", []) if isinstance(p, dict)
    }
    if "apiserver" in hplug:
        r.eq(
            "plugin",
            "apiserver 端口 MCP/health 一致",
            apiserver.get("port"),
            hplug["apiserver"].get("port"),
        )
        r.eq(
            "plugin",
            "apiserver.base 与 port 自洽",
            apiserver.get("base"),
            "http://127.0.0.1:%s" % apiserver.get("port"),
        )
    return plugins, apiserver


def probe_backend(r, mcp, apiserver):
    """2. 后端插件：phase=ready、health 的 version 与 sites"""
    print("\n[2] 后端插件 / health")
    is_err, text = mcp.tool("pc_backend")
    r.check(not is_err, "backend", "pc_backend 调用无错", "isError=%s" % is_err)
    base = (apiserver or {}).get("base") or ""
    r.truthy("backend", "后端 base 非空", base)
    if not base:
        r.skip("backend", "/api/health", "拿不到后端 base")
        return None

    url = base.rstrip("/") + "/api/health"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            hcode = resp.status
            hbody = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        r.check(False, "backend", "GET %s" % url, "exception: %s" % e)
        return None
    r.eq("backend", "GET %s 状态" % url, hcode, 200)
    r.eq("backend", "后端 health.ok", hbody.get("ok"), True)
    r.eq("backend", "后端 health.version", hbody.get("version"), (apiserver or {}).get("version"))
    r.check(
        isinstance(hbody.get("sites"), int) and hbody["sites"] > 0,
        "backend",
        "后端 sites > 0",
        "sites=%r ext=%r" % (hbody.get("sites"), hbody.get("ext")),
    )
    r.check(
        hbody.get("spiderJar") is True,
        "backend",
        "spiderJar 可加载",
        "spiderJar=%r" % hbody.get("spiderJar"),
    )
    r.check(
        isinstance(hbody.get("capabilities"), list) and len(hbody["capabilities"]) > 0,
        "backend",
        "health.capabilities 非空",
        hbody.get("capabilities"),
    )
    return {"url": url, "body": hbody}


def probe_frontend(r, mcp):
    """3. 前端加载：首屏渲染不是白屏"""
    print("\n[3] 前端加载")
    mcp.tool("pc_navigate", {"hash": "#/"})
    time.sleep(2.5)
    try:
        info = mcp.js(
            "JSON.stringify({hash:location.hash,"
            "bodyLen:document.body.innerText.trim().length,"
            "mainLen:(document.querySelector('main')||{}).innerText?document.querySelector('main').innerText.trim().length:0,"
            "imgs:document.querySelectorAll('img').length,"
            "header:!!document.querySelector('header')})"
        )
    except Exception as e:
        r.check(False, "front", "首页 DOM 读取", "exception: %s" % e)
        return
    r.eq("front", "首页 hash", info.get("hash"), "#/")
    r.check(
        info.get("bodyLen", 0) > 100,
        "front",
        "首屏文本长度 > 100（非白屏）",
        "bodyLen=%s" % info.get("bodyLen"),
    )
    r.check(
        info.get("mainLen", 0) > 0,
        "front",
        "main 区有内容",
        "mainLen=%s" % info.get("mainLen"),
    )
    r.truthy("front", "存在 header 与图片",
             (info.get("imgs") or 0) > 0 and bool(info.get("header")),
             detail="imgs=%s header=%s" % (info.get("imgs"), info.get("header")))

    # console 无 JS 错误
    is_err, ctext = mcp.tool("pc_console")
    if not is_err:
        try:
            c = json.loads(ctext)
            r.eq("front", "页面 JS 错误数", c.get("total"), 0)
        except Exception:
            r.skip("front", "页面 JS 错误数", "pc_console 非 JSON: " + ctext[:120])
    else:
        r.skip("front", "页面 JS 错误数", "pc_console 不可用: " + ctext[:120])


def probe_style(r, mcp):
    """4. 样式生效探针：注入 .flex 的 div，computed display 必须是 flex"""
    print("\n[4] 样式探针 .flex")
    expr = (
        "JSON.stringify((function(){"
        "var d=document.createElement('div');"
        "d.className='flex';"
        "d.style.cssText='position:fixed;left:-9999px;top:0;width:10px;height:10px';"
        "document.body.appendChild(d);"
        "var cs=getComputedStyle(d).display;"
        "var root=getComputedStyle(document.documentElement);"
        "d.remove();"
        "return {display:cs,"
        "style:document.documentElement.dataset.style||null,"
        "mode:document.documentElement.dataset.mode||null,"
        "base:root.getPropertyValue('--color-base').trim()};"
        "})())"
    )
    try:
        got = mcp.js(expr)
    except Exception as e:
        r.check(False, "style", ".flex 探针", "exception: %s" % e)
        return
    r.eq("style", ".flex 的 computed display", got.get("display"), "flex")
    r.truthy("style", "主题属性已挂上（data-style/data-mode）",
             bool(got.get("style")) and bool(got.get("mode")),
             detail="%s/%s" % (got.get("style"), got.get("mode")))
    r.truthy("style", "CSS 变量 --color-base 有值", got.get("base"))


def probe_bundle(r, mcp):
    """诊断：运行时加载的 main chunk 里有没有 /logs 路由。

    用来区分两种失败：
      - 路由存在但页面崩了   → 应用 bug
      - 路由压根不在 chunk 里 → 安装包内嵌的前端产物落后于源码
    Tauri 把 dist 打进 exe，换前端必须重新打包安装，dev server 的修复不会
    自动出现在已安装的版本上。

    实测（2026-10-26，安装版 0.9.15）：
      exe 内嵌 chunk = index-B4Y0G7nu.js，路由表无 /logs、无 /library/add
      仓库 dist     = index-D58s8izT.js，路由表含 /logs，且有 LogsView chunk
      源码 router/index.ts:45 有 /logs
    → 结论是产物落后，不是运行期 bug。
    """
    print("\n[5b] 产物溯源 / main chunk 路由表")
    expr = (
        "(async function(){"
        "var main=[...performance.getEntriesByType('resource')].map(function(e){return e.name})"
        ".find(function(n){return /index-.*\\.js$/.test(n)});"
        "if(!main)return JSON.stringify({found:false});"
        "var t=await (await fetch(main)).text();"
        "var paths=[...t.matchAll(/path:\\s*[\"']([^\"']+)[\"']/g)].map(function(m){return m[1]});"
        "return JSON.stringify({found:true,chunk:main.split('/').pop(),paths:paths,"
        "hasLogs:paths.indexOf('/logs')>=0});"
        "})()"
    )
    try:
        b = mcp.js(expr, timeout=30)
    except Exception as e:
        r.check(False, "bundle", "读取 main chunk", "exception: %s" % e)
        return
    r.truthy("bundle", "定位到 main chunk", b.get("chunk") if isinstance(b, dict) else b)
    if not isinstance(b, dict) or not b.get("found"):
        return
    r.check(
        "/logs" in (b.get("paths") or []),
        "bundle",
        "运行时 chunk 的路由表含 /logs",
        "chunk=%s hasLogs=%s paths=%s"
        % (b.get("chunk"), b.get("hasLogs"), (b.get("paths") or [])[:16]),
    )


def probe_routes(r, mcp):
    """5. 关键路由可达：settings / library / logs"""
    print("\n[5] 关键路由可达")
    targets = [
        ("settings", "#/settings", ["连接", "本机插件"]),
        ("library", "#/library", ["片库"]),
        ("logs", "#/logs", ["日志"]),
    ]
    for name, hash_, needles in targets:
        mcp.tool("pc_navigate", {"hash": hash_})
        time.sleep(2.0)
        expr = (
            "JSON.stringify({hash:location.hash,"
            "mainLen:(document.querySelector('main')||{}).innerText?document.querySelector('main').innerText.trim().length:0,"
            "mainText:(document.querySelector('main')||{}).innerText?document.querySelector('main').innerText.slice(0,300):''})"
        )
        try:
            info = mcp.js(expr)
        except Exception as e:
            r.check(False, "route", "%s 渲染" % name, "exception: %s" % e)
            continue
        r.eq("route", "%s URL 生效" % name, info.get("hash"), hash_)
        r.check(
            info.get("mainLen", 0) > 0,
            "route",
            "%s main 有内容（非空白页）" % name,
            "mainLen=%s text=%r" % (info.get("mainLen"), (info.get("mainText") or "")[:80]),
        )
        hit = any(n in (info.get("mainText") or "") for n in needles)
        r.check(
            hit,
            "route",
            "%s 含预期文案 %s" % (name, needles),
            "text=%r" % (info.get("mainText") or "")[:160],
        )


def probe_player(r, mcp):
    """6. 播放器：公开 m3u8 能播 + 「更多」菜单有睡眠定时/快捷键说明"""
    print("\n[6] 播放器")
    is_err, txt = mcp.tool("pc_navigate", {"hash": PLAY_HASH})
    r.check(not is_err, "play", "导航到播放页", "%r" % txt[:120])
    time.sleep(3.0)

    # 等 readyState >= 3（用 pc_wait 的 video_ready，再自己复核）
    try:
        mcp.wait(video_ready=True, timeout_ms=25000)
    except Exception:
        pass
    try:
        v = mcp.js(
            "JSON.stringify((function(){var v=document.querySelector('video');"
            "if(!v)return {found:false};"
            "return {found:true,readyState:v.readyState,currentTime:v.currentTime,"
            "duration:v.duration,paused:v.paused,"
            "src:(v.currentSrc||'').slice(0,90),err:v.error?v.error.code:null};})())"
        )
    except Exception as e:
        r.check(False, "play", "读取 video 状态", "exception: %s" % e)
        return
    r.truthy("play", "存在 <video>", bool(v.get("found")), detail="found=%s" % v.get("found"))
    r.check(
        (v.get("readyState") or 0) >= 3,
        "play",
        "video readyState >= 3",
        "readyState=%s" % v.get("readyState"),
    )
    r.check(
        (v.get("duration") or 0) > 0,
        "play",
        "duration > 0",
        "duration=%s" % v.get("duration"),
    )
    r.check(v.get("err") is None, "play", "video.error 为空", "err=%s" % v.get("err"))

    # 播放推进：play 后 currentTime 应增长
    try:
        mcp.js("(function(){var v=document.querySelector('video');if(v){v.muted=true;v.play();}return 'ok'})()")
        t0 = mcp.js(
            "JSON.stringify({t:(document.querySelector('video')||{}).currentTime||0})"
        ).get("t")
        time.sleep(2.0)
        t1 = mcp.js(
            "JSON.stringify({t:(document.querySelector('video')||{}).currentTime||0})"
        ).get("t")
        r.check(
            (t1 or 0) > (t0 or 0),
            "play",
            "播放推进 currentTime 增长",
            "t0=%s -> t1=%s" % (t0, t1),
        )
    except Exception as e:
        r.skip("play", "播放推进 currentTime 增长", "exception: %s" % e)

    # 「更多」菜单
    is_err, txt = mcp.tool("pc_click", {"selector": 'button[title="更多"]'})
    r.check(not is_err and "clicked" in txt, "play", "点击「更多」按钮", txt[:120])
    time.sleep(1.0)
    try:
        menu = mcp.js(
            "JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean))"
        )
    except Exception as e:
        r.check(False, "play", "读取更多菜单项", "exception: %s" % e)
        return
    r.check("睡眠定时" in menu, "play", "更多菜单含「睡眠定时」", "菜单=%s" % [m for m in menu if len(m) < 30][:12])
    r.check("快捷键说明" in menu, "play", "更多菜单含「快捷键说明」", "同上")

    # 展开睡眠定时子菜单，确认 15/30/60/90
    is_err, txt = mcp.tool("pc_click", {"text": "睡眠定时"})
    r.check(not is_err and "clicked" in txt, "play", "展开睡眠定时子菜单", txt[:120])
    time.sleep(0.8)
    try:
        sub = mcp.js(
            "JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(t=>/分钟后|关闭定时/.test(t)))"
        )
    except Exception:
        sub = []
    r.check(
        len(sub) >= 4 and any("15 分钟" in s for s in sub) and any("90 分钟" in s for s in sub),
        "play",
        "睡眠定时含 15/30/60/90 分钟档",
        sub,
    )

    # 快捷键说明面板内容
    is_err, txt = mcp.tool("pc_click", {"text": "快捷键说明"})
    time.sleep(0.8)
    try:
        help_txt = mcp.js(
            "JSON.stringify((function(){var d=[...document.querySelectorAll('div,section')]"
            ".find(e=>e.innerText&&e.innerText.includes('快捷键')&&e.innerText.includes('空格'));"
            "return d?d.innerText.slice(0,400):null;})())"
        )
    except Exception:
        help_txt = None
    r.truthy("play", "快捷键说明面板含键位条目",
             bool(help_txt) and len(str(help_txt)) > 10,
             detail=(str(help_txt or "")[:200] or "not found"))
    if isinstance(help_txt, str) and help_txt:
        r.check("空格" in help_txt, "play", "说明面板含「空格」键位", help_txt[:120])


def probe_persist(r, mcp):
    """8. 数据持久化：设置项写入后 localStorage 能读回（meow.prefs）"""
    print("\n[8] 数据持久化 / meow.prefs")
    mcp.tool("pc_navigate", {"hash": "#/settings"})
    time.sleep(2.0)
    # 关掉可能残留的弹层，避免选项按钮被两次匹配
    mcp.tool("pc_key", {"key": "Escape"})
    time.sleep(0.3)

    # 读初值
    try:
        before = mcp.js(
            "JSON.stringify({prefs:(function(){try{return JSON.parse(localStorage.getItem('meow.prefs')||'null')}catch(e){return 'parse-error'}})()})"
        )
    except Exception as e:
        r.check(False, "persist", "读取初始 meow.prefs", "exception: %s" % e)
        return
    p0 = before.get("prefs")
    r.truthy("persist", "meow.prefs 存在（或可创建）", p0 is not None,
             detail="type=%s" % type(p0).__name__)
    orig_fit = (p0 or {}).get("videoFit") if isinstance(p0, dict) else None

    # 目标值：与当前不同。fitOptions 见 SettingsView.vue:312
    target = "fill" if orig_fit != "fill" else "contain"
    label = {"fill": "拉伸", "contain": "适应", "cover": "铺满"}[target]

    # 用确定性选择器点开「画面缩放」磁贴（play 分区第 0 个 .tile）
    tile_sel = '[data-sec="play"] button.tile'
    is_err, txt = mcp.tool("pc_click", {"selector": tile_sel, "index": 0})
    r.check(not is_err and "clicked" in txt, "persist", "点开「画面缩放」下拉", txt[:120])
    time.sleep(0.8)

    # 选项在 Teleport 到 body 的 .tile-menu 里，按文本精确点
    pick_js = (
        "JSON.stringify((function(){"
        "var m=document.querySelector('.tile-menu');if(!m)return {ok:false,why:'no menu'};"
        "var opts=[...m.querySelectorAll('button')].map(function(b){return b.innerText.trim()});"
        "var b=[...m.querySelectorAll('button')].find(function(x){return x.innerText.trim()===%s});"
        "if(!b)return {ok:false,why:'no option',opts:opts};"
        "b.click();return {ok:true,opts:opts};})())" % json.dumps(label)
    )
    try:
        picked = mcp.js(pick_js)
    except Exception as e:
        r.check(False, "persist", "选择「%s」" % label, "exception: %s" % e)
        return
    r.check(
        picked.get("ok") is True,
        "persist",
        "在 .tile-menu 内精确选中「%s」" % label,
        "opts=%s why=%s" % (picked.get("opts"), picked.get("why")),
    )
    time.sleep(1.0)

    try:
        after = mcp.js(
            "JSON.stringify({prefs:(function(){try{return JSON.parse(localStorage.getItem('meow.prefs')||'null')}catch(e){return 'parse-error'}})(),"
            "tile:(function(){var t=document.querySelector('[data-sec=\"play\"] button.tile');return t?t.innerText.replace(/\\n/g,'/'):null})()})"
        )
    except Exception as e:
        r.check(False, "persist", "读取写入后的 meow.prefs", "exception: %s" % e)
        return
    p1 = after.get("prefs") or {}
    r.eq("persist", "meow.prefs.videoFit 已写入", p1.get("videoFit"), target)
    r.check(
        label in (after.get("tile") or ""),
        "persist",
        "UI 磁贴显示新值",
        "tile=%r" % after.get("tile"),
    )

    # 刷新页面后仍能读回（真正的持久化，而非内存态）
    mcp.js("(function(){location.reload();return 'reloading'})()")
    time.sleep(4.0)
    again = None
    for _ in range(6):
        try:
            again = mcp.js(
                "JSON.stringify({prefs:(function(){try{return JSON.parse(localStorage.getItem('meow.prefs')||'null')}catch(e){return null}})()})"
            )
            break
        except Exception:
            time.sleep(2.0)
    if again:
        r.eq(
            "persist",
            "reload 后 videoFit 仍为写入值",
            (again.get("prefs") or {}).get("videoFit"),
            target,
        )
    else:
        r.skip("persist", "reload 后 videoFit 仍为写入值", "reload 后 pc_eval 不可用")

    # 还原，避免污染用户设置
    if orig_fit and orig_fit != target:
        try:
            mcp.js(
                "JSON.stringify((function(){"
                "var raw=JSON.parse(localStorage.getItem('meow.prefs')||'{}');"
                "raw.videoFit=%s;localStorage.setItem('meow.prefs',JSON.stringify(raw));"
                "window.dispatchEvent(new CustomEvent('meow:prefs',{detail:raw}));return 'restored';})())"
                % json.dumps(orig_fit)
            )
            print("  (已还原 videoFit=%s)" % orig_fit)
        except Exception:
            pass


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--info", default=INFO_PATH)
    args = ap.parse_args()

    r = Runner(args.verbose)

    print("=" * 72)
    print("PC 端冒烟 · meow-player")
    print("通道: MCP HTTP JSON-RPC (POST %s)" % "/mcp")
    print("=" * 72)

    # ---- 环境前置检查
    if not os.path.exists(args.info):
        print("未执行: MCP 信息文件不存在 %s" % args.info)
        print("  应用未启动，或内置 MCP 未挂载。")
        return 2
    try:
        with open(args.info, encoding="utf-8") as f:
            info = json.load(f)
    except Exception as e:
        print("未执行: 解析 %s 失败: %s" % (args.info, e))
        return 2

    mcp = MCP(info)
    if not mcp.mcp_port:
        print("未执行: 在 9339–9346 里没找到 MCP（/health 无 server=meow-player）")
        print("  应用未启动，或 MCP 端口全被占用。")
        return 2
    # pid 是上次运行留下的，不能据此判断"还活着"；真正活着与否看 /health
    print("mcp: port=%d（探测自 9339–9346）  cdp=%s" % (mcp.mcp_port, mcp.cdp_port))
    if info.get("pid"):
        print("info: pid=%s version=%s（*上次*运行记录，仅供参考）"
              % (info.get("pid"), info.get("version")))
    try:
        init = mcp.initialize()
        if "result" not in init:
            print("未执行: MCP initialize 失败: %s" % json.dumps(init, ensure_ascii=False)[:400])
            return 2
        srv = (init.get("result") or {}).get("serverInfo") or {}
        print("MCP serverInfo: %s %s" % (srv.get("name"), srv.get("version")))
    except Exception as e:
        print("未执行: 连不上 MCP %s -> %s" % (mcp.url, e))
        return 2

    health = probe_env(r, mcp)
    plugins = apiserver = None
    if health is not None:
        plugins_result = probe_plugins(r, mcp, health)
        if plugins_result:
            plugins, apiserver = plugins_result
        probe_backend(r, mcp, apiserver)
    else:
        r.skip("plugin", "pc_plugins", "MCP /health 不可达")

    probe_frontend(r, mcp)
    probe_style(r, mcp)
    probe_bundle(r, mcp)
    probe_routes(r, mcp)
    probe_player(r, mcp)
    probe_persist(r, mcp)

    passed, total = r.summary()
    if total == 0:
        return 2
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
