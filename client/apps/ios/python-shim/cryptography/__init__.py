"""cryptography 兼容层（iOS 端内裁剪运行时）。

<p>110 个 py 源里有 19 个 import cryptography，绝大多数只是把它当
"AES-CBC 的第三兜底"（优先 Crypto，其次 cryptography，最后 pyaes）。
端内没有 cryptography（Rust/C 扩展，无 iOS wheel），这里用纯 Python 实现
最常用的子集：

  cryptography.hazmat.primitives.ciphers.{Cipher, algorithms, modes}
  cryptography.hazmat.backends.default_backend
  cryptography.fernet.Fernet

未实现（会抛 NotImplementedError）：RSA/EC/PKCS1、证书、X.509、hkdf 以外
的 KDF 等；错误信息会提示改用远端 pyrt。
"""
__version__ = "0.0-ios-shim"
