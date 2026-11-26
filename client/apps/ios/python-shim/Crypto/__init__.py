"""端内 Crypto 兼容层（iOS 内嵌 CPython）。

<p>真机不带 pycryptodome（C 扩展，iOS 需要单独交叉编译）。这里用纯 Python
实现源脚本最常用的 `Crypto.Cipher.AES` 与 `Crypto.Util.Padding`，以及
`Crypto.Hash.*` 的 hashlib 包装 —— 覆盖绝大多数 drpy/py 源的加解密用法。

<p>范围：AES-ECB / AES-CBC，128/192/256 位密钥。未实现的模式/接口会抛
NotImplementedError，并在错误里说明"需要远端 pyrt"。
"""
__all__ = ["Cipher", "Util", "Hash"]
