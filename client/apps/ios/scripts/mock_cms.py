#!/usr/bin/env python3
"""CI 用的本地苹果CMS mock。

只实现 CmsSource 真正会打的三个动作（ac=list / ac=detail / ids），
以及海报和一条占位 m3u8。目的是让 iOS UI 截图有确定的内容，
不依赖任何外部采集站。
"""
import argparse
import json
import struct
import sys
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8099

TYPES = [(1, "电影"), (2, "剧集"), (3, "综艺")]
TITLES = ["猫窝测试片 A", "猫窝测试片 B", "猫窝测试片 C", "猫窝测试片 D"]
COLORS = [(45, 212, 191), (56, 189, 248), (167, 139, 250), (251, 191, 36)]


def make_png(w, h, rgb):
    r, g, b = rgb
    raw = b"".join(b"\x00" + bytes((r, g, b)) * w for _ in range(h))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


POSTERS = {i + 1: make_png(300, 400, COLORS[i % len(COLORS)]) for i in range(len(TITLES))}

ITEMS = []
for i, title in enumerate(TITLES, start=1):
    ITEMS.append(
        {
            "vod_id": i,
            "vod_name": title,
            "type_id": TYPES[(i - 1) % len(TYPES)][0],
            "type_name": TYPES[(i - 1) % len(TYPES)][1],
            "vod_pic": "https://raw.githubusercontent.com/upchr/meow/main/client/apps/web/public/icon-192.png",
            "vod_remarks": f"第 {i} 集",
            "vod_year": "2026",
            "vod_area": "CN",
            "vod_lang": "国语",
            "vod_actor": "猫窝",
            "vod_director": "Meow",
            "vod_content": "CI 本地 mock 数据：用于验证 iOS 端内宿主与 UI。",
            "vod_play_from": "CI线路",
            "vod_play_url": f"第1集$http://127.0.0.1:{PORT}/stream.m3u8",
        }
    )


def detail_payload(items):
    return {
        "code": 1,
        "page": 1,
        "limit": 20,
        "total": len(items),
        "pagecount": 1,
        "list": items,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + (fmt % args) + "\n")

    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def send_bytes(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query)

        if path.rstrip("/").endswith("/api.php/provide/vod"):
            ac = (q.get("ac") or [""])[0]
            if ac == "list":
                return self.send_json(
                    {
                        "code": 1,
                        "class": [
                            {"type_id": tid, "type_name": name, "type_pid": 0}
                            for tid, name in TYPES
                        ],
                        "list": [],
                    }
                )
            if ac == "detail":
                ids = (q.get("ids") or [""])[0]
                if ids:
                    for it in ITEMS:
                        if str(it["vod_id"]) == ids:
                            return self.send_json({"code": 1, "list": [it]})
                    return self.send_json({"code": 1, "list": []})
                wd = (q.get("wd") or [""])[0].strip()
                if wd:
                    return self.send_json(detail_payload([it for it in ITEMS if wd in it["vod_name"]]))
                tid = (q.get("type_id") or q.get("t") or q.get("tid") or [""])[0]
                if tid:
                    picked = [it for it in ITEMS if str(it["type_id"]) == tid]
                    return self.send_json(detail_payload(picked))
                return self.send_json(detail_payload(ITEMS))
            return self.send_json({"code": 1, "list": []})

        if path.startswith("/poster/") and path.endswith(".png"):
            try:
                idx = int(path.split("/")[2].split(".")[0])
            except (ValueError, IndexError):
                idx = 1
            body = POSTERS.get(idx) or POSTERS[1]
            return self.send_bytes(body, "image/png")

        if path == "/stream.m3u8":
            body = (
                "#EXTM3U\n"
                "#EXT-X-VERSION:3\n"
                "#EXT-X-TARGETDURATION:10\n"
                "#EXT-X-MEDIA-SEQUENCE:0\n"
                "#EXTINF:10,\n"
                "http://127.0.0.1:%d/segment.ts\n" % PORT
            ).encode("utf-8")
            return self.send_bytes(body, "application/vnd.apple.mpegurl")

        return self.send_bytes(b"not found", "text/plain")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mock] listening on http://127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
