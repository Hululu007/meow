"""RSA/EC 占位：端内裁剪运行时不含非对称加密。

源里只有 1 个用到 `padding`/`serialization`；保留同名对象让 import 通过，
真正使用时给出明确原因（而不是 ModuleNotFoundError 被当成"源坏了"）。
"""


class _Unsupported(object):
    def __getattr__(self, name):
        raise NotImplementedError(
            "asymmetric crypto (%s) is not available on iOS (use remote pyrt)" % name)


padding = _Unsupported()
