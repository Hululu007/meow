#!/usr/bin/env python3
"""空壳站点表回归：没有 spider.jar / config 时，不能下发幽灵站点。

背景：公开壳删掉了 spider.jar 与 config.sites.json，但 ApiServer 源码里
仍保留一份历史默认站点名（44 条）。如果 /api/sites 直接遍历 SITES，
空壳会显示 44 个点进去全失败的站点，用户以为“源包没清干净”。

这个脚本用 **空数据目录 + 无 spider.jar** 起一个后端，断言：
  * /api/sites 只有 NativeSources 里真正有实现的站点（当前是豆瓣）
  * /api/config 的站点表与 /api/sites 一致
  * /api/health 的 sites/ext 与站点表一致，spiderJar=false
  * 没有 ext 幽灵条目

用法（先编译）：
    cd server/host
    mkdir -p classes
    javac -encoding UTF-8 -cp 'libs/*' -d classes $(find src -name '*.java')
    python3 test_empty_shell_sites.py
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HOST_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HOST_DIR))


def free_port() -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def get_json(url: str):
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_health(base: str, proc: subprocess.Popen, timeout: float = 25.0):
    end = time.time() + timeout
    last = ""
    while time.time() < end:
        if proc.poll() is not None:
            raise RuntimeError("后端提前退出（exit=%s）" % proc.returncode)
        try:
            return get_json(base + "/api/health")
        except Exception as exc:  # 端口还没起来
            last = str(exc)
            time.sleep(0.25)
    raise RuntimeError("等待 /api/health 超时：%s" % last)


def main() -> int:
    # 完整包（带内置 jar）不属于这个门禁；公开库不应该有这个文件。
    if os.path.isfile(os.path.join(HOST_DIR, "libs", "spider.jar")):
        print("SKIP: server/host/libs/spider.jar 存在（完整包，不跑空壳门禁）")
        return 0

    classes = os.path.join(HOST_DIR, "classes")
    if not os.path.isdir(classes):
        print("FAIL: 缺少 server/host/classes，请先 javac 编译")
        return 2

    port = free_port()
    data_dir = tempfile.mkdtemp(prefix="meow-empty-shell-")
    classpath = classes + os.pathsep + os.path.join(HOST_DIR, "libs", "*")
    cmd = [
        "java",
        "-Dfile.encoding=UTF-8",
        "-cp",
        classpath,
        "ApiServer",
        "--port=%d" % port,
        "--data-dir=%s" % data_dir,
    ]
    proc = subprocess.Popen(
        cmd,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    base = "http://127.0.0.1:%d" % port
    try:
        health = wait_health(base, proc)
        sites_body = get_json(base + "/api/sites")
        config_body = get_json(base + "/api/config")

        keys = [str(s.get("key", "")) for s in sites_body.get("sites", [])]
        cfg_keys = [str(s.get("key", "")) for s in config_body.get("sites", [])]

        failures = []
        if keys != ["Douban"]:
            failures.append("/api/sites 期望只有 ['Douban']，实际 %r" % keys)
        if cfg_keys != keys:
            failures.append("/api/config 与 /api/sites 不一致：%r vs %r" % (cfg_keys, keys))
        if health.get("sites") != len(keys):
            failures.append("health.sites=%r != /api/sites 条数 %d" % (health.get("sites"), len(keys)))
        if health.get("ext") != 0:
            failures.append("health.ext=%r，空壳不应有 ext 幽灵条目" % health.get("ext"))
        if health.get("spiderJar") is not False:
            failures.append("health.spiderJar=%r，空壳应为 false" % health.get("spiderJar"))

        if failures:
            print("FAIL: 空壳站点表门禁")
            for f in failures:
                print("  - " + f)
            print("health=" + json.dumps(health, ensure_ascii=False))
            print("sites=" + json.dumps(sites_body, ensure_ascii=False))
            return 1

        print("PASS: 空壳只剩原生站点 %r；health.sites=%d, ext=%d, spiderJar=%r"
              % (keys, health.get("sites"), health.get("ext"), health.get("spiderJar")))
        return 0
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print("FAIL: %s" % exc)
        sys.exit(1)
