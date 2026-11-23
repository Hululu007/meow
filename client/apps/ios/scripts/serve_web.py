#!/usr/bin/env python3
"""开发/CI 用静态服务：托管 web/dist，并把 meow.api / meow.site 注入 index.html。

WKWebView 壳里由壳写 localStorage；浏览器截图没有壳，所以这里在首屏 HTML
里插一小段脚本，让 resolveBase() 与站点选择在页面脚本之前就拿到值。
"""
import argparse
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=9979)
    ap.add_argument("--api-base", default="")
    ap.add_argument("--site", default="")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    inject = ""
    if args.api_base or args.site:
        parts = []
        if args.api_base:
            parts.append("localStorage.setItem('meow.api',%s)" % json.dumps(args.api_base))
            parts.append("localStorage.setItem('meow.api.scope','ios')")
        if args.site:
            parts.append("localStorage.setItem('meow.site',%s)" % json.dumps(args.site))
        inject = ("<script>try{" + ";".join(parts) + "}catch(e){}</script>").encode("utf-8")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=root, **kw)

        def log_message(self, fmt, *args2):
            sys.stderr.write("[web] " + (fmt % args2) + "\n")

        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            fs = self.translate_path(path)
            if os.path.isdir(fs):
                fs = os.path.join(fs, "index.html")
            if not os.path.exists(fs):
                # 无扩展名 → SPA 入口；有扩展名 → 交给父类 404
                if "." not in os.path.basename(path):
                    fs = os.path.join(root, "index.html")
                else:
                    return super().do_GET()

            if os.path.basename(fs) == "index.html":
                with open(fs, "rb") as f:
                    body = f.read()
                if inject:
                    body = body.replace(b"</head>", inject + b"</head>", 1) if b"</head>" in body else inject + body
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()

    Handler.extensions_map.update(
        {
            ".mjs": "text/javascript",
            ".js": "text/javascript",
            ".wasm": "application/wasm",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".json": "application/json",
        }
    )

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[web] {root} -> http://127.0.0.1:{args.port} api={args.api_base} site={args.site}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
