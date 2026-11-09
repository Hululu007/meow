#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在局域网里找猫窝 TV 的调试服务（DebugServer / MCP）。

## 为什么需要它

TV 跑在模拟器、容器或投影仪里，IP 经常变（NAT 网段、DHCP 重分配、桥接切换），
而 `DebugServer` 的端口也会顺延（9977 起，被占就 +1）。手工猜 IP 与端口
是纯粹的浪费——这个脚本把"猜"变成"测"。

## 探测策略（三层，先便宜后贵）

1. **端口**：`DebugServer` 从 9977 起，最多顺延 20 个（跳过 9978 网关位），
   所以扫 9977 与 9979–9996。
2. **主机**：宿主机所有私有 IPv4 网段的 /24，外加几个常见家用网段
   （桥接/直连的模拟器可能落在别的段里）。
3. **判据**：`/health` 返回里有 `app` + `appCode` 字段。

## 令牌

`DebugServer` 的鉴权在**最前面**——所有端点（含 `/health`）都要带
`X-Meow-Token`，所以"探测"必须同时带令牌，否则连"这是不是猫窝"都看不出来。

- debug 包自动开启并使用固定令牌 `debug0000000auto`
- release 包需要人工点「远程调试」，令牌在屏幕上（4 位一组）

令牌不对时会收到 403——脚本会把它单独报出来，因为那说明**服务是猫窝、
只是令牌错了**，这与"这个端口不是猫窝"是完全不同的结论。

## 用法

    python smoke/tv_discover.py                          # 用 debug 包默认令牌
    python smoke/tv_discover.py --token 1fa7-761b-5da2   # 屏幕上的 release 令牌
    python smoke/tv_discover.py --peer 192.168.1.180     # 只测一台，不扫全网

退出码：0 找到 / 1 未找到 / 2 参数问题
"""

import argparse
import asyncio
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.request

# DebugServer 的端口窗口：BASE_PORT=9977，PORT_TRIES=20，跳过 9978（端内网关）
BASE_PORT = 9977
PORT_TRIES = 20
GATEWAY_PORT = 9978

# debug 包自动使用的固定令牌（MainActivity.syncDebugServer）
DEBUG_TOKEN = 'debug0000000auto'

# 兜底网段：桥接/直连的设备不一定在本机网卡所在的 /24 里
COMMON_PREFIXES = ['192.168.0', '192.168.1', '192.168.2', '192.168.31', '10.0.0']


def candidate_ports():
    out = []
    for i in range(PORT_TRIES):
        p = BASE_PORT + i
        if p == GATEWAY_PORT:
            continue
        out.append(p)
    return out


def local_prefixes():
    """本机的私有 IPv4 /24 前缀。"""
    out = []
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        addrs = [i[4][0] for i in infos]
    except Exception:
        addrs = []
    # getaddrinfo 拿不全时退回连外网看出口地址（UDP 不实际发包）
    if not addrs:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('223.5.5.5', 53))
            addrs = [s.getsockname()[0]]
            s.close()
        except Exception:
            pass
    for ip in addrs:
        parts = ip.split('.')
        if len(parts) != 4:
            continue
        prefix = '.'.join(parts[:3])
        if not is_private(prefix + '.1'):
            continue
        if prefix not in out:
            out.append(prefix)
    return out


def is_private(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return a.is_private and not a.is_loopback


async def probe(host, port, token, timeout=0.9):
    """连接一个 host:port 并尝试 /health。

    返回 (状态, 详情)：
      ('tv', {...})      是猫窝 TV，且令牌正确
      ('forbidden', None) 是猫窝 TV，但令牌不对（403）
      (None, None)        不是（连不上 / 不是 HTTP / 不是猫窝）
    """
    # 先用裸 TCP 快速过滤：绝大多数目标在这里就被排除了，
    # 不用等 HTTP 超时，也不产生无效的 HTTP 请求
    try:
        fut = asyncio.open_connection(host, port)
        reader, writer = await asyncio.wait_for(fut, timeout=timeout)
    except Exception:
        return None, None

    try:
        req = ('GET /health HTTP/1.0\r\nHost: %s:%d\r\nX-Meow-Token: %s\r\n\r\n'
               % (host, port, token))
        writer.write(req.encode())
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(8192), timeout=2.5)
    except Exception:
        return None, None
    finally:
        try:
            writer.close()
        except Exception:
            pass

    text = raw.decode('utf-8', 'replace')
    head, _, body = text.partition('\r\n\r\n')
    if ' 403 ' in head.split('\r\n')[0]:
        # 403 说明端口上是猫窝，只是令牌不对——这个信息必须区分出来，
        # 否则用户会以为"这台机器上没有服务"
        return 'forbidden', None
    if ' 200 ' not in head.split('\r\n')[0]:
        return None, None
    try:
        j = json.loads(body)
    except Exception:
        return None, None
    if not isinstance(j, dict) or 'app' not in j or 'appCode' not in j:
        return None, None
    return 'tv', j


async def scan(prefixes, token, concurrency=400):
    ports = candidate_ports()
    targets = [(p + '.' + str(i), port) for p in prefixes for i in range(1, 255)
               for port in ports]
    sem = asyncio.Semaphore(concurrency)
    found = []
    forbidden = []

    async def one(host, port):
        async with sem:
            kind, info = await probe(host, port, token)
            if kind == 'tv':
                found.append((host, port, info))
                print('  ✅ %s:%d  v%s  lanIp=%s  url=%s'
                      % (host, port, info.get('app'), info.get('lanIp'), info.get('url')),
                      flush=True)
            elif kind == 'forbidden':
                forbidden.append((host, port))

    await asyncio.gather(*(one(h, p) for h, p in targets))
    return found, forbidden


def main():
    ap = argparse.ArgumentParser(description='探测局域网里的猫窝 TV 调试服务（MCP）')
    ap.add_argument('--token', default=DEBUG_TOKEN,
                    help='X-Meow-Token；debug 包默认 %s' % DEBUG_TOKEN)
    ap.add_argument('--peer', action='append', default=[],
                    help='只测指定主机（可多次），不扫全网')
    args = ap.parse_args()

    token = args.token.replace('-', '')

    if args.peer:
        prefixes = sorted({p.rsplit('.', 1)[0] for p in args.peer if '.' in p})
        print('只测指定主机：%s' % ', '.join(args.peer))
    else:
        prefixes = local_prefixes()
        for p in COMMON_PREFIXES:
            if p not in prefixes:
                prefixes.append(p)
        print('扫描网段：%s' % ', '.join(prefixes) + '/24')
        print('扫描端口：9977, 9979-%d' % (BASE_PORT + PORT_TRIES - 1))

    print('（每个地址约 30–60 秒，命中会立即打印）\n')
    try:
        found, forbidden = asyncio.run(scan(prefixes, token))
    except KeyboardInterrupt:
        print('\n已中断')
        return 1

    print()
    if found:
        print('找到 %d 个猫窝 TV MCP：' % len(found))
        for host, port, info in found:
            print('  %s:%d   v%s   token=OK' % (host, port, info.get('app')))
        print('\n下一步：')
        host, port, _ = found[0]
        print('  python smoke/meow_mcp.py call tv_health --target tv '
              '--host %s --port %d --token %s' % (host, port, args.token))
        return 0

    if forbidden:
        print('发现 %d 个端点是猫窝但令牌不对（403）：' % len(forbidden))
        for host, port in forbidden:
            print('  %s:%d  → 用 --token 指定屏幕上的令牌' % (host, port))
        return 1

    print('没找到。可能原因（按概率排序）：')
    print('  1. 应用没在前台 / 远程调试没开（TV 端服务只在主界面 onResume 时起）')
    print('  2. 设备与本机不在同一网段（模拟器 NAT 模式：宿主机路由不到它的 IP）')
    print('  3. 云防火墙/系统防火墙拦了入站')
    print('\n验证第 2 条：模拟器改「桥接模式」后重启，让它拿到局域网 IP。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
