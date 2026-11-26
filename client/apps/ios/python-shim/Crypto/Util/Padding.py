"""PKCS#7 padding（与 pycryptodome 同名接口）。"""


def pad(data, block_size, style='pkcs7'):
    if style != 'pkcs7':
        raise NotImplementedError('only pkcs7 padding is available on iOS')
    if not 0 < block_size < 256:
        raise ValueError('block_size out of range')
    n = block_size - (len(data) % block_size)
    return data + bytes([n]) * n


def unpad(data, block_size, style='pkcs7'):
    if style != 'pkcs7':
        raise NotImplementedError('only pkcs7 padding is available on iOS')
    if not data:
        raise ValueError('input data is empty')
    n = data[-1]
    if n == 0 or n > block_size or n > len(data):
        raise ValueError('padding is incorrect')
    if data[-n:] != bytes([n]) * n:
        raise ValueError('padding is incorrect')
    return data[:-n]
