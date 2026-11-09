"""
起一个 headless Edge 做 CDP 测试，**退出时保证收尾**。

## 为什么需要它（2026-11-04 事故）

反复 `msedge --headless=new --user-data-dir=tmp/...` 起浏览器做 CDP 测试，
收尾只 `Popen.terminate()`。Windows 上那只杀 **launcher**，renderer/GPU/
network 子进程继续活着——一个实例 8 个进程、约 600 MB commit。几十个小时
累积到提交内存 124.75 GiB（= 63.8 GB 物理 + 61 GB 页面文件），系统弹
"虚拟内存不足"，Edge 报 0xE0000008。

## 用法

    from edge_session import EdgeSession

    with EdgeSession("pc-check") as s:
        ws = s.ws_url          # 拿这个连 CDP
        # ... 用完之后什么都不用做

退出（**包括抛异常**）时：`taskkill /T /F` 杀整棵树 → 删 profile 目录。

另外 `EdgeSession.sweep_stale("pc-check")` 只清**同前缀**、超过 N 分钟的
残留目录——不会碰另一个会话正在跑的测试。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

# 压薄进程数：内置扩展的后台页实测占 7 个 renderer（16 进程 → 9）
BASE_FLAGS = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-default-apps",
    "--disable-background-networking",
    "--disable-sync",
]


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class EdgeSession:
    def __init__(self, prefix: str, root: str | None = None, start_url: str = "about:blank",
                 extra_flags: list[str] | None = None):
        self.prefix = prefix
        base = root or os.path.join(_repo_root(), "tmp", time.strftime("%Y-%m-%d-edge-session"))
        os.makedirs(base, exist_ok=True)
        # 每次一个全新空目录，绝不复制用户 profile（也绝不 33 条扩展）
        self.profile = os.path.join(base, "%s-%d-%d" % (prefix, os.getpid(), int(time.time() * 1000)))
        self.start_url = start_url
        self.extra_flags = extra_flags or []
        self.port = _free_port()
        self.proc: subprocess.Popen | None = None

    # ------------------------------------------------------------ 生命周期

    def __enter__(self) -> "EdgeSession":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.close()
        return False  # 不吞异常

    def start(self) -> None:
        edge = next((p for p in EDGE_CANDIDATES if os.path.isfile(p)), None)
        if not edge:
            raise RuntimeError("找不到 msedge.exe")
        cmd = [edge, *BASE_FLAGS, *self.extra_flags,
               "--user-data-dir=" + self.profile,
               "--remote-debugging-port=%d" % self.port,
               self.start_url]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % self.port, timeout=1):
                    return
            except Exception:
                time.sleep(0.2)
        self.close()
        raise RuntimeError("Edge CDP 在 20s 内没起来")

    def close(self) -> None:
        if self.proc is not None:
            # ★ /T 是关键：只杀 launcher 就是 2026-11-04 那次事故
            subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                           capture_output=True)
            try:
                self.proc.wait(timeout=8)
            except Exception:
                pass
            self.proc = None
        self._rm_profile()

    def _rm_profile(self) -> None:
        for _ in range(3):
            if not os.path.isdir(self.profile):
                return
            try:
                shutil.rmtree(self.profile)
                return
            except Exception:
                time.sleep(0.5)
        # Windows 上偶发文件仍被占用：交给 PowerShell 强删
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Remove-Item -LiteralPath '%s' -Recurse -Force -ErrorAction SilentlyContinue"
                        % self.profile], capture_output=True)

    # ------------------------------------------------------------ 查询

    @property
    def ws_url(self) -> str:
        with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % self.port, timeout=3) as r:
            pages = [t for t in json.loads(r.read().decode("utf-8")) if t.get("type") == "page"]
        if not pages:
            raise RuntimeError("没有 page target")
        return pages[0]["webSocketDebuggerUrl"]

    # ------------------------------------------------------------ 清理历史残留

    @staticmethod
    def sweep_stale(prefix: str, minutes: int = 90, root: str | None = None) -> list[str]:
        """删掉**同前缀**、超过 minutes 分钟没动过的 profile 目录。

        只按前缀匹配，所以不会碰到别的脚本/别的会话正在用的 profile。
        """
        # 0 分钟会把"同前缀的活实例"也算成残留（mtime 永远小于 now），
        # 多会话并行时等于互相删；低于 5 分钟直接拒绝。
        if minutes < 5:
            raise ValueError("sweep_stale 的 minutes 必须 >= 5（防止删掉并行会话正在用的 profile）")
        base = root or os.path.join(_repo_root(), "tmp", time.strftime("%Y-%m-%d-edge-session"))
        removed = []
        if not os.path.isdir(base):
            return removed
        cutoff = time.time() - minutes * 60
        for name in os.listdir(base):
            if not name.startswith(prefix + "-"):
                continue
            p = os.path.join(base, name)
            try:
                if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                    shutil.rmtree(p)
                    removed.append(p)
            except Exception:
                pass
        return removed


# ---------------------------------------------------------------- 自测
# 验证"起多个 → 全收尾 → 0 残留"，不进正式流程。
def _selftest(n: int = 3) -> int:
    EdgeSession.sweep_stale("selftest", minutes=5)
    sessions = []
    try:
        for i in range(n):
            s = EdgeSession("selftest")
            s.start()
            sessions.append(s)
        total = sum(1 for _ in _edge_procs())
        print("起了 %d 个实例，msedge 进程 %d 个，profile 目录 %d 个"
              % (n, total, sum(1 for s in sessions if os.path.isdir(s.profile))))
    finally:
        for s in sessions:
            s.close()
    time.sleep(1)
    left_dirs = [s.profile for s in sessions if os.path.isdir(s.profile)]
    left_procs = sum(1 for _ in _edge_procs())
    print("收尾后：残留进程 %d，残留目录 %d" % (left_procs, len(left_dirs)))
    ok = left_procs == 0 and not left_dirs
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


def _edge_procs():
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | "
                          "Where-Object { $_.CommandLine -like '*edge-session*' } | "
                          "ForEach-Object { $_.ProcessId }"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    return [x for x in out.stdout.split() if x.strip()]


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        n = int(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 3
        raise SystemExit(_selftest(n))
    print(__doc__)
