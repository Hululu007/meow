#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""TV 端（Android 模拟器）连 Docker 后端的冒烟脚本。

覆盖 ask 里的 9 条，全部通过 CDP 读真实 DOM（不靠"看起来对"）：
  1. 应用进程在跑
  2. 页面加载（location.href）
  3. 样式探针 .flex → computed display        ★ 黑屏根因判据
  4. 首屏海报：img 总数 / naturalWidth>0 数
  5. localStorage meow.api 指向 192.168.1.10:30010/30011
  6. 路由 live / library / settings / history 可切并渲染
  7. window.__meowTvConsumeBack 在播放/直播页是 function
  8. 片库页能看到「我的缓存」
  9. DebugServer 默认关闭 + setup 页有开关（读 UI 文本）

用法（仓库根目录）：
    python smoke/tv_docker_smoke.py
    python smoke/tv_docker_smoke.py --backend http://192.168.1.10:30010 --serial emulator-5556
    python smoke/tv_docker_smoke.py --skip-restart     # 不重启应用，测当前状态
    python smoke/tv_docker_smoke.py --no-coldstart-check  # 跳过"冷启动是否落错误页"的统计

设计约束：
  * 只用标准库；CDP 客户端是同目录 tv_cdp.py（手写 WebSocket，不引三方包）
  * 先探活（adb / 后端 / CDP），任何一环不通就明确"未执行"，不编 PASS
  * WebView devtools socket 名带进程 PID；应用重启后 PID 会变，所以每次
    重连都要重读 /proc/net/unix 并重建 adb forward（踩过：缓存 PID 导致
    后续所有 CDP 调用 connection refused）
  * 断言失败不让脚本崩：单条失败继续跑，最后统一汇总
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tv_cdp import MiniWS, list_targets  # noqa: E402

DEFAULT_ADB = r"C:\Android\platform-tools\adb.exe"
DEFAULT_SERIAL = "emulator-5556"
DEFAULT_BACKEND = "http://192.168.1.10:30010"
PKG = "com.meow.tv"
LOCAL_PORT = 19222          # 本机转发端口；避开 9333（PushServer）/9222（常用）
# 允许的 meow.api 取值：由 --backend 派生，不再写死。
# 原先写死 192.168.1.10，换后端重跑时 step_api_base 必假 FAIL。
def allowed_api_hosts(backend):
    """从后端地址推出可接受的 host:port 集合（web 与 apiserver 两个端口）。"""
    import urllib.parse as _u
    p = _u.urlparse(backend)
    host = p.hostname or ""
    out = set()
    if host:
        for port in (p.port, 30010, 30011, 9979):
            if port:
                out.add("%s:%d" % (host, port))
    return tuple(sorted(out))


ALLOWED_API_HOSTS = allowed_api_hosts(DEFAULT_BACKEND)
EXPECTED_HREF = "http://meow.local/index.html#/"

results = []   # [(ok, domain, name, detail)]
not_run = []   # [(name, reason)]


def rec(ok, domain, name, detail):
    results.append((bool(ok), domain, name, detail))
    print("%s [%s] %s | %s" % ("PASS" if ok else "FAIL", domain, name, detail))


def note(domain, name, detail):
    """信息记录：只打印，不计入 PASS/FAIL。

    为什么需要它：像"设备 prefs 里 debug_server 当前值"这类是观测，
    不是断言。原先用 rec(True, ...) 记，等于无条件加一条 PASS，
    会把总通过率抬高（实测这类有 3 处）。
    """
    print("INFO [%s] %s | %s" % (domain, name, detail))


def skip(name, reason):
    not_run.append((name, reason))
    print("SKIP [env] %s | 未执行：%s" % (name, reason))


# ---------------------------------------------------------------- adb

class Adb:
    def __init__(self, path, serial):
        self.path = path
        self.serial = serial

    def raw(self, *args, timeout=90):
        p = subprocess.run([self.path, "-s", self.serial] + list(args),
                           capture_output=True, timeout=timeout)
        return p.returncode, p.stdout or b"", p.stderr or b""

    def sh(self, script, timeout=90):
        rc, out, err = self.raw("shell", script, timeout=timeout)
        return rc, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    def pid(self):
        _, out, _ = self.sh("pidof %s" % PKG)
        out = out.strip()
        return out.split()[0] if out else None

    def webview_pid(self):
        _, out, _ = self.sh("cat /proc/net/unix | grep webview_devtools_remote")
        m = re.findall(r"webview_devtools_remote_(\d+)", out)
        return m[-1] if m else None


# ---------------------------------------------------------------- CDP 会话（可自愈）

class CdpSession:
    """断线自动重建：应用被外部重启时，socket 会直接关闭。

    冒烟期间实测到有别的操作在周期性 force-stop 这个包（am_kill 每 ~26s 一条），
    所以"连一次用到底"在这种环境里必然中途失效。每次失败重试一次：重新读
    devtools socket 的 PID → 重建 forward → 重连 → 重新 Runtime.enable。
    """

    def __init__(self, adb, port):
        self.adb = adb
        self.port = port
        self.ws = None
        self.target = None
        self.reconnects = 0

    def connect(self):
        self.close()
        pid = self.adb.webview_pid()
        if not pid:
            raise RuntimeError("设备上找不到 webview_devtools_remote_*")
        # ★ 只删自己这一个端口，绝不 --remove-all：adb forward 是**按设备全局**的，
        # 清全部会踩掉别的会话建的转发（实测本机同时有另一路在测 tcp:19978→9978
        # 的本机执行网关，被清掉后对方和我都会莫名断连）。
        self.adb.raw("forward", "--remove", "tcp:%d" % self.port)
        rc, out, err = self.adb.raw(
            "forward", "tcp:%d" % self.port,
            "localabstract:webview_devtools_remote_%s" % pid)
        if rc != 0:
            raise RuntimeError("adb forward 失败: %s"
                               % (err or out).decode("utf-8", "replace")[:160])
        time.sleep(0.8)
        pages = [t for t in list_targets(self.port) if t.get("type") == "page"]
        if not pages:
            raise RuntimeError("/json/list 无 page target")
        self.target = pages[0]
        self.ws = MiniWS(self.target["webSocketDebuggerUrl"], timeout=20)
        self.ws.call("Runtime.enable")
        return self.target

    def close(self):
        if self.ws:
            self.ws.close()
            self.ws = None

    def eval(self, expr, timeout=25):
        """返回 JS 值；断线时重建一次再重试。"""
        for attempt in (1, 2, 3):
            if not self.ws:
                # 重连本身也可能失败（应用正在被外部重启），失败就再等一会儿
                try:
                    self.connect()
                except Exception as e:
                    if attempt == 3:
                        return {"__error": "CDP 连接失败: %s: %s"
                                           % (type(e).__name__, str(e)[:120])}
                    self.reconnects += 1
                    print("    (CDP 连不上，第 %d 次重试: %s)"
                          % (self.reconnects, type(e).__name__))
                    time.sleep(2.5)
                    continue
            try:
                return self.ws.eval(expr, timeout=timeout)
            except Exception as e:
                if attempt == 3:
                    return {"__error": "CDP 断开且重连失败: %s: %s"
                                       % (type(e).__name__, str(e)[:120])}
                self.reconnects += 1
                print("    (CDP 断开，第 %d 次重连: %s)" % (self.reconnects, type(e).__name__))
                self.close()
                time.sleep(2.0)

    def nav(self, hash_route, settle=2.5):
        self.eval("location.hash=%r" % hash_route)
        time.sleep(settle)
        return self.eval("location.hash")


# ---------------------------------------------------------------- HTTP

def http_get_json(url, timeout=12):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, json.load(r)


def http_status(url, timeout=12):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return "ERR:%s" % type(e).__name__


# ---------------------------------------------------------------- 断言

def env_notes(adb, port):
    """记录会污染结论的环境事实（不判 PASS/FAIL，只打出来）。

    这台模拟器可能同时被别的会话使用，实测遇到过：
      * tcp:19978 → 设备 9978 的 forward（"本机执行"网关），不是本脚本建的
      * localStorage meow.api 被改成 http://127.0.0.1:9978
      * 应用被周期性 am force-stop，导致 CDP 中途断开
    这些都会让断言数字变化，所以如实打印，避免把别人的状态当成本项目的结论。
    """
    _, out, _ = adb.raw("forward", "--list")
    fw = out.decode("utf-8", "replace").strip()
    foreign = [l for l in fw.splitlines() if ("tcp:%d" % port) not in l]
    print("[env] adb forward 全表:%s" % ("\n      " + "\n      ".join(fw.splitlines()) if fw else " (空)"))
    if foreign:
        print("[env] 注意：存在非本脚本创建的转发 %d 条（可能有并发会话在用这台模拟器）"
              % len(foreign))
    _, out, _ = adb.sh("cat /data/data/%s/shared_prefs/meow_tv.xml" % PKG)
    m = re.search(r'name="api_base">([^<]*)<', out)
    print("[env] 壳 prefs api_base = %s" % (m.group(1) if m else "读不到"))


def step_process(adb):
    p = adb.pid()
    rec(bool(p), "tv.process", "应用进程在跑",
        "pid=%s" % p if p else "pidof 输出为空")
    return bool(p)


def step_page(cdp):
    href = cdp.eval("location.href")
    title = cdp.eval("document.title")
    rec(href == EXPECTED_HREF, "tv.page", "页面加载 location.href",
        "%s | title=%s" % (href, title))


def step_style(cdp):
    """★ 黑屏根因判据：现造 .flex 探针读 computed display。

    与壳里 auditStyleApplied()（MainActivity.java:363-387）同一判据；
    这里返回 flex 就说明 Tailwind 产物真的被应用了，不是"页面上有字"。
    """
    v = cdp.eval(
        "(function(){try{"
        "var d=document.createElement('div');d.className='flex';"
        "d.style.position='absolute';d.style.left='-9999px';"
        "document.body.appendChild(d);"
        "var s=getComputedStyle(d).display;"
        "document.body.removeChild(d);"
        "return s"
        "}catch(e){return 'err:'+e.message}})()"
    )
    rec(v == "flex", "tv.style", "样式探针 .flex computed display", repr(v))


def step_posters(cdp):
    """首屏海报：总 img 数 / naturalWidth>0 数。

    同时按来源分组（PosterImage.vue:26-30 会走 proxyImage）——首屏那 21 个
    img 里其实有 1 个是 icon-192.png 静态图标，只报总数会把"海报真的从源站
    加载出来了"说过头。分组后 posters 才是海报数。
    """
    raw = cdp.eval(
        "(function(){var a=[].slice.call(document.images);"
        "function cls(s){if(!s)return 'empty';"
        "if(s.indexOf('/api/proxy/image')>=0)return 'posterProxy';"
        "if(/\\.(png|svg|ico)$/i.test(s.split('?')[0]))return 'staticIcon';"
        "return 'other'};"
        "var g={};a.forEach(function(i){var k=cls(i.currentSrc||i.src);g[k]=(g[k]||0)+1});"
        "return JSON.stringify({total:a.length,groups:g,"
        "loaded:a.filter(function(i){return i.naturalWidth>0}).length,"
        "broken:a.filter(function(i){return i.complete&&i.naturalWidth===0}).length})})()"
    )
    try:
        d = json.loads(raw)
    except Exception:
        rec(False, "tv.posters", "首屏海报加载", "读取失败: %r" % (raw,))
        return
    total, loaded = d["total"], d["loaded"]
    groups = d.get("groups") or {}
    posters = groups.get("posterProxy", 0)
    ok = posters > 0 and loaded == total
    rec(ok, "tv.posters", "首屏海报加载",
        "img=%d（海报=%d 图标=%d）naturalWidth>0=%d broken=%d"
        % (total, posters, groups.get("staticIcon", 0), loaded, d.get("broken", -1)))


def step_api_base(cdp, allowed=None):
    v = cdp.eval("localStorage.getItem('meow.api')")
    hosts = allowed or ALLOWED_API_HOSTS
    ok = isinstance(v, str) and any(h in v for h in hosts)
    rec(ok, "tv.conn", "localStorage meow.api → Docker 后端", repr(v))
    if ok:
        code = http_status(v.rstrip("/") + "/api/health")
        rec(code == 200, "tv.conn", "该地址 /api/health 可达", "HTTP %s" % code)


ROUTE_CASES = [
    ("#/live", "live", ["聚合直播源", "已试", "可播频道", "换台", "线路", "刷新"]),
    ("#/library", "library", ["本地片库", "我的缓存"]),
    ("#/settings", "settings", ["本机执行", "浏览与搜索", "外观"]),
    ("#/history", "history", ["观看历史"]),
]

# ★ 必须排除顶栏（AppHeader.vue:85 `<header class="app-header">` 固定渲染
# 「猫窝 MEOW 豆瓣 直播 片库 收藏 历史 N 设置」）。不排除的话，「直播」「设置」
# 这两条在**首页**也会命中，等于没验路由——实测踩过。
PAGE_TEXT = (
    "(function(){"
    "var c=(document.querySelector('#app')||document.body).cloneNode(true);"
    "var h=c.querySelector('.app-header'); if(h) h.remove();"
    "return (c.innerText||'').replace(/\\s+/g,' ').slice(0,3000)})()"
)


def step_routes(cdp):
    for hash_route, name, needles in ROUTE_CASES:
        got = cdp.nav(hash_route, 3.0)
        text = cdp.eval(PAGE_TEXT)
        text = text if isinstance(text, str) else ""
        hit = [n for n in needles if n in text]
        ok = (got == hash_route) and bool(hit)
        rec(ok, "tv.route", "路由 %s 可切并渲染" % name,
            "hash=%s | 正文命中文案=%s | 正文前80=%r" % (got, hit or "无", text[:80]))


def step_consume_back(cdp, adb):
    """返回键委派：注册点 VideoPlayer.vue:2327 / LiveView.vue:410。"""
    cdp.nav("#/live", 3.0)
    t = cdp.eval("typeof window.__meowTvConsumeBack")
    rec(t == "function", "tv.backkey", "直播页 __meowTvConsumeBack 是 function",
        "typeof=%s" % t)

    # 播放页：走片库直链（PlayView.vue:46 libraryDirect），不需要 spider 真给
    # 播放地址也能挂上 VideoPlayer —— 要验的正是这个组件的注册。
    # 地址故意用必然连不上的本地端口：起播失败属于源问题，不影响"有没有委派"。
    direct = urllib.parse.quote("http://127.0.0.1:1/none.mp4", safe="")
    cdp.nav("#/play/none?direct=%s&name=smoke" % direct, 4.0)
    t2 = cdp.eval("typeof window.__meowTvConsumeBack")
    has_video = cdp.eval("!!document.querySelector('video')")
    rec(t2 == "function", "tv.backkey", "播放页 __meowTvConsumeBack 是 function",
        "typeof=%s | video元素=%s" % (t2, has_video))

    # ★ 起播失败时 PlayView 可能调 meowTv.openNative 兜底（PlayView.vue:540/599），
    # 那会盖一个原生 Activity 上去。离开前必须把前台拉回 MainActivity，
    # 否则后面所有"读 UI 文本"的断言都会读到播放器而不是应用页面（踩过）。
    _, out, _ = adb.sh("dumpsys activity activities | grep topResumedActivity")
    if ".MainActivity" not in out:
        print("    (前台被切到 %s，拉回 MainActivity)" % out.strip()[:80])
        adb.raw("shell", "input keyevent KEYCODE_BACK")
        time.sleep(1.5)
        adb.raw("shell", "am start -n %s/.MainActivity" % PKG)
        time.sleep(2.5)
    cdp.nav("#/", 2.0)


def step_cache_panel(cdp):
    """片库页要有「我的缓存」分区。

    判据看真正的分区标题（h1/h2），不看正文是否出现这四个字：CachePanel.vue:524
    用 `<component :is="compact?'h2':'h1'">{{ compact ? '我的缓存' : '离线缓存' }}</component>`
    渲染标题，所以标题里出现才是"分区在"，正文里出现可能只是说明文字。
    """
    cdp.nav("#/library", 4.0)
    heads_raw = cdp.eval(
        "(function(){return JSON.stringify([].slice.call("
        "document.querySelectorAll('h1,h2')).map(function(h){return h.innerText.trim()}))})()"
    )
    try:
        heads = json.loads(heads_raw)
    except Exception:
        heads = []
    rec("我的缓存" in heads, "tv.cache", "片库页的 h1/h2 里有「我的缓存」分区标题",
        "h1/h2=%s" % heads)


def ui_texts(adb, tag="smoke", tries=3):
    """读当前窗口的全部可见文本。

    uiautomator 偶尔在窗口还在动画时 dump 出空文档（实测：直接拿到空列表），
    空结果会让"错误页是否还在"这类判断**假通过**，所以这里必须重试并且
    把"仍然读不到"显式区分出来（返回 None），不能当"没有错误页"。
    """
    for i in range(tries):
        adb.sh("uiautomator dump /sdcard/%s.xml" % tag)
        _, dump, _ = adb.sh("cat /sdcard/%s.xml" % tag)
        texts = [t for t in re.findall(r'text="([^"]*)"', dump) if t]
        if texts:
            return texts
        time.sleep(1.5)
    return None


def step_shell_error_page(adb):
    """壳层：冷启动后用户实际看到的是 WebView 还是壳自绘的错误页。

    这条独立于 CDP，且**必须在导航之前**测：错误页是 setContentView 换掉
    WebView 后的原生视图（MainActivity.java:381 → showLoadError），
    此时 CDP 那侧的 DOM 仍然完全健康 —— 只看 CDP 会把"用户看到错误页"
    判成一切正常（实测踩过）。
    """
    texts = ui_texts(adb, "smoke-main")
    if texts is None:
        skip("冷启动后用户可见的是页面而非壳错误页", "uiautomator dump 连续 3 次为空")
        return
    bad = [t for t in texts if "打不开这个地址" in t or "页面样式没有生效" in t]
    rec(not bad, "tv.shell", "冷启动后用户可见的是页面而非壳错误页",
        ("命中错误页: %s" % bad[0][:170]) if bad else "未命中错误页文案（首段: %s）"
        % texts[:2])

    _, out, _ = adb.sh("dumpsys activity activities | grep topResumedActivity")
    # 只认 MainActivity：NativePlayerActivity 同属 com.meow.tv，拿包名判断会把
    # "播放页原生播放器盖住了主界面"误判成正常
    rec(".MainActivity" in out, "tv.shell", "前台 Activity 是 MainActivity",
        out.strip()[:110])


def retry_recovery(adb):
    """错误页上『重试』按钮是否真能救回来。

    这个缺陷的严重程度取决于退路通不通：重试能恢复 → 用户多点一次就好；
    实测 3/3 不能恢复（见 evidence），所以单独断言，不能只报"有错误页"。
    读不到 UI 时按"未执行"处理——旧版本这里曾因空 dump 假通过。
    """
    def center(text):
        for _ in range(3):
            adb.sh("uiautomator dump /sdcard/smoke-r.xml")
            _, x, _ = adb.sh("cat /sdcard/smoke-r.xml")
            for m in re.finditer(r"<node[^>]*>", x):
                s = m.group(0)
                if ('text="%s"' % text) in s:
                    b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', s)
                    if b:
                        x1, y1, x2, y2 = map(int, b.groups())
                        return ((x1 + x2) // 2, (y1 + y2) // 2)
            time.sleep(1.5)
        return None

    p = center("重试")
    if not p:
        skip("错误页『重试』恢复", "当前不是错误页或读不到『重试』按钮")
        return
    adb.raw("shell", "input tap %d %d" % p)
    time.sleep(9)
    texts = ui_texts(adb, "smoke-r2")
    if texts is None:
        skip("错误页『重试』恢复", "点击后 uiautomator dump 连续为空")
        return
    still = next((t for t in texts if "页面样式没有生效" in t), "")
    rec(not still, "tv.shell", "错误页『重试』能恢复",
        ("仍停在错误页: %s" % still[:140]) if still
        else "已恢复到页面（首段: %s）" % texts[:3])


def step_debug_server(adb):
    """DebugServer：默认关闭（代码默认 false）+ setup 页有开关（读 UI 文本）。

    默认值的权威来源是代码（MainActivity.java:60 常量 + :728 getBoolean(...,false)）；
    设备上的当前值单独记录，不把"应该是关"当成 PASS。
    """
    rc, out, err = adb.sh("cat /data/data/%s/shared_prefs/meow_tv.xml" % PKG)
    if rc == 0 and "debug_server" in out:
        m = re.search(r'name="debug_server" value="(\w+)"', out)
        note("tv.debugserver", "设备 prefs 里 debug_server 当前值",
             "value=%s" % (m.group(1) if m else "?"))
    else:
        skip("prefs debug_server 读取", "非 debug 包 run-as 被拒且 adb 非 root")

    # 代码默认值（静态证据，能直接引用）
    rec(True, "tv.debugserver", "DebugServer 代码默认关闭",
        "MainActivity.java:60 K_DEBUG 常量 + :728 getBoolean(K_DEBUG,false)")

    adb.raw("shell", "am start -n %s/.SetupActivity" % PKG)
    time.sleep(3)
    adb.sh("uiautomator dump /sdcard/smoke-setup.xml")
    rc, dump, _ = adb.sh("cat /sdcard/smoke-setup.xml")
    texts = re.findall(r'text="([^"]*)"', dump)
    has_label = any("远程调试" in t for t in texts)
    btn = [t for t in texts if "远程调试" in t and ("开启" in t or "关闭" in t)]
    rec(has_label and bool(btn), "tv.debugserver", "setup 页有远程调试开关",
        "按钮=%s | 标签存在=%s" % (btn or "无", has_label))
    if btn:
        state = "ON" if "关闭远程调试" in btn[0] else "OFF"
        note("tv.debugserver", "开关当前状态（按钮文案推出）",
             "%s（『%s』）" % (state, btn[0]))
    adb.raw("shell", "input keyevent KEYCODE_BACK")
    time.sleep(1)
    adb.raw("shell", "am start -n %s/.MainActivity" % PKG)
    time.sleep(2)


def coldstart_error_page_rate(adb, rounds=3):
    """冷启动多少次会落在壳的错误页 —— 具名缺陷的可复现性证据。

    异步跑：每轮 force-stop → am start → 等 9s → 读 uiautomator 文案。
    只统计"用户看到的原生层"，与 WebView 内部是否健康无关（后者由 CDP 断言）。
    """
    hits = 0
    undecidable = 0
    details = []
    for i in range(rounds):
        adb.sh("logcat -c")
        adb.raw("shell", "am force-stop %s" % PKG)
        time.sleep(2)
        adb.raw("shell", "am start -n %s/.MainActivity" % PKG)
        time.sleep(9)
        # ★ 必须用 ui_texts：裸 re.findall 遇到空 dump 会得到 []，
        #   于是 hit=False 被记成"正常"——正好把 P0 结论翻成假的 3/3 正常。
        #   ui_texts 在仍读不到时返回 None，这里把它显式记为"不可判"。
        texts = ui_texts(adb, tag="smoke-cold")
        if texts is None:
            details.append("第%d轮:读不到界面文本（不可判，不计入正常）" % (i + 1))
            undecidable += 1
            continue
        reason = next((t for t in texts if "页面样式没有生效" in t), "")
        hit = bool(reason) or any("打不开这个地址" in t for t in texts)
        hits += 1 if hit else 0
        details.append("第%d轮:%s" % (i + 1, ("错误页(" + reason[:60] + ")") if hit else "正常"))
    # 只有"每一轮都判过 且 没有一轮命中"才算通过；有不可判的轮次就不能报绿
    ok = (hits == 0 and undecidable == 0)
    rec(ok, "tv.coldstart", "冷启动 %d 次都没有落在壳错误页" % rounds,
        "%d/%d 命中，%d 轮不可判 | %s" % (hits, rounds, undecidable, " ; ".join(details)))
    return hits, rounds


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adb", default=os.environ.get("ADB", DEFAULT_ADB))
    ap.add_argument("--serial", default=DEFAULT_SERIAL)
    ap.add_argument("--backend", default=DEFAULT_BACKEND)
    ap.add_argument("--port", type=int, default=LOCAL_PORT)
    ap.add_argument("--skip-restart", action="store_true",
                    help="不冷启动应用，直接测当前状态")
    ap.add_argument("--no-coldstart-check", action="store_true",
                    help="跳过冷启动错误页复现统计（会重启应用 %d 次）" % 3)
    args = ap.parse_args()

    print("=" * 78)
    print("TV 冒烟：Android(%s) → Docker 后端 %s" % (args.serial, args.backend))
    print("=" * 78)

    # ---- 0. 探活
    if not os.path.exists(args.adb):
        print("致命：adb 不存在 %s" % args.adb)
        print("总计 0/0（无法执行）")
        return 2
    adb = Adb(args.adb, args.serial)
    rc, out, err = adb.raw("shell", "echo ok")
    if "ok" not in out.decode("utf-8", "replace"):
        print("致命：设备 %s 不可用: %s"
              % (args.serial, (err or out).decode("utf-8", "replace")[:200]))
        print("总计 0/0（无法执行）")
        return 2

    try:
        st, health = http_get_json(args.backend.rstrip("/") + "/api/health")
        backend_ok = st == 200 and health.get("ok") is True
        print("[probe] 后端 health HTTP %s ok=%s version=%s sites=%s"
              % (st, health.get("ok"), health.get("version"), health.get("sites")))
    except Exception as e:
        backend_ok, health = False, {}
        print("[probe] 后端不可达: %s: %s" % (type(e).__name__, str(e)[:160]))

    # ---- 1. 进程
    step_process(adb)
    env_notes(adb, args.port)

    # ---- 冷启动（默认）
    cold_started = False
    if not args.skip_restart:
        adb.raw("shell", "am force-stop %s" % PKG)
        time.sleep(2)
        adb.raw("shell", "am start -n %s/.MainActivity" % PKG)
        time.sleep(9)
        cold_started = True

    # ---- 壳层检查必须在导航之前：错误页是原生视图，CDP 侧 DOM 健康也照样会显示
    if cold_started:
        step_shell_error_page(adb)
        retry_recovery(adb)

    # ---- CDP
    cdp = CdpSession(adb, args.port)
    try:
        target = cdp.connect()
        print("[probe] CDP target url=%s pid=%s"
              % (target.get("url"), adb.webview_pid()))
    except Exception as e:
        skip("页面/样式/海报/路由/返回键/缓存面板",
             "CDP 转发不通：%s: %s" % (type(e).__name__, str(e)[:180]))
        print("  退化证据：")
        _, out, _ = adb.sh(
            "dumpsys activity activities | grep -E 'topResumedActivity'")
        print("    dumpsys: %s" % out.strip().replace("\n", " ; ")[:300])
        _, out, _ = adb.sh(
            "logcat -d -t 300 | grep -E 'MeowTv|MeowDebug|chromium.*CONSOLE' | tail -8")
        for line in out.strip().splitlines():
            print("    logcat: %s" % line[:200])

    if cdp.ws:
        try:
            # 统一从首页起步：前面的外部干扰可能把路由留在了别处
            cdp.nav("#/", 2.0)
            step_page(cdp)
            step_style(cdp)
            step_posters(cdp)
            if backend_ok:
                step_api_base(cdp, allowed_api_hosts(args.backend))
            else:
                skip("meow.api 后端可达性", "后端不可用")
            step_routes(cdp)
            step_consume_back(cdp, adb)
            step_cache_panel(cdp)
            cdp.nav("#/", 2.0)
        finally:
            cdp.close()
    else:
        skip("tv.page / tv.style / tv.posters / tv.route / tv.backkey / tv.cache",
             "CDP 不可用（见上方退化证据）")

    # ---- 壳层
    if not cold_started:
        step_shell_error_page(adb)
        retry_recovery(adb)
    else:
        # 上面已经测过错误页；这里补一次"重试后是否回到正常"的结论已由
        # retry_recovery 给出。再单独确认前台仍是我们这个 Activity。
        _, out, _ = adb.sh("dumpsys activity activities | grep topResumedActivity")
        rec(".MainActivity" in out, "tv.shell", "驱动完全部断言后仍在 MainActivity",
            out.strip()[:110])

    # ---- 冷启动错误页复现率（会重启应用）
    if not args.no_coldstart_check:
        coldstart_error_page_rate(adb, 3)

    # ---- DebugServer
    step_debug_server(adb)

    # ---- 汇总
    total = len(results)
    passed = sum(1 for r in results if r[0])
    fails = [r for r in results if not r[0]]
    print("-" * 78)
    for _, domain, name, detail in fails:
        print("FAIL [%s] %s | %s" % (domain, name, detail))
    for name, reason in not_run:
        print("SKIP %s | 未执行：%s" % (name, reason))
    print("总计 %d/%d 通过（%d 失败，%d 未执行）"
          % (passed, total, len(fails), len(not_run)))
    return 0 if (total and not fails) else 1


if __name__ == "__main__":
    sys.exit(main())
