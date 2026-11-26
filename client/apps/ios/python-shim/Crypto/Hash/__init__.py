"""hashlib 包装（Crypto.Hash.MD5/SHA1/SHA256 的常用接口）。"""
import hashlib as _hl


class _Hash(object):
    _algo = 'md5'

    def __init__(self, data=b''):
        self._h = _hl.new(self._algo, bytes(data))

    def update(self, data):
        self._h.update(bytes(data))
        return self

    def digest(self):
        return self._h.digest()

    def hexdigest(self):
        return self._h.hexdigest()

    @property
    def block_size(self):
        return self._h.block_size

    @property
    def digest_size(self):
        return self._h.digest_size


class MD5(_Hash):
    _algo = 'md5'


class SHA1(_Hash):
    _algo = 'sha1'


class SHA256(_Hash):
    _algo = 'sha256'


class SHA512(_Hash):
    _algo = 'sha512'
