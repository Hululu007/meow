#!/usr/bin/env python3
"""TV 端 MCP 客户端：不依赖 adb 操作 TV。

## 为什么有这个脚本

投影仪没有 adb（5555 关闭），而 TV 应用的全部验收动作——配置后端、进首页、
搜索、播放、看弹幕——以前都只能靠 adb + uiautomator，于是"黑屏了就完全没法排查"。
DebugServer 把这套能力暴露成局域网 HTTP 接口，本脚本就是它的客户端。

## 用法

    # 投影仪（真机，推荐）：直接连局域网 IP + 屏幕上的令牌
    python smoke/tv_mcp.py --host 192.168.1.88 --token 1fa7-761b-5da2-67b9

    # 模拟器：网络要走 adb forward（仅传输，操作仍是 HTTP）
    adb -s emulator-5556 forward tcp:19777 tcp:9977
    python smoke/tv_mcp.py --host 127.0.0.1 --port 19777 --token debug0000000auto

    # 只跑只读检查（不动配置）
    python smoke/tv_mcp.py --host ... --token ... --readonly

## 令牌从哪来

TV 配置页 → 「开启远程调试」→ 屏幕显示令牌（4 位一组）与地址。
投影仪上这一步必须人工点一次——它是安全闸门，不能让局域网随便执行 JS。
debug 包会自动开启并使用固定令牌 debug0000000auto（只为自动化验收）。

退出码：0 全绿 / 1 有失败 / 2 连不上服务
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

OK = []
FAIL = []


def rec(ok, domain, name, detail=''):
    (OK if ok else FAIL).append((domain, name, detail))
    print(('PASS ' if ok else 'FAIL ') + '[%s] %s' % (domain, name)
          + ((' | ' + str(detail)[:180]) if detail else ''))


class Tv:
    def __init__(self, host, port, token, timeout=30):
        self.base = 'http://%s:%d' % (host, port)
        self.token = token.replace('-', '')
        self.timeout = timeout

    def _req(self, path, method='GET', body=None, timeout=None):
        data = None
        headers = {'X-Meow-Token': self.token}
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(self.base + path, data=data,
                                     headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout or self.timeout) as r:
            raw = r.read().decode('utf-8', 'replace')
        try:
            return json.loads(raw)
        except Exception:
            # /eval 返回的是原始 JSON 文本（字符串带引号），再解一层
            return raw

    def health(self):
        return self._req('/health')

    def state(self):
        return self._req('/state')

    def console(self):
        return self._req('/console')

    def network(self):
        return self._req('/network')

    def dom(self):
        return self._req('/dom')

    def perf(self):
        return self._req('/perf')

    def gateway(self):
        return self._req('/gateway')

    def danmaku(self):
        return self._req('/danmaku')

    def eval(self, js):
        return self._req('/eval', 'POST', {'js': js})

    def navigate(self, hash_):
        return self._req('/navigate', 'POST', {'hash': hash_})

    def wait(self, js, timeout_ms=15000):
        return self._req('/wait', 'POST', {'js': js, 'timeout_ms': timeout_ms},
                         timeout=(timeout_ms / 1000.0) + 15)

    # ---- 遥控器模拟 ----
    #
    # 电视没有别的输入方式，验收"能不能操作"只能靠这几个端点。
    # key/keys 都是 GET 带参，一行 curl 就能用；POST 写法保留兼容旧脚本。

    def key(self, name, n=1):
        """按一个键。name: up|down|left|right|ok|back|menu"""
        q = urllib.parse.urlencode({'k': name, 'n': n})
        return self._req('/key?' + q)

    def keys(self, seq):
        """连按一串键，逗号分隔（也接受 list）。

        比多次调用 key() 更稳：间隔由服务端控制，不会因为两次 HTTP 往返
        把按键挤到同一帧里。
        """
        if isinstance(seq, (list, tuple)):
            seq = ','.join(seq)
        q = urllib.parse.urlencode({'seq': seq})
        return self._req('/keys?' + q)

    def focus(self):
        """当前遥控焦点：文本、坐标、是否在视口内、outline 值。

        没有焦点时返回 {'focused': False}。
        """
        r = self._req('/focus')
        # /focus 走 safeEval，响应体是 JSON 字符串（再解一层）
        if isinstance(r, str):
            try:
                return json.loads(r)
            except Exception:
                return {'focused': False, 'raw': r}
        return r if isinstance(r, dict) else {'focused': False, 'raw': r}


def connect(args):
    c = Tv(args.host, args.port, args.token)
    try:
        h = c.health()
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print('403 Forbidden：令牌不对。TV 配置页上的令牌是 4 位一组，'
                  '粘贴时连字符可留可去；debug 包固定为 debug0000000auto')
            return None
        print('HTTP %s：%s' % (e.code, e.read()[:200]))
        return None
    except Exception as e:
        print('连不上 %s：%s' % (c.base, e))
        print('排查：TV 配置页是否已开「远程调试」？地址/端口是否与屏幕一致？'
              '（9977 被占会顺延）防火墙是否放行？')
        return None
    print('已连上 %s  app=%s webview=%s' % (c.base, h.get('app'), h.get('webview')))
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=9977)
    ap.add_argument('--token', required=True, help='TV 配置页显示的令牌')
    ap.add_argument('--backend', default='http://192.168.1.10:30011',
                    help='要配置给 TV 的后端地址')
    ap.add_argument('--readonly', action='store_true', help='只做只读检查，不改配置')
    ap.add_argument('--stream', default='https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
                    help='播放测试用的公开 HLS')
    # ---- 遥控器快捷操作（只做这一件事，不跑整套验收）----
    ap.add_argument('--key', metavar='NAME',
                    help='只按一个键就退出：up/down/left/right/ok/back/menu')
    ap.add_argument('--keys', metavar='SEQ',
                    help='只按一串键就退出，逗号分隔，如 down,down,right,ok')
    ap.add_argument('--n', type=int, default=1, help='配合 --key 的连按次数')
    ap.add_argument('--focus', action='store_true',
                    help='只读当前焦点就退出')
    args = ap.parse_args()

    c = connect(args)
    if not c:
        return 2

    # 遥控器快捷模式：只执行一个动作，方便调试时反复按
    if args.focus:
        f = c.focus()
        print(json.dumps(f, ensure_ascii=False, indent=2))
        return 0 if f.get('focused') else 1
    if args.key:
        r = c.key(args.key, args.n)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0
    if args.keys:
        r = c.keys(args.keys)
        print(json.dumps(r, ensure_ascii=False, indent=2))
        return 0

    # ---------- 1. 基础能力 ----------
    print('\n[1] /health /state /dom /perf /gateway')
    h = c.health()
    rec(h.get('ok') is True, 'health', 'ok', h.get('app'))
    rec(bool(h.get('webview')) and h.get('webview') != 'unknown', 'health',
        'WebView 版本可读', h.get('webview'))
    rec(bool(h.get('url')), 'health', '当前 URL', h.get('url'))
    rec(bool(h.get('lanIp')), 'health', '报告的局域网 IP（真机验收靠它连）', h.get('lanIp'))

    st = c.state()
    rec('hash' in st, 'state', '含 hash', st.get('hash'))
    d = c.dom()
    rec(d.get('ok') is True, 'dom', '可读', 'count=%s' % d.get('count'))
    rec((d.get('count') or 0) > 0, 'dom', '页面上有可交互元素', d.get('count'))
    perf = c.perf()
    rec(perf.get('ok') is True, 'perf', '可读',
        'DCL=%sms load=%sms res=%s' % (perf.get('domContentLoaded'),
                                       perf.get('load'), perf.get('resources')))
    gw = c.gateway()
    rec(gw.get('ok') is True, 'gateway', '本地网关状态可读',
        'running=%s port=%s sites=%s' % (gw.get('gatewayRunning'),
                                         gw.get('gatewayPort'), gw.get('localSites')))

    # ---------- 2. 样式与错误 ----------
    print('\n[2] 样式探针 / JS 错误 / 网络记录')
    probe = c.eval("(function(){try{var x=document.createElement('div');"
                   "x.className='flex';document.body.appendChild(x);"
                   "var v=getComputedStyle(x).display;document.body.removeChild(x);"
                   "return v}catch(e){return 'err:'+e.message}})()")
    rec(probe == 'flex', 'style', '.flex → flex（黑屏根因判据）', probe)
    cons = c.console()
    rec(isinstance(cons, list), 'console', 'JS 错误列表可读', '%d 条' % len(cons or []))
    if cons:
        for e in (cons or [])[:3]:
            print('    ! %s' % str(e.get('message', ''))[:110])
    net = c.network()
    rec(isinstance(net, list), 'network', '网络记录可读', '%d 条' % len(net or []))
    failed = [n for n in (net or []) if not n.get('ok')]
    rec(True, 'network', '失败请求数（仅供参考）', len(failed))

    # ---------- 3. 配置后端（改 localStorage + reload）----------
    if not args.readonly:
        print('\n[3] 配置后端地址并重载')
        c.eval("localStorage.setItem('meow.api', %s);1" % json.dumps(args.backend))
        c.eval("location.reload();1")
        # 重载后等 body 就绪（用 /wait，不靠固定 sleep）
        w = c.wait("document.body && document.body.innerText.length > 0", 15000)
        rec(w.get('ok') is True, 'config', '重载后页面恢复', 'tries=%s' % w.get('tries'))
        api = c.eval("localStorage.getItem('meow.api')")
        rec(isinstance(api, str) and args.backend in api, 'config',
            'meow.api 指向配置的后端', api)

        # ★ 必须显式回首页：reload 会保留当前 hash，上一次跑完停在播放页，
        #   重载后仍在播放页 → 等不到首页海报（实测 tries=64、0/0）。
        c.navigate('#/')
        c.wait("document.body && document.body.innerText.length > 0", 10000)
        # 首页出数据（等卡片/海报出现）
        w2 = c.wait("document.images.length > 3", 20000)
        rec(w2.get('ok') is True, 'home', '首页出现图片（数据已渲染）',
            'tries=%s' % w2.get('tries'))
        # ★ 图片元素出现 ≠ 海报加载出来。只等 length 会把"21 个 img 全 broken"
        #   当成通过，所以再等一轮"已加载占比 >= 80%"。
        c.wait("(function(){var a=[...document.images];"
               "if(!a.length) return false;"
               "var n=a.filter(i=>i.naturalWidth>0).length;"
               "return n >= Math.ceil(a.length*0.8)})()", 25000)
        imgs = c.eval("JSON.stringify({total:document.images.length,"
                      "loaded:[...document.images].filter(i=>i.naturalWidth>0).length})")
        try:
            ij = json.loads(imgs) if isinstance(imgs, str) else imgs
        except Exception:
            ij = {}
        rec((ij.get('loaded') or 0) > 0, 'home', '海报实际加载',
            '%s/%s' % (ij.get('loaded'), ij.get('total')))

        # ---------- 4. 路由可达 ----------
        print('\n[4] 路由切换（TV 没有地址栏，只能靠 /navigate）')
        for hh, kw in [('#/library', '片库'), ('#/settings', '设置'),
                       ('#/logs', '日志'), ('#/history', '历史')]:
            r = c.navigate(hh)
            ok = r.get('ok') is True and hh in str(r.get('hash', ''))
            if ok:
                w3 = c.wait("document.body.innerText.length > 20", 8000)
                ok = w3.get('ok') is True
            rec(ok, 'route', hh, r.get('hash'))

        # ---------- 5. 搜索 ----------
        print('\n[5] 搜索')
        # ★ evaluateJavascript **不会 await Promise**，直接返回异步 IIFE 会得到 {}。
        #   正确姿势：先把结果写进 window，再用 /wait 轮询它。
        #   （这条坑值得记住：任何 async 断言都得走"写全局 + wait"两段式）
        c.eval("(function(){window.__smokeSearch=null;"
               "var b=localStorage.getItem('meow.api')||'';"
               "fetch(b+'/api/search',{method:'POST',"
               "headers:{'Content-Type':'application/json'},"
               "body:JSON.stringify({wd:'测试'})})"
               ".then(function(r){return r.json()})"
               ".then(function(j){window.__smokeSearch={code:200,"
               "groups:(j.groups||[]).length}})"
               ".catch(function(e){window.__smokeSearch={code:-1,err:String(e)}});"
               "return 1})()")
        sw = c.wait("window.__smokeSearch!=null", 60000)
        rec(sw.get('ok') is True, 'search', '搜索在 60s 内返回', 'tries=%s' % sw.get('tries'))
        srj = c.eval("JSON.stringify(window.__smokeSearch)")
        print('    搜索返回:', str(srj)[:160])
        try:
            sj = json.loads(srj)
        except Exception:
            sj = {}
        rec(sj.get('code') == 200, 'search', '搜索 HTTP 200', sj.get('code'))
        rec(isinstance(sj.get('groups'), int), 'search', '返回 groups 数组',
            'groups=%s' % sj.get('groups'))

    # ---------- 6. 播放（用 /navigate + /wait 驱动）----------
    if not args.readonly:
        print('\n[6] 播放器（用片库直链绕过源站，验 video 真的起播）')
        direct = '#/play/lib?direct=%s&name=test' % urllib.parse.quote(args.stream, safe='')
        c.navigate(direct)
        wv = c.wait("(function(){var v=document.querySelector('video');"
                    "return !!v && v.readyState>=3})()", 30000)
        rec(wv.get('ok') is True, 'play', 'video readyState>=3', 'tries=%s' % wv.get('tries'))
        vv = c.eval("(function(){var v=document.querySelector('video');"
                    "return v?JSON.stringify({rs:v.readyState,dur:Math.round(v.duration||0),"
                    "paused:v.paused}):'none'})()")
        rec('"rs":3' in str(vv) or '"rs":4' in str(vv), 'play', '播放器状态', vv)
        dm = c.danmaku()
        rec(dm.get('mounted') is True or dm.get('mounted') is False, 'danmaku',
            '弹幕状态可读（mounted=%s）' % dm.get('mounted'))
        cons2 = c.console()
        rec(len(cons2 or []) == 0, 'console', '播放期间无新增 JS 错误', '%d 条' % len(cons2 or []))

    # ---------- 汇总 ----------
    print('\n' + '=' * 60)
    total = len(OK) + len(FAIL)
    print('总计 %d/%d 通过（%d 失败）' % (len(OK), total, len(FAIL)))
    if FAIL:
        print('失败清单:')
        for dom_, name, det in FAIL:
            print('  - [%s] %s | %s' % (dom_, name, det))
    return 0 if not FAIL else 1


if __name__ == '__main__':
    sys.exit(main())
