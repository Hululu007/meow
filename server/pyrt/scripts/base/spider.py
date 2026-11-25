# -*- coding: utf-8 -*-
"""base.spider 桩：welfare-js 里的 Spider 都继承它。

真实客户端由 vbox 壳提供；这里补齐脚本实际会调用到的方法：
  - getProxyUrl / localProxy / getCache / setCache / delCache
  - fetch / post / get（实测 baopianku、juhe 等大量使用，返回 requests.Response）
  - session / headers（脚本直接读写这两个属性）
"""

import requests

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


class Spider(object):
    def __init__(self, *args, **kwargs):
        self.session = requests.Session()
        self.headers = {"User-Agent": DEFAULT_UA}

    # 不少脚本的 Spider 定义了 __init__ 却没调 super()，直接 self.session 会 AttributeError
    # （实测 91dashen）。用惰性属性兜住，两种写法都能跑。
    @property
    def session(self):
        s = self.__dict__.get("_session")
        if s is None:
            s = requests.Session()
            self.__dict__["_session"] = s
        return s

    @session.setter
    def session(self, value):
        self.__dict__["_session"] = value

    @property
    def headers(self):
        h = self.__dict__.get("_headers")
        if h is None:
            h = {"User-Agent": DEFAULT_UA}
            self.__dict__["_headers"] = h
        return h

    @headers.setter
    def headers(self, value):
        self.__dict__["_headers"] = value

    # ---------- 客户端能力 ----------
    def getProxyUrl(self, *args, **kwargs):
        # 图片代理前缀。返回空串 = 图片走原始 URL。
        return ""

    def localProxy(self, param):
        return None

    def getCache(self, key):
        return None

    def setCache(self, key, value, expires=0):
        return True

    def delCache(self, key):
        return True

    def isVideoFormat(self, url):
        return False

    def manualVideoCheck(self):
        return False

    def getName(self):
        return self.__class__.__name__

    def destroy(self):
        pass

    # ---------- HTTP 快捷方法 ----------
    def _headers(self, headers):
        h = dict(getattr(self, "headers", None) or {"User-Agent": DEFAULT_UA})
        if headers:
            h.update(headers)
        return h

    def fetch(self, url=None, headers=None, timeout=15, verify=False, **kwargs):
        return self.session.get(url, headers=self._headers(headers),
                                timeout=timeout, verify=verify, **kwargs)

    def get(self, url=None, headers=None, timeout=15, verify=False, **kwargs):
        return self.fetch(url, headers=headers, timeout=timeout, verify=verify, **kwargs)

    def post(self, url=None, data=None, json=None, headers=None, timeout=15,
             verify=False, **kwargs):
        return self.session.post(url, data=data, json=json,
                                 headers=self._headers(headers),
                                 timeout=timeout, verify=verify, **kwargs)

    def put(self, url=None, data=None, headers=None, timeout=15, verify=False, **kwargs):
        return self.session.put(url, data=data, headers=self._headers(headers),
                                timeout=timeout, verify=verify, **kwargs)
