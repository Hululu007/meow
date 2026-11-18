#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""猫窝统一 MCP 客户端：一套接口同时驱动 PC 与 TV。

## 为什么要有它

改之前是两套东西：PC 走 MCP 的 JSON-RPC（`smoke/pc_smoke.py`），TV 走自定义
REST（`smoke/tv_mcp.py`）。同一个验收动作——"读页面状态""按一下键""看网络
请求"——在两端写两遍，任何一边加字段都要改两处，迟早不一致。

现在 TV 的 `DebugServer` 也实现了 `/mcp`（`initialize` / `ping` /
`tools/list` / `tools/call`），工具名只差前缀（PC 是 `pc_*`，TV 是 `tv_*`）。
于是这个脚本能做一件事：**自动发现两端的服务，然后按同一套方式调用**。

## 端点怎么找（★ 这里有个关键设计）

**PC 端不在 info 文件里写端口**。`~/.zcode/meow-mcp.json` 只存 pid / 版本 /
CDP 端口，因为它写的端口是"上次运行时"的值——进程早没了文件还留着，看起来
像还活着；而且端口本身会因顺延变化，把易变量写进文件就是制造副本。

所以 PC 端要在 9339–9346 里**逐个探测** `/health`，看谁自报
`server: "meow-player"`。判据是响应体，不是"端口能连上"——同一段端口区间
可能跑着别的东西（历史上这里跑过别的服务）。

TV 端相反：它由 `DebugServer` 自己起服务并把端口打进 `/health`，
且**必须有令牌**才能访问，所以只能由调用方给出 host/port/token。

## 用法

    # 只探活，看两边都找到没有
    python smoke/meow_mcp.py probe

    # 列工具
    python smoke/meow_mcp.py tools --target pc
    python smoke/meow_mcp.py tools --target tv --host 127.0.0.1 --port 19777 --token debug0000000auto

    # 调工具（两端同一条命令，只换 target）
    #   注意 PC 没有 pc_state —— 页面状态用 pc_eval 取（expression 而非 js）
    python smoke/meow_mcp.py call pc_eval --target pc --args '{"expression":"location.hash"}'
    python smoke/meow_mcp.py call tv_state --target tv --host 127.0.0.1 --port 19777 --token debug0000000auto

    # TV 走 adb forward 的例子（模拟器/投影仪没有可路由 IP 时）
    adb forward tcp:19777 tcp:9977
    python smoke/meow_mcp.py call --target tv tv_network --port 19777 --token debug0000000auto

退出码：0 成功 / 1 失败 / 2 找不到服务
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# PC 端 MCP 的端口区间。必须与 mcp.rs 的 PORT_MIN/PORT_COUNT 保持一致。
PC_PORT_MIN = 9339
PC_PORT_COUNT = 8

INFO_PATH = os.path.expanduser(os.path.join("~", ".zcode", "meow-mcp.json"))


class Endpoint:
    """一个可调用的 MCP 端点。"""

    def __init__(self, kind, url, token='', note=''):
        self.kind = kind          # 'pc' | 'tv'
        self.url = url            # 完整 /mcp URL
        self.token = token
        self.note = note
        self._id = 0

    def __repr__(self):
        return '<%s %s>' % (self.kind, self.url)

    # ---------------------------------------------------------------- HTTP

    def _post(self, payload, timeout=30):
        body = json.dumps(payload).encode('utf-8')
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['X-Meow-Token'] = self.token
        req = urllib.request.Request(self.url, data=body, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8', 'replace'))

    def _get(self, path, timeout=10):
        base = self.url[:-4] if self.url.endswith('/mcp') else self.url
        headers = {}
        if self.token:
            headers['X-Meow-Token'] = self.token
        req = urllib.request.Request(base + path, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8', 'replace'))

    # ---------------------------------------------------------------- MCP

    def rpc(self, method, params=None, timeout=30):
        self._id += 1
        payload = {'jsonrpc': '2.0', 'id': self._id, 'method': method,
                   'params': params or {}}
        resp = self._post(payload, timeout=timeout)
        if 'error' in resp:
            raise RuntimeError('MCP error: %s' % resp['error'])
        return resp.get('result', {})

    def initialize(self):
        return self.rpc('initialize', {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'meow-mcp-client', 'version': '1.0'},
        })

    def tools(self):
        return self.rpc('tools/list').get('tools', [])

    def call(self, name, args=None, timeout=60):
        """调用工具，返回 (文本, isError)。

        工具内部的失败（如 eval 超时）不是协议错误：MCP 会正常返回
        content + isError，所以这里不抛异常，交给调用方判断。
        """
        res = self.rpc('tools/call', {'name': name, 'arguments': args or {}},
                       timeout=timeout)
        items = res.get('content') or []
        text = ''.join(i.get('text', '') for i in items if i.get('type') == 'text')
        return text, bool(res.get('isError'))

    def health(self):
        """走 REST 的 /health（两端都有），比 initialize 便宜。"""
        return self._get('/health')


# ---------------------------------------------------------------- 发现


def _looks_like_pc(h):
    """判断 /health 的返回是不是猫窝 PC 端。

    新版本自报 `server: "meow-player"`；0.9.15 及更早没有这个字段。
    对老版本退回"特征字段组合"判据（cdp_ready + plugins），因为这段端口
    区间里可能跑着别的服务，只看"能连上"会认错。

    兼容老版本不是洁癖：用户机器上装的往往是已发布版本，而客户端脚本是
    仓库里的最新版，两者必须能对上。
    """
    if not isinstance(h, dict):
        return False
    if h.get('server') == 'meow-player':
        return True
    return 'cdp_ready' in h and 'plugins' in h


def discover_pc(verbose=False):
    """在 9339–9346 里找 PC 端 MCP。

    判据是 /health 的响应体特征，不是"端口能连上"——区间里可能跑着
    别的服务，只看端口会认错。
    """
    for i in range(PC_PORT_COUNT):
        port = PC_PORT_MIN + i
        ep = Endpoint('pc', 'http://127.0.0.1:%d/mcp' % port, note='port %d' % port)
        try:
            h = ep._get('/health', timeout=0.8)
        except urllib.error.HTTPError:
            # 有 HTTP 响应但不是 /health 能处理的（404 等）：不是我们的服务
            continue
        except Exception:
            continue
        if not _looks_like_pc(h):
            if verbose and isinstance(h, dict) and h.get('ok'):
                print('[pc] 端口 %d 有服务但不是猫窝：%s'
                      % (port, str(h)[:120]), file=sys.stderr)
            continue
        ep.note = 'port %d, v%s, cdp %s' % (port, h.get('version', '?'), h.get('cdp', '?'))
        return ep
    return None


def discover_tv(host, port, token, verbose=False):
    """TV 端需要显式 host/port/token：它有鉴权，且宿主可能不在同一网段。"""
    if not host or not token:
        return None
    ep = Endpoint('tv', 'http://%s:%d/mcp' % (host, port), token=token,
                  note='%s:%d' % (host, port))
    try:
        h = ep._get('/health', timeout=3)
    except Exception as e:
        if verbose:
            print('[tv] %s:%d 不可达：%s' % (host, port, e), file=sys.stderr)
        return None
    if not isinstance(h, dict) or 'app' not in h:
        if verbose:
            print('[tv] %s:%d 有响应但不是猫窝 TV：%s'
                  % (host, port, str(h)[:120]), file=sys.stderr)
        return None
    ep.note = '%s:%d, v%s, token ok' % (host, port, h.get('app', '?'))
    return ep


def read_info():
    """读 info 文件里那些"不会变"的东西（pid / 版本 / CDP 端口）。

    注意这里**不读 mcp_port**——文件里没有这个键了，见模块开头的说明。
    """
    try:
        with open(INFO_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


# ---------------------------------------------------------------- 命令


def cmd_probe(args):
    info = read_info()
    print('info 文件: %s' % (INFO_PATH if info else '（不存在）'))
    if info:
        print('  pid=%s version=%s cdp_port=%s'
              % (info.get('pid'), info.get('version'), info.get('cdp_port')))
        rng = info.get('mcp_port_range')
        if rng:
            print('  mcp 端口应落在 %s–%s（文件不再写实际端口）' % (rng[0], rng[1]))

    ok = False
    pc = discover_pc(verbose=True)
    if pc:
        print('\n[pc] 找到 %s  (%s)' % (pc.url, pc.note))
        try:
            init = pc.initialize()
            si = init.get('serverInfo') or {}
            print('     serverInfo: %s %s' % (si.get('name'), si.get('version')))
            print('     工具数: %d' % len(pc.tools()))
            ok = True
        except Exception as e:
            print('     initialize 失败: %s' % e)
    else:
        print('\n[pc] 未找到。PC 应用没启动？（MCP 是应用内的线程，'
              '打开应用才有，没有独立进程可重启）')

    tv = discover_tv(args.host, args.port, args.token, verbose=True)
    if tv:
        print('\n[tv] 找到 %s  (%s)' % (tv.url, tv.note))
        try:
            init = tv.initialize()
            si = init.get('serverInfo') or {}
            print('     serverInfo: %s %s' % (si.get('name'), si.get('version')))
            print('     工具数: %d' % len(tv.tools()))
            ok = True
        except Exception as e:
            print('     initialize 失败: %s' % e)
    else:
        print('\n[tv] 未找到。需要 --host/--port/--token；'
              '模拟器先用 adb forward tcp:19777 tcp:9977')

    return 0 if ok else 2


def cmd_tools(args):
    ep = _pick(args)
    if not ep:
        return 2
    for t in ep.tools():
        req = (t.get('inputSchema') or {}).get('required') or []
        print('%-16s %s' % (t.get('name'), t.get('description', '')))
        if req:
            print('%-16s   必填: %s' % ('', ', '.join(req)))
    return 0


def cmd_call(args):
    ep = _pick(args)
    if not ep:
        return 2
    try:
        cargs = json.loads(args.args) if args.args else {}
    except Exception as e:
        print('--args 不是合法 JSON: %s' % e, file=sys.stderr)
        return 1
    try:
        text, is_err = ep.call(args.tool, cargs)
    except Exception as e:
        print('调用失败: %s' % e, file=sys.stderr)
        return 1
    print(text)
    return 1 if is_err else 0


def _pick(args):
    """按 --target 选一个端点。"""
    if args.target == 'pc':
        ep = discover_pc(verbose=True)
        if not ep:
            print('未找到 PC MCP（9339–9346）。应用没启动？', file=sys.stderr)
        return ep
    ep = discover_tv(args.host, args.port, args.token, verbose=True)
    if not ep:
        print('未找到 TV MCP。检查 --host/--port/--token。', file=sys.stderr)
    return ep


def main():
    ap = argparse.ArgumentParser(description='猫窝统一 MCP 客户端（PC + TV）')

    # 公共参数挂在父解析器上，子命令都能用；这样 `call tv_state --target tv`
    # 和 `call --target tv tv_state` 两种写法都成立（argparse 的位置参数
    # 一旦写在选项后面就解析不了，而人自然是先打工具名）。
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--target', choices=['pc', 'tv'], default='pc')
    common.add_argument('--host', default=os.environ.get('MEOW_TV_HOST', ''),
                        help='TV 地址（也可用环境变量 MEOW_TV_HOST）')
    common.add_argument('--port', type=int,
                        default=int(os.environ.get('MEOW_TV_PORT', '9977')),
                        help='TV 调试端口，默认 9977')
    common.add_argument('--token', default=os.environ.get('MEOW_TV_TOKEN', ''),
                        help='TV 令牌（也可用 MEOW_TV_TOKEN）')

    sub = ap.add_subparsers(dest='command', required=True)
    sub.add_parser('probe', parents=[common], help='探活：自动找 PC，按参数连 TV')
    sub.add_parser('tools', parents=[common], help='列出目标端支持的工具')
    p_call = sub.add_parser('call', parents=[common], help='调用一个工具')
    p_call.add_argument('tool', help='工具名，如 pc_state / tv_health')
    p_call.add_argument('--args', default='', help='工具参数，JSON 字符串')

    args = ap.parse_args()

    if args.command == 'probe':
        return cmd_probe(args)
    if args.command == 'tools':
        return cmd_tools(args)
    return cmd_call(args)


if __name__ == '__main__':
    sys.exit(main())
