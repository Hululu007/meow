"""纯 Python AES（ECB / CBC），接口对齐 pycryptodome 的常用子集。

<p>为什么不用 C 扩展：iOS 端内没有 pycryptodome 的 arm64 wheel，交叉编译
成本高。110 个 py 源里 AES 大多只做 `AES.new(key, MODE_CBC, iv).decrypt(...)`，
纯 Python 实现足够（单次几十 KB 解密在毫秒级）。

<p>未实现：CFB/OFB/CTR/GCM、nonce、segment_size —— 抛 NotImplementedError，
错误信息提示改用远端 pyrt（PC/Docker 上是完整 pycryptodome）。
"""
import struct

MODE_ECB = 1
MODE_CBC = 2
block_size = 16

_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0"
    "b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cf"
    "d0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdb"
    "e0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9e"
    "e1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16")
_INV_SBOX = bytearray(256)
for _i, _v in enumerate(_SBOX):
    _INV_SBOX[_v] = _i
_INV_SBOX = bytes(_INV_SBOX)

_RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _xtime(a):
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _mul(a, b):
    r = 0
    for _ in range(8):
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r


_MUL = {n: bytes(_mul(x, n) for x in range(256)) for n in (2, 3, 9, 11, 13, 14)}


def _expand_key(key):
    nk = len(key) // 4
    if len(key) not in (16, 24, 32):
        raise ValueError('AES key must be 16/24/32 bytes')
    nr = nk + 6
    w = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    for i in range(nk, 4 * (nr + 1)):
        t = list(w[i - 1])
        if i % nk == 0:
            t = t[1:] + t[:1]
            t = [_SBOX[b] for b in t]
            t[0] ^= _RCON[i // nk]
        elif nk > 6 and i % nk == 4:
            t = [_SBOX[b] for b in t]
        w.append([w[i - nk][j] ^ t[j] for j in range(4)])
    return [bytes(b for word in w[4 * r:4 * r + 4] for b in word) for r in range(nr + 1)], nr


def _encrypt_block(block, rk, nr):
    s = bytearray(b ^ k for b, k in zip(block, rk[0]))
    for rnd in range(1, nr + 1):
        s = bytearray(_SBOX[b] for b in s)
        s = bytearray([
            s[0], s[5], s[10], s[15],
            s[4], s[9], s[14], s[3],
            s[8], s[13], s[2], s[7],
            s[12], s[1], s[6], s[11],
        ])
        if rnd != nr:
            out = bytearray(16)
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                out[4 * c + 0] = _MUL[2][a0] ^ _MUL[3][a1] ^ a2 ^ a3
                out[4 * c + 1] = a0 ^ _MUL[2][a1] ^ _MUL[3][a2] ^ a3
                out[4 * c + 2] = a0 ^ a1 ^ _MUL[2][a2] ^ _MUL[3][a3]
                out[4 * c + 3] = _MUL[3][a0] ^ a1 ^ a2 ^ _MUL[2][a3]
            s = out
        s = bytearray(b ^ k for b, k in zip(s, rk[rnd]))
    return bytes(s)


def _decrypt_block(block, rk, nr):
    s = bytearray(b ^ k for b, k in zip(block, rk[nr]))
    for rnd in range(nr - 1, -1, -1):
        s = bytearray([
            s[0], s[13], s[10], s[7],
            s[4], s[1], s[14], s[11],
            s[8], s[5], s[2], s[15],
            s[12], s[9], s[6], s[3],
        ])
        s = bytearray(_INV_SBOX[b] for b in s)
        s = bytearray(b ^ k for b, k in zip(s, rk[rnd]))
        if rnd != 0:
            out = bytearray(16)
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                out[4 * c + 0] = _MUL[14][a0] ^ _MUL[11][a1] ^ _MUL[13][a2] ^ _MUL[9][a3]
                out[4 * c + 1] = _MUL[9][a0] ^ _MUL[14][a1] ^ _MUL[11][a2] ^ _MUL[13][a3]
                out[4 * c + 2] = _MUL[13][a0] ^ _MUL[9][a1] ^ _MUL[14][a2] ^ _MUL[11][a3]
                out[4 * c + 3] = _MUL[11][a0] ^ _MUL[13][a1] ^ _MUL[9][a2] ^ _MUL[14][a3]
            s = out
    return bytes(s)


class _AESCipher(object):
    block_size = 16

    def __init__(self, key, mode, iv=None):
        self.key = bytes(key)
        self.mode = mode
        self.iv = iv
        self._rk, self._nr = _expand_key(self.key)
        if mode == MODE_CBC:
            if iv is None:
                raise ValueError('CBC mode requires an IV')
            if len(iv) != 16:
                raise ValueError('IV must be 16 bytes')

    def encrypt(self, data):
        data = bytes(data)
        if len(data) % 16:
            raise ValueError('Data must be aligned to 16 byte blocks')
        if self.mode == MODE_ECB:
            return b''.join(_encrypt_block(data[i:i + 16], self._rk, self._nr)
                            for i in range(0, len(data), 16))
        if self.mode == MODE_CBC:
            out = bytearray()
            prev = self.iv
            for i in range(0, len(data), 16):
                blk = bytes(a ^ b for a, b in zip(data[i:i + 16], prev))
                prev = _encrypt_block(blk, self._rk, self._nr)
                out += prev
            return bytes(out)
        raise NotImplementedError('AES mode %r is not available on iOS (use remote pyrt)' % self.mode)

    def decrypt(self, data):
        data = bytes(data)
        if len(data) % 16:
            raise ValueError('Data must be aligned to 16 byte blocks')
        if self.mode == MODE_ECB:
            return b''.join(_decrypt_block(data[i:i + 16], self._rk, self._nr)
                            for i in range(0, len(data), 16))
        if self.mode == MODE_CBC:
            out = bytearray()
            prev = self.iv
            for i in range(0, len(data), 16):
                blk = data[i:i + 16]
                plain = _decrypt_block(blk, self._rk, self._nr)
                out += bytes(a ^ b for a, b in zip(plain, prev))
                prev = blk
            return bytes(out)
        raise NotImplementedError('AES mode %r is not available on iOS (use remote pyrt)' % self.mode)


def new(key, mode, iv=None, nonce=None, **kwargs):
    if nonce is not None:
        raise NotImplementedError('AES nonce/CTR/GCM is not available on iOS (use remote pyrt)')
    return _AESCipher(key, mode, iv)
