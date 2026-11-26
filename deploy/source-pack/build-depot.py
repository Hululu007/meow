#!/usr/bin/env python3
"""把单仓源包改造成 meow 的多仓（depot）形态。

背景
----
应用侧多仓格式是 Fongmi 的 `{"urls":[{name,url},...]}`：导入时**只加载第一个仓**，
其余存成列表供用户手动切仓（`ApiServer.handleConfigImport` 的实现与
Fongmi `VodConfig.parseDepot` 一致）。多仓本质是"收藏夹"，不是聚合——
聚合会让同名站互相覆盖、搜索目标翻几倍。

改造后结构
----------
    default-sources/
    ├── config.all.json          # 多仓索引 {"urls":[...]}（jvm/tv 同内容，兼容保留）
    ├── source-pack.json         # artifacts 指向 packs/fatcat/*，新增 depot 段
    └── packs/
        ├── fatcat/              # 仓1：原单仓内容（jar 站）自包含
        └── scripts/             # 仓2：脚本源（py/js），api 用 __SOURCE_BASE__

为什么要每个仓自包含
--------------------
仓1 的 jar 也搬进 `packs/fatcat/`，不留在根：这样任何一个仓的 URL 集合都只依赖
自己的目录，搬仓/单独部署/单独更新都不会牵动另一个仓。

向后兼容
--------
老用户填的是 `http://host:18080/config.all.json`，改造后这个地址返回多仓索引，
导入时只加载仓1（肥猫），行为与以前等价。

用法
----
    # 只改造已有目录（不注入脚本仓）
    python3 build-depot.py --root deploy/docker/default-sources

    # 连脚本仓一起注入
    python3 build-depot.py --root deploy/docker/default-sources \\
        --scripts-src <含 config.all.json + py/ + js/ 的目录>

幂等：重复跑不会叠加嵌套（先清 packs/ 再重建）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

PLACEHOLDER = "__SOURCE_BASE__"
JARS = ("spider-dex.jar", "spider.jar", "spider-ext-dex.jar", "spider-ext.jar")
CONFIGS = ("config.all.json", "config.jvm.json", "config.tv.json")


def load(p: Path) -> dict:
    return json.loads(p.read_text(encoding="utf-8"))


def dump(p: Path, obj: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    # newline='\n'：Windows 上 'w' 会写成 CRLF，源包是 Linux 部署，CRLF 会让
    # shell/nginx 侧解析异常，也会让 diff 爆炸。
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n",
                 encoding="utf-8", newline="\n")


def rewrite_jar_urls(cfg: dict, prefix: str) -> int:
    """把仓内配置里的 jar 地址改到本仓目录下。返回改动条数。"""
    n = 0
    for key in ("spider", "spiderJvm"):
        v = str(cfg.get(key) or "")
        if v:
            rest = v.split(PLACEHOLDER, 1)[-1]           # 去掉旧前缀
            new = PLACEHOLDER + "/" + prefix + rest
            if new != v:
                cfg[key] = new
                n += 1
    for s in cfg.get("sites") or []:
        if not isinstance(s, dict):
            continue
        jar = str(s.get("jar") or "")
        if jar:
            rest = jar.split(PLACEHOLDER, 1)[-1]
            s["jar"] = PLACEHOLDER + "/" + prefix + rest
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="源包根目录（会被就地改造）")
    ap.add_argument("--scripts-src", help="脚本仓源目录：含 config.all.json + py/ + js/")
    ap.add_argument("--fatcat-name", default="肥猫+Jable")
    ap.add_argument("--scripts-name", default="脚本源")
    ap.add_argument("--fatcat-id", default="fatcat")
    ap.add_argument("--scripts-id", default="scripts")
    a = ap.parse_args()

    root = Path(a.root).resolve()
    if not (root / "config.all.json").is_file():
        print(f"缺少 {root/'config.all.json'}", file=sys.stderr)
        return 2

    # 幂等保护：第一次跑已经把根目录的 jar 移进 packs/，直接重跑会找不到 jar
    # 而"跳过"，结果仓1 的 jar 就凭空消失。要重跑请先从备份恢复目录。
    try:
        _peek = load(root / "config.all.json")
    except Exception:
        _peek = {}
    if isinstance(_peek.get("urls"), list):
        print("该目录已经是多仓形态（根 config 有 urls）。要重跑请先恢复原始目录：",
              file=sys.stderr)
        print("  cp -a <备份>/default-sources/. deploy/docker/default-sources/",
              file=sys.stderr)
        return 2

    packs = root / "packs"
    if packs.exists():
        shutil.rmtree(packs)
    packs.mkdir(parents=True)

    # ---------- 仓1：原单仓内容整体搬进 packs/<fatcat> ----------
    fatcat = packs / a.fatcat_id
    fatcat.mkdir()
    for c in CONFIGS:
        src = root / c
        if src.is_file():
            cfg = load(src)
            changed = rewrite_jar_urls(cfg, f"packs/{a.fatcat_id}")
            dump(fatcat / c, cfg)
            print(f"[仓1] {c}: sites={len(cfg.get('sites') or [])}, 改 jar 地址 {changed} 处")
    for j in JARS:
        src = root / j
        if src.is_file():
            shutil.move(str(src), str(fatcat / j))
            print(f"[仓1] {j} -> packs/{a.fatcat_id}/")

    repos = [(a.fatcat_name, f"{PLACEHOLDER}/packs/{a.fatcat_id}/config.all.json")]

    # ---------- 仓2：脚本源 ----------
    if a.scripts_src:
        ssrc = Path(a.scripts_src).resolve()
        cfg_path = ssrc / "config.all.json"
        if not cfg_path.is_file():
            print(f"脚本仓缺 config.all.json：{ssrc}", file=sys.stderr)
            return 2
        scripts = packs / a.scripts_id
        scripts.mkdir()
        cfg = load(cfg_path)
        sites = cfg.get("sites") or []

        # py/js 的 api 一律改成本仓内的绝对路径；CMS 的 http api 原样保留
        py = js = cms = other = 0
        for s in sites:
            api = str(s.get("api") or "")
            low = api.lower()
            if low.endswith(".py"):
                name = os.path.basename(api.replace("\\", "/"))
                s["api"] = f"{PLACEHOLDER}/packs/{a.scripts_id}/py/{name}"
                py += 1
            elif low.endswith(".js"):
                name = os.path.basename(api.replace("\\", "/"))
                s["api"] = f"{PLACEHOLDER}/packs/{a.scripts_id}/js/{name}"
                js += 1
            elif low.startswith(("http://", "https://")):
                cms += 1
            else:
                other += 1
                print(f"  [警告] 无法判定的 api：{s.get('key')} -> {api[:60]}")
        # 脚本仓没有自己的 spider：显式指向仓1 的 jar，避免 replaceSpider 导入时
        # 把顶层 spider 清空（那会让 54 个 jar 站全部 ClassNotFound）。
        # ★ 直接复用仓1 的完整值（含 ;md5;）——手拼容易漏 md5，而漏了会被
        #   validate.py 判"缺少 ;md5;"，客户端也会继续用旧缓存。
        fatcat_cfg = load(fatcat / "config.all.json")
        for k in ("spider", "spiderJvm"):
            if fatcat_cfg.get(k):
                cfg[k] = fatcat_cfg[k]
        dump(scripts / "config.all.json", cfg)
        print(f"[仓2] config.all.json: sites={len(sites)}（py={py} js={js} cms={cms} 其他={other}）")

        for kind in ("py", "js"):
            srcd = ssrc / kind
            if not srcd.is_dir():
                print(f"  [警告] 缺 {kind}/ 目录，跳过")
                continue
            dstd = scripts / kind
            dstd.mkdir()
            n = 0
            for f in sorted(srcd.iterdir()):
                if f.is_file() and f.suffix.lower() == "." + kind:
                    shutil.copy2(f, dstd / f.name)
                    n += 1
            print(f"[仓2] {kind}/: {n} 个文件")

        repos.append((a.scripts_name, f"{PLACEHOLDER}/packs/{a.scripts_id}/config.all.json"))

    # ---------- 根：多仓索引 ----------
    depot = {
        "urls": [{"name": name, "url": url} for name, url in repos],
        # Fongmi/猫窝读 urls；其余键留空对象，避免老客户端把缺失字段当异常
        "notes": "多仓索引：导入时只加载第一个仓，其余供切换（猫窝设置页可一键切仓）",
    }
    for c in CONFIGS:
        dump(root / c, depot)
    print(f"[索引] config.all.json / .jvm / .tv → 多仓 {len(repos)} 个："
          + ", ".join(n for n, _ in repos))

    # ---------- source-pack.json ----------
    sp_path = root / "source-pack.json"
    if sp_path.is_file():
        sp = load(sp_path)
        for art in sp.get("artifacts") or []:
            name = str(art.get("name") or "")
            if name in JARS:
                art["name"] = f"packs/{a.fatcat_id}/{name}"
        sp["depot"] = {
            "version": 1,
            "repos": [{"id": a.fatcat_id, "name": a.fatcat_name,
                       "config": f"packs/{a.fatcat_id}/config.all.json"}],
        }
        if a.scripts_src:
            sp["depot"]["repos"].append(
                {"id": a.scripts_id, "name": a.scripts_name,
                 "config": f"packs/{a.scripts_id}/config.all.json"})
        dump(sp_path, sp)
        print("[清单] source-pack.json artifacts 已指向 packs/"
              f"{a.fatcat_id}/，新增 depot 段 {len(sp['depot']['repos'])} 个仓")

    print("\n完成。部署时 MEOW_SOURCES_BASE 必须是局域网/公网地址"
          "（validate.py 禁止 127.0.0.1）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
