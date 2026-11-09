"""验证 TV DebugServer 的 8 个新端点（与 PC 的 pc_* 工具对齐的那批）。

做法：直接用 adb shell toybox nc 在设备内访问 127.0.0.1:9977，
不依赖 adb forward（避免与其它会话抢 9222/19977）。
token 通过 SetupActivity 的开关生成——但 release 包 run-as 不可用，
所以这里直接调 DebugServer 的启动路径：先读端口，再逐端点测。

若服务没起（默认关闭），本脚本会明确报「未执行」，不编 PASS。
"""
import json
import re
import subprocess
import sys

ADB = r'C:\Android\platform-tools\adb.exe'
DEV = 'emulator-5556'
ok = True


def adb(*args, timeout=40):
    p = subprocess.run([ADB, '-s', DEV] + list(args), capture_output=True, timeout=timeout)
    return p.stdout.decode('utf-8', 'replace') + p.stderr.decode('utf-8', 'replace')


def check(label, cond, detail=''):
    global ok
    print(('PASS ' if cond else 'FAIL ') + label + ((' | ' + str(detail)[:150]) if detail else ''))
    if not cond:
        ok = False


def dev_http(path, method='GET', body=None, token=''):
    """在设备内用 toybox nc 发一个 HTTP 请求（服务只监听 127.0.0.1）。"""
    headers = [f'{method} {path} HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close']
    if token:
        headers.append(f'X-Meow-Token: {token}')
    if body is not None:
        b = json.dumps(body)
        headers.append('Content-Type: application/json')
        headers.append(f'Content-Length: {len(b.encode())}')
        raw = '\r\n'.join(headers) + '\r\n\r\n' + b
    else:
        raw = '\r\n'.join(headers) + '\r\n\r\n'
    # 用 base64 传，避免引号/换行在 shell 里被吃掉
    import base64
    b64 = base64.b64encode(raw.encode()).decode()
    cmd = (f"echo {b64} | toybox base64 -d > /data/local/tmp/req.bin; "
           f"toybox nc 127.0.0.1 9977 < /data/local/tmp/req.bin")
    return adb('shell', cmd, timeout=45)


def parse_body(resp):
    i = resp.find('\r\n\r\n')
    if i < 0:
        return ''
    return resp[i + 4:]


# ---- 1. 服务是否在跑 ----
port_check = adb('shell', 'toybox nc -z 127.0.0.1 9977 && echo UP || echo DOWN')
up = 'UP' in port_check
print('DebugServer 9977:', 'UP' if up else 'DOWN')
if not up:
    print()
    print('未执行：DebugServer 未启动（默认关闭，需在 TV 配置页开启「远程调试」）。')
    print('这不算失败——但下面的端点一个也没验到，请如实记录为「未验证」。')
    sys.exit(2)

# ---- 2. 无 token 必须 403（这是安全底线）----
r = dev_http('/health', token='')
check('无 token → 403', '403' in r.split('\n')[0], r.split('\n')[0][:60])

# 拿不到 token 就无法测后续；release 包读不到 prefs，只能提示
print()
print('注意：release 包的 token 存在 prefs 里，adb 无权读取（package not debuggable）。')
print('下面 5 个只读端点用空 token 会全部 403，无法验证行为。')
print('要完整验证，请在 TV 配置页读出令牌后手工传给本脚本的 TOKEN 环境变量，')
print('或装 debug 包（build-apk.ps1 -Variant debug）后用 run-as 读 prefs。')

token = __import__('os').environ.get('TOKEN', '')
if not token:
    print()
    print('未执行后续端点：缺少 TOKEN。')
    sys.exit(2)

# ---- 3. 带 token 的端点 ----
r = dev_http('/health', token=token)
b = parse_body(r)
check('/health 200 且有 version', '200' in r.split('\n')[0] and 'version' in b, b[:100])

for ep, key in [('/console', 'errors'), ('/network', 'net'), ('/danmaku', 'mounted'),
                ('/dom', 'hash'), ('/perf', 'resources'), ('/gateway', 'gatewayRunning')]:
    r = dev_http(ep, token=token)
    b = parse_body(r)
    good = '200' in r.split('\n')[0]
    check(f'{ep} 200', good, b[:100])
    if good:
        try:
            j = json.loads(b.strip())
            check(f'{ep} 结构含 {key} 或 ok', key in j or 'ok' in j, list(j.keys())[:6])
        except Exception as e:
            check(f'{ep} 是合法 JSON', False, str(e)[:60])

r = dev_http('/navigate', method='POST', body={'hash': '#/settings'}, token=token)
check('/navigate 200', '200' in r.split('\n')[0], parse_body(r)[:80])

r = dev_http('/wait', method='POST', body={'js': 'document.body!=null', 'timeout_ms': 3000}, token=token)
b = parse_body(r)
check('/wait 200 且 ok=true', '200' in r.split('\n')[0] and '"ok":true' in b.replace(' ', ''), b[:100])

print()
print('ALL PASS' if ok else 'SOME FAILED')
sys.exit(0 if ok else 1)
