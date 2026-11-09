"""最小 CDP 客户端：只用标准库（socket/base64/hashlib/struct），不引第三方包。

为什么手写：仓库冒烟脚本的硬约束是"Python 用标准库，不要 pip 装东西"。
websocket-client 在本机恰好装着，但换台机器就断，所以这里自己实现
握手 + 帧编解码（只支持文本帧，够 CDP Runtime.evaluate 用）。
"""

import base64
import hashlib
import json
import os
import socket
import struct
import urllib.request

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WSError(RuntimeError):
    pass


class MiniWS:
    def __init__(self, url, timeout=15):
        # ws://127.0.0.1:PORT/devtools/page/<id>
        if not url.startswith("ws://"):
            raise WSError("only ws:// supported: %s" % url)
        rest = url[len("ws://"):]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET /%s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            # Chromium 会拒绝带 Origin 的非浏览器连接；不带 Origin 最省事
            "\r\n" % (path, hostport, key)
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError("handshake closed")
            resp += chunk
        head, _, tail = resp.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise WSError("handshake failed: %r" % head[:200])
        expect = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest())
        if expect.lower() not in head.lower():
            raise WSError("bad Sec-WebSocket-Accept")
        self._buf = tail
        self._id = 0

    # ---------------- 帧 ----------------
    def _send_text(self, text):
        data = text.encode()
        header = bytearray([0x81])  # FIN + text
        n = len(data)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def _read_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self._buf)))
            if not chunk:
                raise WSError("socket closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def recv_msg(self):
        while True:
            b1, b2 = self._read_exact(2)
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read_exact(8))[0]
            mk = self._read_exact(4) if masked else None
            payload = self._read_exact(n)
            if mk:
                payload = bytes(b ^ mk[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise WSError("server closed")
            if opcode == 0x9:      # ping
                self.sock.sendall(b"\x8a" + bytes([0x80]) + os.urandom(4))
                continue
            if opcode in (0x1, 0x2):
                return payload.decode("utf-8", "replace")

    def call(self, method, params=None, timeout=20):
        self._id += 1
        mid = self._id
        self.sock.settimeout(timeout)
        self._send_text(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.recv_msg())
            if msg.get("id") == mid:
                return msg

    def eval(self, expr, timeout=20):
        """跑 JS 并返回 value；异常时返回 {'__error': ...}。"""
        r = self.call(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        res = r.get("result", {})
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            desc = (d.get("exception") or {}).get("description") or d.get("text")
            return {"__error": str(desc)[:300]}
        return res.get("result", {}).get("value")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def list_targets(port, timeout=8):
    url = "http://127.0.0.1:%d/json/list" % port
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)
