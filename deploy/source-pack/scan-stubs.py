#!/usr/bin/env python3
"""扫描 .py 源脚本，找出"搜索是桩"的站，给出应标 `searchable: 0` 的名单。

为什么需要这个
--------------
配置里的 `searchable` 决定客户端要不要对这个站发搜索请求（TV 端尤其明显：
不标就会被用户点"全选搜索"时挨个超时）。而"这个站的 search 是不是桩"只能
从脚本本身看出来 —— 源包校验器（validate.py）只看 jar 与 URL，看不到。

判据（只认静态可证的）
--------------------
`searchContent` / `search` 的函数体去掉 docstring 后，只剩：
  · `pass`
  · `return` / `return None` / `return ""`
  · `return {}` / `return {"list": []}` / `return {"data": []}`
有真实逻辑的一律不动 —— 误标会让能用的站从搜索里消失，比漏标严重得多。

用法
----
    # 只看名单
    python3 scan-stubs.py --dir /data/py-scripts/py

    # 直接改配置（给对应站点写入 "searchable": 0）
    python3 scan-stubs.py --dir /data/py-scripts/py --config config.all.json --write

    # 机器可读
    python3 scan-stubs.py --dir /data/py-scripts/py --json
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
from pathlib import Path

METHOD_NAMES = ("searchContent", "search")


def _is_empty_return(node: ast.AST) -> bool:
    if isinstance(node, ast.Pass):
        return True
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
        return True  # 只有字符串常量（docstring）
    if not isinstance(node, ast.Return):
        return False
    v = node.value
    if v is None:
        return True
    if isinstance(v, ast.Constant):
        return v.value in (None, "")
    if isinstance(v, ast.Dict):
        if not v.keys:
            return True
        if len(v.keys) == 1:
            k, val = v.keys[0], v.values[0]
            if isinstance(k, ast.Constant) and k.value in ("list", "data"):
                if isinstance(val, ast.List) and not val.elts:
                    return True
                if isinstance(val, ast.Dict) and not val.keys:
                    return True
    return False


def scan_file(path: Path) -> tuple[bool, str]:
    """返回 (是否桩, 说明)。解析失败按"不是桩"处理并给出原因。"""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError as e:
        return False, f"语法错误，跳过：{e.msg}"
    fn = None
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in METHOD_NAMES:
            fn = node
            break
    if fn is None:
        return False, "没有 searchContent/search，跳过"
    body = [
        b for b in fn.body
        if not (isinstance(b, ast.Expr) and isinstance(b.value, ast.Constant)
                and isinstance(b.value.value, str))
    ]
    if body and all(_is_empty_return(b) for b in body):
        first = ast.unparse(fn.body[0])[:60] if fn.body else ""
        return True, f"{fn.name}: {first}"
    return False, ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help=".py 源脚本目录")
    ap.add_argument("--config", help="config*.json；给了才可能写回")
    ap.add_argument("--write", action="store_true", help="把 searchable=0 写进 --config")
    ap.add_argument("--json", action="store_true", help="输出 JSON（{站名: reason}）")
    a = ap.parse_args()

    d = Path(a.dir)
    if not d.is_dir():
        print(f"目录不存在：{d}", file=sys.stderr)
        return 2

    stubs: dict[str, str] = {}
    for p in sorted(d.glob("*.py")):
        is_stub, why = scan_file(p)
        if is_stub:
            stubs[p.stem] = why

    if a.json:
        print(json.dumps(stubs, ensure_ascii=False, indent=2))
    else:
        print(f"扫描 {d}：{len(list(d.glob('*.py')))} 个脚本，桩 {len(stubs)} 个")
        for name, why in stubs.items():
            print(f"  {name:<24} {why}")

    if not (a.write and a.config):
        return 0

    # 写回：站点的 key 与脚本名可能不同（key 前缀 js_/py_、带 _py 后缀），
    # 所以按"脚本名出现在 key 里"匹配，两边都归一化一次。
    cfg_path = Path(a.config)
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    sites = cfg.get("sites")
    if not isinstance(sites, list):
        print("配置里没有 sites 数组，未改动", file=sys.stderr)
        return 2

    def norm(s: str) -> str:
        return s.lower().replace("js_", "").replace("py_", "").replace("-", "").replace("_", "")

    changed = 0
    for site in sites:
        if not isinstance(site, dict):
            continue
        key = str(site.get("key") or "")
        for name in stubs:
            if norm(name) and norm(name) in norm(key):
                if site.get("searchable") != 0:
                    site["searchable"] = 0
                    changed += 1
                break

    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"已写回 {cfg_path}：{changed} 个站点标为 searchable=0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
