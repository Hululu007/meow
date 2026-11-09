"""Minimal CDP-over-WebSocket client (stdlib only) for the TV smoke script."""
import base64
import json
import os
import socket
import struct


class WSClient:
    def __init__(self, host, port, path, timeout=30):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("ws handshake closed")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("ws handshake failed: " + head.decode("latin1")[:200])
        self._buf = rest
        self._id = 0

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("ws closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send(self, text):
        data = text.encode()
        header = bytearray([0x81])
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

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            opcode = b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n) if n else b""
            if opcode == 1:
                return payload.decode("utf-8", "replace")
            if opcode == 8:
                raise RuntimeError("ws closed by peer")
            if opcode == 9:
                # pong
                frame = bytearray([0x8A])
                l = len(payload)
                mask = os.urandom(4)
                frame.append(0x80 | l)
                frame += mask
                frame += bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                self.sock.sendall(bytes(frame))
                continue
            # ignore pong / binary / continuation

    def call(self, method, params=None):
        self._id += 1
        mid = self._id
        self.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.recv())
            if msg.get("id") == mid:
                return msg

    def eval(self, expression, await_promise=True, timeout_note=None):
        r = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": True,
            },
        )
        res = r.get("result", {})
        if "exceptionDetails" in res:
            raise RuntimeError(
                "eval exception: "
                + json.dumps(res.get("exceptionDetails", {}), ensure_ascii=False)[:400]
            )
        inner = res.get("result", {})
        return inner.get("value")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass
