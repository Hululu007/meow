"""Fernet（AES-128-CBC + HMAC-SHA256），格式与官方实现兼容。

token = base64url(0x80 | timestamp(8B) | IV(16B) | ciphertext | HMAC(32B))
密钥 = base64url(32B)：前 16B 签名、后 16B 加密。
"""
import base64
import hashlib
import hmac
import os
import struct
import time

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad


class InvalidToken(Exception):
    pass


class Fernet(object):
    def __init__(self, key, backend=None):
        try:
            raw = base64.urlsafe_b64decode(key)
        except Exception:
            raise ValueError("Fernet key must be 32 url-safe base64-encoded bytes")
        if len(raw) != 32:
            raise ValueError("Fernet key must be 32 url-safe base64-encoded bytes")
        self._signing_key = raw[:16]
        self._encryption_key = raw[16:]

    @staticmethod
    def generate_key():
        return base64.urlsafe_b64encode(os.urandom(32))

    def _sign(self, data):
        return hmac.new(self._signing_key, data, hashlib.sha256).digest()

    def encrypt(self, data):
        iv = os.urandom(16)
        stamp = struct.pack(">Q", int(time.time()))
        ct = AES.new(self._encryption_key, AES.MODE_CBC, iv).encrypt(pad(bytes(data), 16))
        body = b"\x80" + stamp + iv + ct
        return base64.urlsafe_b64encode(body + self._sign(body))

    def decrypt(self, token, ttl=None):
        try:
            raw = base64.urlsafe_b64decode(bytes(token))
        except Exception:
            raise InvalidToken("invalid base64")
        if not raw or raw[0] != 0x80:
            raise InvalidToken("unknown version")
        if len(raw) < 1 + 8 + 16 + 32:
            raise InvalidToken("token too short")
        body, sig = raw[:-32], raw[-32:]
        if not hmac.compare_digest(self._sign(body), sig):
            raise InvalidToken("signature mismatch")
        stamp = struct.unpack(">Q", body[1:9])[0]
        if ttl is not None and time.time() - stamp > ttl:
            raise InvalidToken("token expired")
        iv, ct = body[9:25], body[25:]
        try:
            return unpad(AES.new(self._encryption_key, AES.MODE_CBC, iv).decrypt(ct), 16)
        except Exception:
            raise InvalidToken("decrypt failed")


def encrypt(data, key):
    return Fernet(key).encrypt(data)


def decrypt(token, key, ttl=None):
    return Fernet(key).decrypt(token, ttl)
