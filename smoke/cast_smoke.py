#!/usr/bin/env python3
"""投屏链路冒烟：自有接收端（B 类）端到端。

覆盖：开接收端 → SSDP 发现 → 建会话 → 状态 → 遥控 → 进度 → 停止 → 令牌校验。
不含真机 DLNA 播放（需要一台电视，见 site/docs/dev/casting.md §11.2）。

前置：server/host/classes 已编译（`cd server/host && build.bat`）。
用法：python smoke/cast_smoke.py [--keep]
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "server" / "host"
DATA = ROOT / "tmp" / "2026-11-16-cast-smoke"


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http(url: str, data=None, timeout: int = 12):
    body = None
    method = "GET"
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode()
        method = "POST"
    req = urllib.request.Request(
        url, data=body, method=method, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_health(port: int, seconds: int = 30) -> bool:
    for _ in range(seconds * 2):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/health", timeout=1
            ) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="保留数据目录与日志")
    args = ap.parse_args()

    classes = HOST / "classes"
    if not classes.is_dir():
        print("classes 不存在，先编译：cd server/host && build.bat", file=sys.stderr)
        return 2

    shutil.rmtree(DATA, ignore_errors=True)
    DATA.mkdir(parents=True, exist_ok=True)
    port = free_port()
    cp = os.pathsep.join([str(classes), str(HOST / "libs" / "*")])
    proc = subprocess.Popen(
        [
            "java",
            "-Dfile.encoding=UTF-8",
            "-cp",
            cp,
            "ApiServer",
            f"--port={port}",
            f"--data-dir={DATA}",
        ],
        cwd=str(HOST),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    ok = False
    try:
        if not wait_health(port):
            print("后端未起来", file=sys.stderr)
            return 1
        base = f"http://127.0.0.1:{port}"

        # 1) 开接收端
        rec = http(base + "/api/cast/receiver", {"enabled": True, "name": "CastSmoke"})
        assert rec.get("running") is True, rec

        # 2) 发现：只认本机刚开的那个接收端（局域网里可能有真机设备）
        d = http(base + "/api/cast?timeout=3000")
        my_udn = rec.get("udn")
        me = [
            x
            for x in d.get("devices", [])
            if x.get("kind") == "meow" and x.get("udn") == my_udn
        ]
        assert me, f"没发现本机 meow 设备（udn={my_udn}）: {d}"
        dev = me[0]
        assert dev.get("base", "").startswith("http://"), dev
        assert dev.get("token"), dev

        # 3) 建会话
        media = {
            "url": f"{dev['base']}/api/proxy/stream?url=http%3A%2F%2Fexample.com%2Fa.m3u8",
            "title": "冒烟片",
            "position": 7,
        }
        s = http(
            dev["base"] + "/api/cast/session?ct=" + dev["token"],
            {"media": media, "sender": {"name": "smoke"}},
        )
        assert s.get("ok") is True and s.get("sessionId"), s
        sid = s["sessionId"]

        # 4) 状态
        st = http(dev["base"] + f"/api/cast/session?ct={dev['token']}&id={sid}")
        assert st.get("state") in ("pending", "playing"), st
        assert st.get("position") == 7, st

        # 5) 遥控 / 进度
        assert (
            http(
                dev["base"] + "/api/cast/command?ct=" + dev["token"],
                {"sessionId": sid, "action": "seek", "value": 30},
            ).get("ok")
            is True
        )
        st_seek = http(dev["base"] + f"/api/cast/session?ct={dev['token']}&id={sid}")
        assert st_seek.get("position") == 30, st_seek
        # 命令后 3s 内忽略播放器回报（防反馈环覆盖），过了窗口再收进度
        time.sleep(3.2)
        assert (
            http(
                dev["base"] + "/api/cast/progress?ct=" + dev["token"],
                {
                    "sessionId": sid,
                    "state": "playing",
                    "position": 31,
                    "duration": 100,
                },
            ).get("ok")
            is True
        )
        st2 = http(dev["base"] + f"/api/cast/session?ct={dev['token']}&id={sid}")
        assert st2.get("position") == 31, st2

        # 6) 停止 → 会话清空
        assert (
            http(
                dev["base"] + "/api/cast/command?ct=" + dev["token"],
                {"sessionId": sid, "action": "stop"},
            ).get("ok")
            is True
        )
        st3 = http(dev["base"] + f"/api/cast/session?ct={dev['token']}")
        assert st3.get("state") == "idle", st3

        # 7) 令牌必须生效
        try:
            urllib.request.urlopen(dev["base"] + "/api/cast/session?ct=bad", timeout=5)
            raise AssertionError("错令牌竟然通过了")
        except urllib.error.HTTPError as e:
            assert e.code == 403, e.code

        print("PASS cast_smoke")
        ok = True
        return 0
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=8)
        except Exception:
            proc.kill()
            out = ""
        if not ok and out:
            print(out[-3000:], file=sys.stderr)
        if not args.keep:
            shutil.rmtree(DATA, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
