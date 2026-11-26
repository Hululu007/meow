"""serialization 占位（端内不支持证书/密钥序列化，见 asymmetric）。"""


def load_pem_private_key(*a, **k):
    raise NotImplementedError(
        "serialization is not available on iOS (use remote pyrt)")


def load_der_private_key(*a, **k):
    raise NotImplementedError(
        "serialization is not available on iOS (use remote pyrt)")


def load_pem_public_key(*a, **k):
    raise NotImplementedError(
        "serialization is not available on iOS (use remote pyrt)")
