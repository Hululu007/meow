#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Web 端冒烟（浏览器 + Docker 后端）。目标：OECT 上的前端 nginx + apiserver。

用法:
    python smoke/smoke_web.py
    python smoke/smoke_web.py --web http://192.168.1.10:30010 --api http://192.168.1.10:30011

设计约束（见 AGENTS.md §5）:
- 只用标准库，不装依赖。
- 先探活，服务不在就整体报「未执行：<原因>」，不编 PASS。
- 每条断言都打印 PASS/FAIL + 实测值，末尾给总计。
- 每条断言必须带可观察证据（HTTP 状态码 + body 片段 / 头部值）。

★ 关于被测版本的实测事实（2026-10-26）:
  部署版本 /api/health 报 version=0.9.15，= tag v0.9.15。
  该 tag 的 ApiServer.java **没有** routes/ 包，也**没有** /api/logs、
  /api/cache/{status,tasks,batch}、/api/health/{probe,degrade,state} 的显式路由
  （用 `git show v0.9.15:server/host/src/ApiServer.java | grep -c 'api/logs'` → 0）。
  这些端点只在本地 HEAD 存在（ApiServer.java:829 + routes/LogRoutes.java）。
  脚本照实断言，失败时把「版本缺口」和「应用缺陷」分开写进证据。
"""

import argparse
import json
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_WEB = "http://192.168.1.10:30010"
DEFAULT_API = "http://192.168.1.10:30011"
TIMEOUT = 45
UA = "meow-smoke/1.0"

RESULTS = []  # (ok, domain, name, evidence)


def http(method, url, body=None, headers=None, timeout=TIMEOUT):
    """返回 (status, headers(dict lower), body_bytes, elapsed)。异常状态记 0。"""
    data = None
    hdrs = {"User-Agent": UA}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            h = {k.lower(): v for k, v in r.getheaders()}
            return r.status, h, r.read(), 0.0
    except urllib.error.HTTPError as e:
        h = {k.lower(): v for k, v in e.headers.items()}
        return e.code, h, e.read(), 0.0
    except Exception as e:  # 连接失败/超时/DNS
        return 0, {}, ("%s: %s" % (type(e).__name__, e)).encode("utf-8", "replace"), 0.0


def js(body):
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return None


def snippet(body, n=160):
    s = body.decode("utf-8", "replace").replace("\n", " ").replace("\r", " ")
    return s[:n]


def check(cond, domain, name, evidence):
    RESULTS.append((bool(cond), domain, name, evidence))
    print(("PASS" if cond else "FAIL") + " [%s] %s | %s" % (domain, name, evidence))
    return bool(cond)


def skip(domain, name, reason):
    """环境不具备（不是失败，但也不计 PASS）。"""
    RESULTS.append((None, domain, name, "SKIP " + reason))
    print("SKIP [%s] %s | %s" % (domain, name, reason))


def q(s):
    return urllib.parse.quote(str(s), safe="")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", default=DEFAULT_WEB)
    ap.add_argument("--api", default=DEFAULT_API)
    ap.add_argument("--watch-word", default="庆余年")
    args = ap.parse_args()

    WEB = args.web.rstrip("/")
    API = args.api.rstrip("/")
    WD = args.watch_word

    print("=" * 78)
    print("meow Web 冒烟  web=%s  api=%s" % (WEB, API))
    print("=" * 78)

    # ---------------------------------------------------------------- 0 探活
    st, _, body, _ = http("GET", API + "/api/health")
    h = js(body)
    if st != 200 or not isinstance(h, dict) or not h.get("ok"):
        print("未执行：后端 %s/api/health 不可用（HTTP %s，body=%s）" % (API, st, snippet(body)))
        print("总计: 0/0 通过 —— 未执行")
        return 2
    version = h.get("version")
    sites_declared = h.get("sites")

    st_w, _, body_w, _ = http("GET", WEB + "/api/health")
    hw = js(body_w)
    check(st_w == 200 and isinstance(hw, dict) and hw.get("ok"),
          "探活", "前端同源 /api/health 可用",
          "HTTP %s ok=%s version=%s" % (st_w, (hw or {}).get("ok"), (hw or {}).get("version")))
    check(isinstance(hw, dict) and hw.get("version") == version,
          "探活", "前端反代后端版本一致",
          "front=%s api=%s" % ((hw or {}).get("version"), version))

    # 1 ------------------------------------------------------------ 健康与站点表
    print("-" * 78)
    check(h.get("ok") is True, "health", "/api/health ok=true",
          "HTTP %s ok=%s spiderJar=%s dataDir=%s" % (st, h.get("ok"), h.get("spiderJar"), h.get("dataDir")))
    check(isinstance(version, str) and re.match(r"^\d+\.\d+\.\d+$", version or ""),
          "health", "version 形如 x.y.z", "version=%s" % version)
    check(isinstance(sites_declared, int) and sites_declared > 0,
          "health", "sites > 0", "sites=%s ext=%s degradedCount=%s"
          % (sites_declared, h.get("ext"), h.get("degradedCount")))
    check(h.get("spiderJar") is True, "health", "spider jar 可加载", "spiderJar=%s" % h.get("spiderJar"))
    caps = h.get("capabilities") or []
    check(len(caps) > 0, "health", "capabilities 非空", "capabilities=%s" % caps)

    st, _, body, _ = http("GET", API + "/api/sites")
    sj = js(body) or {}
    slist = sj.get("sites") or []
    check(st == 200 and len(slist) > 0, "health", "/api/sites 站点表非空",
          "HTTP %s sites=%d sample_key=%s"
          % (st, len(slist), (slist[0].get("key") if slist else None)))
    check(all(isinstance(s, dict) and s.get("key") and s.get("name") for s in slist),
          "health", "/api/sites 每条都有 key+name",
          "checked=%d first=%s" % (len(slist), {k: slist[0].get(k) for k in ("key", "name", "api")} if slist else None))
    check(len(slist) == sites_declared, "health", "/api/sites 条数 = health.sites",
          "sites_list=%d health.sites=%s" % (len(slist), sites_declared))

    # 2 ------------------------------------------------------------ 首页 / 搜索
    print("-" * 78)
    st, _, body, _ = http("POST", API + "/api/search", {"wd": WD}, timeout=120)
    sr = js(body) or {}
    groups = sr.get("groups") if isinstance(sr, dict) else None
    check(st == 200 and isinstance(groups, list), "search", "POST /api/search 返回 groups 数组",
          "HTTP %s keys=%s groups=%s"
          % (st, list(sr.keys()) if isinstance(sr, dict) else None,
             (len(groups) if isinstance(groups, list) else None)))
    check(isinstance(groups, list) and len(groups) > 0, "search", "groups 非空（条数随源站）",
          "groups=%s skippedDegraded=%s wd=%s"
          % (len(groups or []), sr.get("skippedDegraded"), WD))

    # 逐个候选验证，直到找到一个「POST detail 真有内容」的站。
    #
    # 【为什么要循环】只取 search 的第一条会让脚本不可重复：每次跑命中的站不同，
    # 有的站 detail 返回 1 条但字段全空（实测 AppDrama2），有的站要 curl 的 body 才认。
    # 判据用「vod_name 非空 + vod_play_from 非空」，这才是能继续走播放的最小前提。
    picked = None
    shape_ok = True
    candidates = []
    for g in (groups or []):
        if not isinstance(g, dict) or not g.get("vod_name"):
            shape_ok = False
            continue
        srcs = g.get("sources")
        if not isinstance(srcs, list) or not srcs:
            shape_ok = False
            continue
        for s in srcs:
            if s.get("site") and s.get("vod_id"):
                candidates.append((s["site"], s["vod_id"], g.get("vod_name")))
    check(shape_ok, "search", "每个 group 有 vod_name + sources[site,vod_id]",
          "groups_scanned=%d candidates=%d" % (len(groups or []), len(candidates)))

    tried = []
    picked_item = None
    picked_play = None
    picked_ep = None
    picked_flag = None
    # 候选先后决定"挑中哪个站"，会直接写进断言名与证据值。
    # 不排序时顺序取决于 searchAll 的并发返回顺序 → 两次跑挑到不同站，结果不可比。
    # 先按站名排序去重，每个站只试一次，最多试 12 个站。
    ordered = []
    seen_sites = set()
    for c in sorted(candidates, key=lambda x: (x[0], str(x[1]))):
        if c[0] in seen_sites:
            continue
        seen_sites.add(c[0])
        ordered.append(c)
    for site, vid, name in ordered[:12]:
        st, _, body, _ = http("POST", API + "/api/%s/detail" % q(site), {"id": vid}, timeout=60)
        dj = js(body) or {}
        lst = dj.get("list") if isinstance(dj, dict) else []
        it0 = lst[0] if isinstance(lst, list) and lst else {}
        if not (st == 200 and it0.get("vod_name") and it0.get("vod_play_from")):
            tried.append((site, "detail", st))
            continue
        # 再验一次播放：detail 有线路 ≠ play 能出 url（实测 AppGet 的线路会抛
        # ArrayIndexOutOfBoundsException）。只按 detail 选站会让脚本每次结果不同。
        f0 = (it0.get("vod_play_from") or "").split("$$$")[0]
        eps0 = (it0.get("vod_play_url") or "").split("$$$")[0]
        ep0 = eps0.split("#")[0] if eps0 else ""
        ep_id0 = ep0.split("$", 1)[1] if "$" in ep0 else ep0
        stp, _, bodyp, _ = http("POST", API + "/api/%s/play" % q(site),
                                {"flag": f0, "id": ep_id0}, timeout=90)
        pj0 = js(bodyp) or {}
        if stp == 200 and pj0.get("url"):
            picked = (site, vid, name)
            picked_item = it0
            picked_play = pj0
            picked_ep = ep_id0
            picked_flag = f0
            tried.append((site, "detail+play", "OK"))
            break
        tried.append((site, "play", stp, bool(pj0.get("url")), pj0.get("msg") or pj0.get("parse")))
    print("      候选探测(取到 detail+play 都可用即停): %s" % (tried,))

    if not picked:
        skip("detail", "详情/播放链路", "搜索结果里没有可用的 {site,vod_id}")
        picked_site = None
    else:
        picked_site, picked_id, picked_name = picked
    # 选一个已知能出 home 的站点做首页断言：优先用搜索命中的站，失败再退 Hxq
    home_site = picked_site or "Hxq"
    st, _, body, _ = http("GET", API + "/api/%s/home" % q(home_site), timeout=60)
    hj = js(body) or {}
    klass = hj.get("class") if isinstance(hj, dict) else None
    if st != 200 or not isinstance(klass, list) or not klass:
        # 备用站，避免把「单站挂了」当成「首页全挂」
        st2, _, body2, _ = http("GET", API + "/api/Hxq/home", timeout=60)
        hj2 = js(body2) or {}
        if st2 == 200 and isinstance(hj2.get("class"), list) and hj2.get("class"):
            home_site, st, klass = "Hxq", st2, hj2.get("class")
            body = body2
    check(st == 200 and isinstance(klass, list) and len(klass) > 0,
          "home", "/api/%s/home 能出 class" % home_site,
          "HTTP %s class=%s first=%s"
          % (st, (len(klass) if isinstance(klass, list) else None),
             (klass[0] if isinstance(klass, list) and klass else snippet(body))))

    st, _, body, _ = http("POST", API + "/api/%s/category" % q(home_site),
                          {"id": "1", "page": "1"}, timeout=90)
    cj = js(body) or {}
    clist = cj.get("list") if isinstance(cj, dict) else None
    check(st == 200 and isinstance(clist, list) and len(clist) > 0,
          "category", "/api/%s/category 分类分页有 list" % home_site,
          "HTTP %s list=%s pagecount=%s first=%s"
          % (st, (len(clist) if isinstance(clist, list) else None), cj.get("pagecount"),
             (clist[0].get("vod_name") if isinstance(clist, list) and clist else snippet(body))))

    # 3 ------------------------------------------------------------ 详情与播放
    print("-" * 78)
    if picked_site:
        site, vid = picked_site, picked_id

        # 3a 任务书原文形态：GET ?id=（照跑，照实报）
        # 【实测】站点分派只 read(requestBody)，从不读 query（ApiServer.java:886-893），
        # 所以 GET ?id= 到 callRaw 时 id 是空串；部分站因此抛 InvocationTargetException
        # 返 500，部分站返字段全空的 1 条 list。这是契约形态问题，不是源站不可达。
        st, _, body, _ = http("GET", API + "/api/%s/detail?id=%s" % (q(site), q(vid)), timeout=60)
        dj = js(body) or {}
        glist = dj.get("list") if isinstance(dj, dict) else None
        gname = (glist[0].get("vod_name") if isinstance(glist, list) and glist else "") or ""
        check(st == 200 and isinstance(glist, list) and len(glist) > 0 and bool(gname),
              "detail", 'GET /api/{site}/detail?id= 有非空 list（任务书原文形态）',
              "HTTP %s list=%s first.vod_name=%r body=%s | 契约: 前端实际用 POST {id}"
              "（client/apps/web/src/api/index.ts:342；站点分派不读 query: ApiServer.java:886-893）"
              % (st, (len(glist) if isinstance(glist, list) else None), gname, snippet(body, 80)))

        # 3b 真实契约：POST {id}
        st, _, body, _ = http("POST", API + "/api/%s/detail" % q(site), {"id": vid}, timeout=60)
        dj = js(body) or {}
        lst = dj.get("list") if isinstance(dj, dict) else []
        item = lst[0] if isinstance(lst, list) and lst else {}
        if not item.get("vod_play_from") and picked_item:
            item = picked_item  # 复用在候选探测里已验证过的那条
        check(st == 200 and isinstance(lst, list) and len(lst) > 0 and bool(item.get("vod_name")),
              "detail", "POST /api/{site}/detail {id} 返回非空 list（真实契约）",
              "HTTP %s list=%d vod_name=%s vod_id=%s"
              % (st, len(lst) if isinstance(lst, list) else -1,
                 item.get("vod_name"), item.get("vod_id")))
        froms = (item.get("vod_play_from") or "").split("$$$")
        urls = (item.get("vod_play_url") or "").split("$$$")
        check(bool(froms) and bool(urls) and len(froms) == len(urls) and froms[0] != "",
              "detail", "detail 带 vod_play_from / vod_play_url 且线路数对齐",
              "from=%s lines=%d/%d first_ep=%s"
              % (froms[:3], len(froms), len(urls),
                 (urls[0].split("#")[0][:60] if urls and urls[0] else "")))

        # 3c 播放：POST {flag,id}（复用候选探测里已验证通过的那次结果，避免重复打源站）
        flag = picked_flag or (froms[0] if froms and froms[0] else "")
        first_ep = picked_ep or ""
        st, _, body, _ = (200, {}, json.dumps(picked_play or {}).encode(), 0.0) if picked_play else \
            http("POST", API + "/api/%s/play" % q(site),
                 {"flag": flag, "id": first_ep}, timeout=90)
        pj = js(body) or {}
        ok_play = isinstance(pj, dict) and (bool(pj.get("url")) or pj.get("parse") in (1, "1"))
        check(st == 200 and ok_play, "play", "POST /api/{site}/play {flag,id} 有 url 或 parse",
              "HTTP %s flag=%r parse=%s url=%s msg=%s"
              % (st, flag, pj.get("parse"), (pj.get("url") or "")[:110], pj.get("msg")))
        check(isinstance(pj, dict) and ("header" in pj or pj.get("parse") is not None),
              "play", "play 返回 CatVod 形状（header/parse）",
              "keys=%s" % (sorted(pj.keys()) if isinstance(pj, dict) else None))

        # 3d 任务书原文形态：GET ?id=
        # 【实测】query 不进 callRaw → id 为空 → spider 返回 parse=1 但 url=""（或 msg="Empty ID"）。
        # 判据只认「拿到非空 url」：parse=1 配空 url 播不了，按「有 parse 就算通」会假 PASS
        # （AppDrama2 实测就是这种形态，第一版脚本因此误判为 PASS）。
        st, _, body, _ = http("GET", API + "/api/%s/play?id=%s" % (q(site), q(first_ep)), timeout=90)
        pj = js(body) or {}
        get_url = pj.get("url") or ""
        check(st == 200 and bool(get_url),
              "play", "GET /api/{site}/play?id= 能拿到可播 url（任务书原文形态）",
              "HTTP %s parse=%s url=%r msg=%s | 站点分派不读 query（ApiServer.java:886-893）"
              % (st, pj.get("parse"), get_url[:80], pj.get("msg")))

        # 3e 根因对照：用 POST 显式传空 id，复现 GET 的失败形态。
        # 目的：把「GET ?id= 失败」归因到「query 没进 callRaw」而不是「源站挂了」。
        # 若空 id 的 POST 与 GET 得到同样的错误，就证明源站在有 id 时是好的。
        st_empty, _, body_empty, _ = http("POST", API + "/api/%s/detail" % q(site),
                                          {"id": ""}, timeout=60)
        st_good, _, body_good, _ = http("POST", API + "/api/%s/detail" % q(site),
                                        {"id": vid}, timeout=60)
        good_name = ""
        try:
            good_name = ((json.loads(body_good.decode("utf-8", "replace")).get("list") or [{}])[0]
                         .get("vod_name") or "")
        except Exception:
            good_name = ""
        check(st_good == 200 and bool(good_name),
              "detail", "根因对照: 同站 POST 空 id 失败 / 真实 id 成功",
              "empty-id POST HTTP %s body=%s ; real-id POST HTTP %s vod_name=%s"
              " → GET ?id= 的失败来自 query 未进入站点分派，不是源站不可达"
              % (st_empty, snippet(body_empty, 60), st_good, good_name))
    else:
        skip("detail", "详情/播放链路", "无可用 {site,vod_id}")
        skip("play", "详情/播放链路", "无可用 {site,vod_id}")

    # 4 ------------------------------------------------------------ 缓存域
    print("-" * 78)
    st, _, body, _ = http("GET", API + "/api/cache")
    cj = js(body) or {}
    check(st == 200 and cj.get("ok") is True and isinstance(cj.get("items"), list),
          "cache", "GET /api/cache 列表结构",
          "HTTP %s ok=%s items=%s totalBytes=%s quotaBytes=%s"
          % (st, cj.get("ok"), (len(cj.get("items") or [])), cj.get("totalBytes"), cj.get("quotaBytes")))
    check(isinstance(cj.get("quotaBytes"), int) and cj.get("quotaBytes") > 0,
          "cache", "缓存配额/淘汰模式可见",
          "quotaBytes=%s evictMode=%s cacheDir=%s"
          % (cj.get("quotaBytes"), cj.get("evictMode"), cj.get("cacheDir")))

    st, _, body, _ = http("GET", API + "/api/cache/status")
    check(st == 200, "cache", "GET /api/cache/status 可用",
          "HTTP %s body=%s | 部署版 v0.9.15 无此路由（仅本地 HEAD 有）" % (st, snippet(body, 90)))
    st, _, body, _ = http("GET", API + "/api/cache/tasks")
    check(st == 200, "cache", "GET /api/cache/tasks 可用",
          "HTTP %s body=%s | 部署版 v0.9.15 无此路由（仅本地 HEAD 有）" % (st, snippet(body, 90)))
    st, _, body, _ = http("GET", API + "/api/cache?id=__no_such_task__")
    check(st in (200, 404), "cache", "GET /api/cache?id= 单任务查询有明确响应",
          "HTTP %s body=%s" % (st, snippet(body, 90)))

    # 5 ------------------------------------------------------------ 状态同步
    print("-" * 78)
    SMOKE_SITE = "__smoke__"
    st, _, body, _ = http("POST", API + "/api/state/progress",
                          {"site": SMOKE_SITE, "vod_id": "smoke-progress-1",
                           "pos": 123.5, "dur": 600, "ep": "1"})
    wj = js(body) or {}
    check(st == 200 and wj.get("ok") is True, "state", "POST /api/state/progress 写入",
          "HTTP %s body=%s" % (st, snippet(body, 90)))
    st, _, body, _ = http("GET", API + "/api/state/progress?site=%s&vodId=smoke-progress-1" % q(SMOKE_SITE))
    rj = js(body) or {}
    it = rj.get("item") or {}
    check(st == 200 and abs(float(it.get("pos", -1)) - 123.5) < 0.01,
          "state", "GET /api/state/progress 读回同一条 pos",
          "HTTP %s pos=%s dur=%s ep=%s"
          % (st, it.get("pos"), it.get("dur"), it.get("ep")))
    st, _, body, _ = http("GET", API + "/api/state/progress")
    aj = js(body) or {}
    check(st == 200 and isinstance(aj.get("items"), list),
          "state", "GET /api/state/progress 全量列表", "HTTP %s items=%s" % (st, len(aj.get("items") or [])))

    st, _, body, _ = http("POST", API + "/api/state/favorites",
                          {"site": SMOKE_SITE, "vod_id": "smoke-fav-1", "vod_name": "smoke"})
    check(st == 200 and (js(body) or {}).get("ok") is True, "state", "POST /api/state/favorites 写入",
          "HTTP %s body=%s" % (st, snippet(body, 90)))
    st, _, body, _ = http("GET", API + "/api/state/favorites")
    favs = (js(body) or {}).get("items") or []
    hit = [f for f in favs if f.get("site") == SMOKE_SITE and f.get("vod_id") == "smoke-fav-1"]
    check(st == 200 and len(hit) == 1, "state", "GET /api/state/favorites 读回收藏",
          "HTTP %s total=%d matched=%d" % (st, len(favs), len(hit)))
    st, _, body, _ = http("DELETE", API + "/api/state/favorites?site=%s&vodId=smoke-fav-1" % q(SMOKE_SITE))
    check(st == 200 and (js(body) or {}).get("ok") is True, "state", "DELETE /api/state/favorites 清理",
          "HTTP %s body=%s" % (st, snippet(body, 90)))

    st, _, body, _ = http("GET", API + "/api/state/prefs")
    pj = js(body) or {}
    prefs = pj.get("prefs") or {}
    orig_density = prefs.get("danmakuDensity")
    check(st == 200 and pj.get("ok") is True and isinstance(prefs, dict),
          "state", "GET /api/state/prefs 读取",
          "HTTP %s pref_keys=%d at=%s sample.danmakuDensity=%s"
          % (st, len(prefs), pj.get("at"), orig_density))
    probe_val = "large" if orig_density != "large" else "standard"
    st, _, body, _ = http("POST", API + "/api/state/prefs", {"prefs": {"danmakuDensity": probe_val}})
    wj = js(body) or {}
    check(st == 200 and wj.get("ok") is True and wj.get("applied") == 1,
          "state", "POST /api/state/prefs 白名单字段写入",
          "HTTP %s applied=%s danmakuDensity->%s" % (st, wj.get("applied"), probe_val))
    st, _, body, _ = http("GET", API + "/api/state/prefs")
    back = ((js(body) or {}).get("prefs") or {}).get("danmakuDensity")
    check(back == probe_val, "state", "POST→GET prefs 读回写入值",
          "GET danmakuDensity=%s (期望 %s)" % (back, probe_val))
    # 还原用户原值，避免冒烟改坏真实偏好
    if orig_density is not None:
        http("POST", API + "/api/state/prefs", {"prefs": {"danmakuDensity": orig_density}})
        print("      (已还原 danmakuDensity=%s)" % orig_density)

    # 6 ------------------------------------------------------------ 日志
    print("-" * 78)
    st, _, body, _ = http("GET", API + "/api/logs?limit=5")
    lj = js(body) or {}
    check(st == 200 and isinstance(lj.get("stats"), dict) and isinstance(lj.get("items"), list),
          "logs", "GET /api/logs 有 stats + items",
          "HTTP %s body=%s | 部署版 v0.9.15 无此路由（仅本地 HEAD ApiServer.java:829）"
          % (st, snippet(body, 110)))
    st, _, body, _ = http("GET", API + "/api/logs?level=error&limit=5")
    lj = js(body) or {}
    lv_ok = st == 200 and isinstance(lj.get("items"), list) and all(
        (i.get("level") in (None, "error", "ERROR")) for i in lj.get("items") or [])
    check(lv_ok, "logs", "level=error 筛选可用",
          "HTTP %s items=%s levels=%s"
          % (st, len(lj.get("items") or []), sorted({i.get("level") for i in (lj.get("items") or [])})))

    # 7 ------------------------------------------------------------ 片库
    print("-" * 78)
    st, _, body, _ = http("GET", API + "/api/library")
    lj = js(body) or {}
    check(st == 200 and lj.get("ok") is True and isinstance(lj.get("libs"), list)
          and isinstance(lj.get("tops"), list),
          "library", "GET /api/library 结构（libs + tops）",
          "HTTP %s ok=%s libs=%d tops=%d body=%s"
          % (st, lj.get("ok"), len(lj.get("libs") or []), len(lj.get("tops") or []), snippet(body, 80)))
    st, _, body, _ = http("GET", API + "/api/library?lib=__no_such_lib__&path=")
    check(st == 200 and (js(body) or {}).get("ok") is False,
          "library", "未知片库返回明确错误而不是 500",
          "HTTP %s body=%s" % (st, snippet(body, 90)))
    st, _, body, _ = http("GET", API + "/api/library/stream")
    check(st == 400, "library", "/api/library/stream 缺参 400", "HTTP %s body=%s" % (st, snippet(body, 80)))

    # 8 ------------------------------------------------------------ 代理安全
    print("-" * 78)
    st, _, body, _ = http("GET", API + "/api/proxy/stream")
    check(st == 400, "proxy", "/api/proxy/stream 缺 url 返回 4xx",
          "HTTP %s body=%s" % (st, snippet(body, 80)))
    st, _, body, _ = http("GET", API + "/api/proxy/stream?url=" + q("http://127.0.0.1:30011/api/health"))
    check(st == 403, "proxy", "回环地址 127.0.0.1 被拒 403",
          "HTTP %s body=%s" % (st, snippet(body, 80)))
    st, _, body, _ = http("GET", API + "/api/proxy/stream?url=" + q("http://169.254.169.254/latest/meta-data/"))
    check(st == 403, "proxy", "云元数据 169.254.169.254 被拒 403",
          "HTTP %s body=%s" % (st, snippet(body, 80)))
    st, _, body, _ = http("GET", API + "/api/proxy/stream?url=" + q("http://localhost:30011/api/health"))
    check(st == 403, "proxy", "localhost 主机名被拒 403",
          "HTTP %s body=%s" % (st, snippet(body, 80)))
    # 局域网放行是设计（core/UrlSafety.java:59 isSafeMediaUrl 允许 site-local）
    st, _, body, _ = http("GET", API + "/api/proxy/stream?url=" + q(API + "/api/health"))
    check(st == 200, "proxy", "局域网媒体地址放行（设计如此）",
          "HTTP %s bytes=%d (UrlSafety.isSafeMediaUrl 允许 site-local)" % (st, len(body)))
    st, _, body, _ = http("GET", API + "/api/proxy/image")
    check(st == 400, "proxy", "/api/proxy/image 缺参 4xx", "HTTP %s body=%s" % (st, snippet(body, 80)))

    # 9 ------------------------------------------------------------ 前端可加载
    print("-" * 78)
    st, _, body, _ = http("GET", WEB + "/")
    html = body.decode("utf-8", "replace")
    check(st == 200 and "<div id=\"app\"" in html, "web", "首页 200 且含 #app 挂载点",
          "HTTP %s bytes=%d has_app=%s" % (st, len(body), '<div id="app"' in html))
    refs = sorted(set(re.findall(r'(?:href|src)="(/[^"]+\.(?:js|css|png|ico|svg|webp))"', html)))
    check(len(refs) > 0, "web", "index.html 引用到静态资源", "refs=%s" % refs)
    bad = []
    for r in refs:
        s2, _, b2, _ = http("GET", WEB + r)
        if s2 != 200 or len(b2) == 0:
            bad.append((r, s2, len(b2)))
    check(not bad, "web", "index.html 引用资源全部 200",
          "checked=%d failures=%s" % (len(refs), bad or "none"))

    # 懒加载 chunk：vite 把 12 个视图拆成独立 chunk，index.html 里只引用主 bundle，
    # 所以"入口资源全 200"证明不了子路由能打开。缺任何一个 chunk，对应页面白屏。
    main_js = [r for r in refs if r.endswith(".js")]
    chunk_names = []
    for r in main_js:
        s2, _, b2, _ = http("GET", WEB + r)
        if s2 == 200:
            chunk_names += re.findall(r'"\./([A-Za-z0-9_.\-]+\.js)"', b2.decode("utf-8", "replace"))
    chunk_names = sorted(set(chunk_names))
    bad_chunks = []
    for c in chunk_names:
        s3, _, b3, _ = http("GET", WEB + "/assets/" + c)
        if s3 != 200 or len(b3) == 0:
            bad_chunks.append((c, s3, len(b3)))
    check(chunk_names and not bad_chunks, "web",
          "懒加载视图 chunk 全部 200（白屏防线）",
          "main_js=%s chunks=%d failures=%s"
          % (main_js, len(chunk_names), bad_chunks or "none"))

    # 前端路由表：未登录也应声明全部主路由（缺哪个就是该页没发布）
    router_paths = []
    for r in main_js:
        s2, _, b2, _ = http("GET", WEB + r)
        if s2 == 200:
            router_paths = sorted(set(re.findall(r'path:"(/[a-z/:]*)"', b2.decode("utf-8", "replace"))))
            break
    expect_paths = ["/", "/search", "/detail/:site/:id", "/play/:site", "/settings"]
    missing_paths = [p for p in expect_paths if p not in router_paths]
    check(not missing_paths and router_paths, "web", "前端路由表含核心路径",
          "declared=%s missing=%s" % (router_paths, missing_paths or "none"))

    css_refs = [r for r in refs if r.endswith(".css")]
    if not css_refs:
        skip("web", "CSS @layer 兼容", "index.html 没有 css 引用")
    for cr in css_refs:
        s2, _, b2, _ = http("GET", WEB + cr)
        css = b2.decode("utf-8", "replace")
        n_layer = len(re.findall(r"@layer\b", css))
        check(s2 == 200 and n_layer == 0, "web",
              "%s 无 @layer（老内核兼容）" % cr,
              "HTTP %s bytes=%d @layer=%d" % (s2, len(b2), n_layer))

    # 11 ----------------------------------------------------------- 弹幕
    print("-" * 78)
    st, _, body, _ = http("GET", API + "/api/proxy/danmaku/search?name=" + q(WD), timeout=90)
    dj = js(body) or {}
    items = dj.get("items") if isinstance(dj, dict) else None
    check(st == 200 and isinstance(items, list) and len(items) > 0,
          "danmaku", "GET /api/proxy/danmaku/search 有候选",
          "HTTP %s items=%s sources=%s"
          % (st, (len(items) if isinstance(items, list) else None), dj.get("sources")))
    st, _, body, _ = http("GET", API + "/api/proxy/danmaku/list?name=" + q(WD), timeout=90)
    lj = js(body)
    check(st == 200 and isinstance(lj, list) and len(lj) > 0,
          "danmaku", "GET /api/proxy/danmaku/list 有按集地址",
          "HTTP %s items=%s first=%s"
          % (st, (len(lj) if isinstance(lj, list) else None),
             (lj[0] if isinstance(lj, list) and lj else snippet(body, 80))))

    # 按 name 取弹幕：冷启动时多源串行可能全空，重试一次并记录来源头
    dm_source = dm_count = None
    dm_status = 0
    for _attempt in range(2):
        st, hdr, body, _ = http("GET", API + "/api/proxy/danmaku?name=%s&episode=1" % q(WD), timeout=120)
        dm_status = st
        dm_source = hdr.get("x-danmaku-source")
        try:
            dm_count = int(hdr.get("x-danmaku-count") or 0)
        except ValueError:
            dm_count = 0
        if st == 200 and dm_count > 0:
            break
    check(dm_status == 200 and dm_count and dm_count > 0,
          "danmaku", "/api/proxy/danmaku?name= 返回非空弹幕",
          "HTTP %s X-Danmaku-Source=%s X-Danmaku-Count=%s empty=%s"
          % (dm_status, dm_source, dm_count, None))

    # 指定 id 直连（前端手动选源走的路径）
    #
    # 【实测】这个端点不写 X-Danmaku-* 响应头：handleDanmakuXml（ApiServer.java:3501-3508）
    # 只有 sendText，没有 set("X-Danmaku-Count")。头只在 handleDanmaku 的 name 分支里设
    # （ApiServer.java:4196-4199）。所以非空与否只能数 body 里的 "<d " —— 之前按头断言
    # 会把 10800 条弹幕的响应误判成空。
    xml_id = "tencent:mzc002001wf6pjn:1"
    st, hdr, body, _ = http("GET", API + "/api/proxy/danmaku/xml?id=" + q(xml_id), timeout=120)
    n_tags = body.count(b"<d ")
    check(st == 200 and n_tags > 0, "danmaku",
          "/api/proxy/danmaku/xml?id= 返回非空 XML",
          "HTTP %s <d>=%d bytes=%d (该端点不设 X-Danmaku-Count) first=%s"
          % (st, n_tags, len(body), snippet(body, 60)))

    # 前端 proxyDanmakuByUrl() 的形态：把自家 /xml?id= 路径再包一层
    st, hdr, body, _ = http(
        "GET", API + "/api/proxy/danmaku?url=" + q("/api/proxy/danmaku/xml?id=" + xml_id), timeout=120)
    n_tags2 = body.count(b"<d ")
    check(st == 200 and n_tags2 > 0, "danmaku",
          "/api/proxy/danmaku?url=<自家 xml 路径> 返回非空",
          "HTTP %s <d>=%d bytes=%d (url= 直连分支同样不设头，ApiServer.java:4157-4171)"
          % (st, n_tags2, len(body)))

    # ---------------------------------------------------------------- 汇总
    print("=" * 78)
    total = len(RESULTS)
    passed = sum(1 for r in RESULTS if r[0] is True)
    failed = [r for r in RESULTS if r[0] is False]
    skipped = [r for r in RESULTS if r[0] is None]
    print("总计: %d/%d 通过, %d 失败, %d 跳过" % (passed, total, len(failed), len(skipped)))
    if failed:
        print("失败清单:")
        for _ok, dom, name, ev in failed:
            print("  - [%s] %s | %s" % (dom, name, ev))
    if skipped:
        print("跳过:")
        for _ok, dom, name, ev in skipped:
            print("  - [%s] %s | %s" % (dom, name, ev))
    print("=" * 78)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
