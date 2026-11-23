#!/usr/bin/env python3
"""runner 侧验证：/api/{site}/search → detail → play 一条链。

不猜接口形状：search 取第一条 vod_id，detail 原样打印，play 从
vod_play_from/vod_play_url 或 flags/episodes 里取第一集尝试。
"""
import json
import sys
import urllib.parse
import urllib.request


def post(base, path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode("utf-8", "replace")
    print(f"POST {path} -> {len(raw)}B")
    print(raw[:800])
    try:
        return json.loads(raw)
    except Exception:
        return None


def main():
    base = sys.argv[1].rstrip("/")
    site = sys.argv[2]
    wd = sys.argv[3] if len(sys.argv) > 3 else "庆余年"
    enc = urllib.parse.quote(site, safe="")

    search = post(base, f"/api/{enc}/search", {"wd": wd})
    items = (search or {}).get("list") or []
    print("SEARCH_ITEMS", len(items))
    if not items:
        return 2
    vid = str(items[0].get("vod_id", ""))
    print("FIRST", items[0].get("vod_name"), vid)

    detail = post(base, f"/api/{enc}/detail", {"id": vid})
    flags, eps = [], []
    for it in (detail or {}).get("list") or []:
        froms = str(it.get("vod_play_from", "")).split("$$$")
        urls = str(it.get("vod_play_url", "")).split("$$$")
        for i, line in enumerate(urls):
            if not line:
                continue
            first = line.split("#")[0]
            ep = first.split("$")[-1]
            flags.append(froms[i] if i < len(froms) else "")
            eps.append(ep)
        if flags:
            break
    print("PLAY_FLAGS", flags[:3])
    if not flags:
        return 3

    play = post(base, f"/api/{enc}/play", {"flag": flags[0], "id": eps[0]})
    url = (play or {}).get("url", "")
    print("PLAY_URL", url[:200])
    return 0 if url else 4


if __name__ == "__main__":
    sys.exit(main())
