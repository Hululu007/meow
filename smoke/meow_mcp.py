#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""兼容入口：真正实现在 `.agents/skills/meow-control/scripts/meow_mcp.py`。

MCP 客户端跟着控制技能走（技能目录是应用仓库内的唯一真源），这里保留
`python smoke/meow_mcp.py ...` 这个老路径，脚本、文档和 AGENTS 命令都不用改。
"""
import pathlib
import runpy
import sys

TARGET = (
    pathlib.Path(__file__).resolve().parents[1]
    / ".agents"
    / "skills"
    / "meow-control"
    / "scripts"
    / "meow_mcp.py"
)

if not TARGET.exists():
    sys.stderr.write(f"找不到 MCP 客户端：{TARGET}\n")
    sys.exit(1)

runpy.run_path(str(TARGET), run_name="__main__")
