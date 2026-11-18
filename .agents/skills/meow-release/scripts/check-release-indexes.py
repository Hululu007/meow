#!/usr/bin/env python3
"""发版后三索引一致性检查（纯标准库，依赖 git 与 gh CLI）。

用法（仓库根目录执行）：
    python .agents/skills/meow-release/scripts/check-release-indexes.py 1.2.17
    python .agents/skills/meow-release/scripts/check-release-indexes.py 1.2.17 --skip-gh

检查：
  1. updates 分支 packages.json：meow-pc / meow-tv / apiserver 均为目标版本
  2. FnDepot fnpack.json：apps.meow.releases 含目标版本
  3. 主仓 fpk-updates 分支 fpk.json：apps.meow.releases 含目标版本
"""
import argparse
import json
import subprocess
import sys


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {r.stderr.strip()[:300]}")
    return r.stdout


def git_json(ref, path):
    return json.loads(run(["git", "show", f"{ref}:{path}"]))


def latest(keys):
    """按数字段取最大版本（字典序会把 1.2.16 排到 1.2.9 前面）。"""
    def t(k):
        try:
            return tuple(int(x) for x in k.split("."))
        except ValueError:
            return (0,)
    return max(keys, key=t) if keys else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version", help="目标版本，如 1.2.17")
    ap.add_argument("--skip-gh", action="store_true", help="跳过 FnDepot（无 gh 或离线时）")
    args = ap.parse_args()
    ver = args.version
    rows = []  # (name, ok, detail)

    # 1) 主仓清单
    try:
        run(["git", "fetch", "-q", "origin", "updates"])
        pkg = git_json("origin/updates", "packages.json")
        got = {k: v.get("version") for k, v in (pkg.get("packages") or {}).items()
               if k in ("meow-pc", "meow-tv", "apiserver")}
        bad = {k: v for k, v in got.items() if v != ver}
        rows.append(("packages.json", not bad, f"source_tag={pkg.get('source_tag')} {got}"))
    except Exception as e:  # noqa: BLE001
        rows.append(("packages.json", False, str(e)))

    # 2) FnDepot
    if args.skip_gh:
        rows.append(("FnDepot fnpack.json", None, "skipped"))
    else:
        try:
            raw = run(["gh", "api", "repos/upchr/FnDepot/contents/fnpack.json",
                       "-H", "Accept: application/vnd.github.raw"])
            fn = json.loads(raw)
            rel = (fn.get("apps") or {}).get("meow", {}).get("releases") or {}
            rows.append(("FnDepot fnpack.json", ver in rel,
                         f"latest={latest(rel)} count={len(rel)}"))
        except Exception as e:  # noqa: BLE001
            rows.append(("FnDepot fnpack.json", False, str(e)))

    # 3) fpk 镜像
    try:
        run(["git", "fetch", "-q", "origin", "fpk-updates"])
        fp = git_json("origin/fpk-updates", "fpk.json")
        rel = (fp.get("apps") or {}).get("meow", {}).get("releases") or {}
        rows.append(("fpk-updates fpk.json", ver in rel,
                     f"latest={latest(rel)} count={len(rel)}"))
    except Exception as e:  # noqa: BLE001
        rows.append(("fpk-updates fpk.json", False, str(e)))

    failed = False
    for name, ok, detail in rows:
        mark = "SKIP" if ok is None else ("OK  " if ok else "FAIL")
        if ok is False:
            failed = True
        print(f"[{mark}] {name}: {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
