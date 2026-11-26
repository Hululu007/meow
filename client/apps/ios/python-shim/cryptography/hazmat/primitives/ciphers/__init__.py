"""ciphers 子集：AES / TripleDES / ARC4 的 CBC/ECB/CTR/CFB/OFB/GCM。"""
from Crypto.Cipher import AES as _AES
from Crypto.Cipher import ARC4 as _ARC4


class algorithms(object):
    class AES(object):
        name = "AES"
        key_sizes = (128, 192, 256)
        block_size = 128

        def __init__(self, key):
            key = bytes(key)
            if len(key) not in (16, 24, 32):
                raise ValueError("AES key must be 16/24/32 bytes")
            self.key = key

    class TripleDES(object):
        name = "TripleDES"
        block_size = 64

        def __init__(self, key):
            raise NotImplementedError(
                "TripleDES is not available on iOS (use remote pyrt)")

    class ARC4(object):
        name = "ARC4"
        key_sizes = (40, 56, 64, 80, 128, 160, 192, 256)

        def __init__(self, key):
            self.key = bytes(key)


class modes(object):
    class CBC(object):
        name = "CBC"

        def __init__(self, iv):
            self.iv = bytes(iv)

    class ECB(object):
        name = "ECB"

    class CTR(object):
        name = "CTR"

        def __init__(self, nonce):
            self.nonce = bytes(nonce)

    class CFB(object):
        name = "CFB"

        def __init__(self, iv):
            self.iv = bytes(iv)

    class OFB(object):
        name = "OFB"

        def __init__(self, iv):
            self.iv = bytes(iv)

    class GCM(object):
        name = "GCM"

        def __init__(self, iv, min_tag_length=16):
            self.iv = bytes(iv)
            self.tag = None


class Cipher(object):
    def __init__(self, algorithm, mode, backend=None):
        self.algorithm = algorithm
        self.mode = mode
        self._ctx = None

    def encryptor(self):
        coe = _Core(self.algorithm, self.mode, encrypt=True)
        return coe

    def decryptor(self):
        return _Core(self.algorithm, self.mode, encrypt=False)


class _Core(object):
    def __init__(self, algorithm, mode, encrypt):
        self._enc = encrypt
        self._mode = mode
        self._buf = b""
        self._aad = b""
        self._tag = None
        name = getattr(mode, "name", "")
        if isinstance(algorithm, algorithms.AES):
            if name == "GCM":
                self._gcm = _AES.new(algorithm.key, _AES.MODE_GCM, nonce=mode.iv)
            elif name == "ECB":
                self._c = _AES.new(algorithm.key, _AES.MODE_ECB)
            elif name in ("CBC", "CTR", "CFB", "OFB"):
                m = {"CBC": _AES.MODE_CBC, "CTR": _AES.MODE_CTR,
                     "CFB": _AES.MODE_CFB, "OFB": _AES.MODE_OFB}[name]
                if m == _AES.MODE_CTR:
                    self._c = _AES.new(algorithm.key, m, nonce=mode.nonce)
                elif m in (_AES.MODE_CFB, _AES.MODE_OFB):
                    try:
                        self._c = _AES.new(algorithm.key, m, iv=mode.iv)
                    except Exception:
                        raise NotImplementedError(
                            "AES-%s is not available on iOS (use remote pyrt)" % name)
                else:
                    self._c = _AES.new(algorithm.key, m, iv=mode.iv)
            else:
                raise NotImplementedError(
                    "cipher mode %s is not available on iOS (use remote pyrt)" % name)
        elif isinstance(algorithm, algorithms.ARC4):
            self._c = _ARC4.new(algorithm.key)
        else:
            raise NotImplementedError("cipher %r not available on iOS" % algorithm)

    # ---- streaming 语义（CBC/ECB 按块返回，余量留到 finalize）
    def update(self, data):
        data = bytes(data)
        if hasattr(self, "_gcm"):
            if self._aad:
                pass
            return self._gcm.encrypt(data) if self._enc else self._gcm.decrypt(data)
        if isinstance(self._c, _ARC4.ARC4Cipher):
            return self._c.encrypt(data)
        name = getattr(self._mode, "name", "")
        if name in ("CBC", "ECB"):
            buf = self._buf + data
            n = (len(buf) // 16) * 16
            self._buf = buf[n:]
            if n == 0:
                return b""
            chunk = buf[:n]
            return self._c.encrypt(chunk) if self._enc else self._c.decrypt(chunk)
        # CTR/CFB/OFB：流式，直接处理
        return self._c.encrypt(data) if self._enc else self._c.decrypt(data)

    def authenticate_additional_data(self, data):
        if not hasattr(self, "_gcm"):
            raise TypeError("AAD is only supported for GCM")
        self._aad += bytes(data)
        self._gcm.update(bytes(data))

    def finalize(self):
        if hasattr(self, "_gcm"):
            if self._enc:
                self._tag = self._gcm._tag_of(self._gcm._ct)
                return b""
            tag = self._tag or getattr(self._mode, "tag", None)
            if tag is None:
                raise ValueError("GCM tag missing (use finalize_with_tag)")
            # update() 已经把明文流式返回了；这里只校验 tag
            self._gcm.decrypt_and_verify(self._gcm._ct, tag)
            return b""
        if self._buf:
            raise ValueError("data length not multiple of block size")
        if isinstance(self._c, _ARC4.ARC4Cipher):
            return b""
        return b""

    def finalize_with_tag(self, tag):
        if not hasattr(self, "_gcm"):
            raise TypeError("finalize_with_tag is only for GCM")
        self._tag = bytes(tag)
        return self.finalize()

    @property
    def tag(self):
        return self._tag
