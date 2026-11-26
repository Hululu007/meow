"""纯 Python RC4（pycryptodome 的 Crypto.Cipher.ARC4 子集）。"""


class ARC4Cipher(object):
    block_size = 1

    def __init__(self, key, drop=0):
        key = bytes(key)
        if not 1 <= len(key) <= 256:
            raise ValueError('key length must be 1..256')
        s = list(range(256))
        j = 0
        for i in range(256):
            j = (j + s[i] + key[i % len(key)]) & 0xFF
            s[i], s[j] = s[j], s[i]
        self._s = s
        self._i = self._j = 0
        for _ in range(drop):
            self._next()

    def _next(self):
        s, i, j = self._s, self._i, self._j
        i = (i + 1) & 0xFF
        j = (j + s[i]) & 0xFF
        s[i], s[j] = s[j], s[i]
        self._i, self._j = i, j
        return s[(s[i] + s[j]) & 0xFF]

    def encrypt(self, data):
        return bytes(b ^ self._next() for b in data)

    def decrypt(self, data):
        return self.encrypt(data)


def new(key, *args, **kwargs):
    return ARC4Cipher(key, **kwargs)
