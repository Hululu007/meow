#!/usr/bin/env python3
"""校验 meow-source-pack/1 源包目录。

只读、无第三方依赖。规则见同目录 README.md。

用法：
    python3 deploy/source-pack/validate.py --dir /vol2/1000/meow-sources \
        --base-url http://192.168.1.20:18080
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.parse
import zipfile
from pathlib import Path

MD5_RE = re.compile(r"^[0-9a-fA-F]{32}$")
HEX_RE = re.compile(r"^[0-9a-fA-F]{64}$")
SPIDER_PREFIX = "com/github/catvod/spider/"


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warns: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warns.append(msg)

    def ok(self, msg: str) -> None:
        print(f"[OK]   {msg}")

    def dump(self) -> int:
        print()
        for w in self.warns:
            print(f"[WARN] {w}")
        for e in self.errors:
            print(f"[ERR]  {e}")
        print(f"\n结果：{len(self.errors)} 个错误，{len(self.warns)} 个警告")
        return 1 if self.errors else 0


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def split_md5(url: str) -> tuple[str, str]:
    """返回 (去掉 ;md5; 的 URL, md5)。只接受一个 ;md5; 段。"""
    parts = url.split(";md5;")
    if len(parts) == 1:
        return url, ""
    if len(parts) != 2:
        return url, "__invalid__"
    return parts[0], parts[1].strip()


def check_url(url: str, what: str, rep: Report, allow_php: bool = True) -> urllib.parse.ParseResult | None:
    if not isinstance(url, str) or not url.strip():
        rep.error(f"{what} 为空")
        return None
    base, md5 = split_md5(url.strip())
    if md5 == "__invalid__":
        rep.error(f"{what} 的 ;md5; 段格式不对：{url}")
        return None
    if md5 and not MD5_RE.match(md5):
        rep.error(f"{what} 的 md5 不是 32 位 hex：{md5}")
    u = urllib.parse.urlparse(base)
    if u.scheme not in ("http", "https"):
        rep.error(f"{what} 必须是 http(s) 绝对地址：{url}")
        return None
    if not u.hostname:
        rep.error(f"{what} 缺少 host：{url}")
        return None
    if u.username or u.password:
        rep.error(f"{what} 不允许带账号密码：{url}")
    if u.hostname.lower() in ("localhost", "127.0.0.1", "::1"):
        rep.error(f"{what} 不允许指向回环地址：{url}")
    path = u.path.lower()
    if allow_php:
        if not (path.endswith(".jar") or path.endswith(".php")):
            rep.warn(f"{what} 不是 .jar/.php 结尾（仍按 ZIP 校验）：{url}")
    elif not path.endswith(".jar"):
        rep.error(f"{what} 必须是 .jar：{url}")
    return u


def local_file_for(url: str, root: Path, base_url: str) -> Path | None:
    base, _ = split_md5(url)
    u = urllib.parse.urlparse(base)
    path = urllib.parse.unquote(u.path)
    if base_url:
        b = base_url.rstrip("/") + "/"
        if base.startswith(b):
            rel = base[len(b):].split("?", 1)[0]
            return root / rel
    # URL 不在 base-url 下时，按文件名找本地文件（方便离线校验/换域名）
    name = Path(path).name
    return root / name if name else None


def jar_kind(path: Path, rep: Report, what: str) -> str | None:
    """返回 'dex' / 'class' / None（不可读）。"""
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
    except Exception as e:
        rep.error(f"{what} 不是可读的 ZIP/jar：{path.name}（{e}）")
        return None
    has_dex = any(n.startswith("classes") and n.endswith(".dex") for n in names)
    has_class = any(n.startswith(SPIDER_PREFIX) and n.endswith(".class") for n in names)
    if has_dex:
        return "dex"
    if has_class:
        return "class"
    rep.error(f"{what} 既没有 classes*.dex 也没有 {SPIDER_PREFIX}*.class：{path.name}")
    return None


def check_jar_url(
    url: str,
    what: str,
    want: str,
    root: Path,
    base_url: str,
    rep: Report,
    require_md5: bool = True,
) -> None:
    u = check_url(url, what, rep)
    if u is None:
        return
    base, md5 = split_md5(url)
    if require_md5 and not md5:
        rep.error(f"{what} 缺少 ;md5;：{url}")
    path = local_file_for(url, root, base_url)
    if path is None:
        rep.warn(f"{what} 无法映射本地文件，跳过内容校验：{url}")
        return
    if not path.is_file():
        rep.error(f"{what} 本地文件不存在：{path}")
        return
    kind = jar_kind(path, rep, what)
    if kind is None:
        return
    if want == "dex" and kind != "dex":
        rep.error(f"{what} 必须是 dex jar（含 classes.dex），实际是 {kind}")
    if want == "class" and kind != "class":
        rep.error(f"{what} 必须是 class jar（spider/*.class），实际是 {kind}")
    if md5:
        actual = md5_file(path)
        if actual.lower() != md5.lower():
            rep.error(f"{what} md5 不匹配：期望 {md5}，实际 {actual}")
    print(f"[OK]   {what}: {path.name} ({kind}, {path.stat().st_size} B)")


def load_json(path: Path, what: str, rep: Report) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        rep.error(f"缺少 {what}：{path}")
        return None
    except Exception as e:
        rep.error(f"{what} 不是合法 JSON：{e}")
        return None
    if not isinstance(data, dict):
        rep.error(f"{what} 顶层必须是对象")
        return None
    return data


def check_manifest(manifest: dict, root: Path, rep: Report) -> str:
    if manifest.get("schema") != "meow-source-pack/1":
        rep.error("source-pack.json schema 必须是 meow-source-pack/1")
    entry = manifest.get("entry")
    if not isinstance(entry, str) or not entry:
        rep.error("source-pack.json 缺少 entry")
        entry = "config.all.json"
    if manifest.get("primaryRuntime") not in (None, "dex"):
        rep.error("source-pack.json primaryRuntime 必须是 dex")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        rep.error("source-pack.json 缺少 artifacts 数组")
        artifacts = []
    for i, a in enumerate(artifacts):
        if not isinstance(a, dict):
            rep.error(f"source-pack.json artifacts[{i}] 不是对象")
            continue
        name = a.get("name")
        if not name:
            rep.error(f"source-pack.json artifacts[{i}] 缺少 name")
            continue
        p = root / name
        if not p.is_file():
            rep.error(f"artifact 不存在：{name}")
            continue
        if a.get("bytes") is not None and int(a["bytes"]) != p.stat().st_size:
            rep.error(f"artifact 大小不符：{name}")
        if a.get("sha256"):
            actual = sha256_file(p)
            if actual.lower() != str(a["sha256"]).lower():
                rep.error(f"artifact sha256 不符：{name}")
        if a.get("md5"):
            actual = md5_file(p)
            if actual.lower() != str(a["md5"]).lower():
                rep.error(f"artifact md5 不符：{name}")
        print(f"[OK]   artifact: {name}")
    profiles = manifest.get("profiles")
    if isinstance(profiles, dict):
        for name, p in profiles.items():
            if isinstance(p, dict):
                cfg = p.get("config")
                if cfg and not (root / cfg).is_file():
                    rep.error(f"profile {name} 的 config 不存在：{cfg}")
    return entry


def check_sums(root: Path, rep: Report) -> None:
    p = root / "SHA256SUMS.txt"
    if not p.is_file():
        rep.warn("没有 SHA256SUMS.txt（建议生成）")
        return
    for lineno, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or not HEX_RE.match(parts[0]):
            rep.warn(f"SHA256SUMS.txt 第 {lineno} 行格式不对，跳过")
            continue
        digest, name = parts[0], parts[1].lstrip("*").strip()
        f = root / name
        if not f.is_file():
            rep.error(f"SHA256SUMS.txt 里的文件不存在：{name}")
            continue
        actual = sha256_file(f)
        if actual.lower() != digest.lower():
            rep.error(f"SHA256SUMS.txt 校验失败：{name}")
    print("[OK]   SHA256SUMS.txt")


def check_config(
    cfg: dict,
    root: Path,
    base_url: str,
    rep: Report,
    label: str,
    entry_profile: str,
    spider_want: str = "dex",
    site_want: str = "dex",
) -> None:
    spider = cfg.get("spider")
    if not spider:
        rep.error(f"{label} 缺少顶层 spider")
    else:
        check_jar_url(spider, f"{label}.spider", spider_want, root, base_url, rep)

    spider_jvm = cfg.get("spiderJvm")
    if spider_jvm:
        check_jar_url(spider_jvm, f"{label}.spiderJvm", "class", root, base_url, rep)

    sites = cfg.get("sites")
    if not isinstance(sites, list) or not sites:
        rep.error(f"{label} 缺少非空 sites 数组")
        return
    keys: set[str] = set()
    for i, s in enumerate(sites):
        if not isinstance(s, dict):
            rep.error(f"{label}.sites[{i}] 不是对象")
            continue
        key = str(s.get("key", "")).strip()
        api = str(s.get("api", "")).strip()
        if not key:
            rep.error(f"{label}.sites[{i}] 缺少 key")
        elif key in keys:
            rep.error(f"{label}.sites key 重复：{key}")
        else:
            keys.add(key)
        if not api:
            rep.error(f"{label}.sites[{i}]（{key or '?'}）缺少 api")
        if not str(s.get("name", "")).strip():
            rep.warn(f"{label}.sites[{i}]（{key or '?'}）缺少 name")
        jar = s.get("jar")
        if jar:
            check_jar_url(jar, f"{label}.sites[{i}].jar({key})", site_want, root, base_url, rep)

    proxy = cfg.get("proxy")
    if isinstance(proxy, list) and proxy and all(isinstance(x, str) for x in proxy):
        rep.warn(f"{label}.proxy 是猫窝字符串数组；Fongmi 期望对象数组，会忽略（不影响 dex 导入）")

    if entry_profile == "all":
        print(f"[OK]   {label}: {len(sites)} 站，spider={'ok' if spider else 'missing'}")


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 meow-source-pack/1 源包")
    ap.add_argument("--dir", default=".", help="源包目录")
    ap.add_argument("--base-url", default="", help="源包对外基址，例如 http://host:18080")
    ap.add_argument("--manifest", default="source-pack.json")
    ap.add_argument("--entry", default="", help="覆盖 manifest 里的 entry")
    ap.add_argument("--no-require-md5", action="store_true", help="允许 jar URL 不带 ;md5;（不推荐）")
    args = ap.parse_args()

    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(f"目录不存在：{root}")
        return 1
    rep = Report()

    manifest = load_json(root / args.manifest, args.manifest, rep)
    entry = args.entry
    if manifest is not None:
        entry = entry or check_manifest(manifest, root, rep)
    elif not entry:
        entry = "config.all.json"

    cfg = load_json(root / entry, entry, rep)
    if cfg is not None:
        check_config(cfg, root, args.base_url, rep, entry, "all")
        # 兼容 profile：存在就做基本检查，但不强制
        for name, want in (("config.jvm.json", "class"), ("config.tv.json", "dex")):
            if (root / name).is_file():
                pc = load_json(root / name, name, rep)
                if pc is not None:
                    check_config(pc, root, args.base_url, rep, name, "profile",
                                 spider_want=want, site_want=want)
                    rep.warn(f"{name} 是兼容 profile；新部署建议只维护 {entry}")

    check_sums(root, rep)
    return rep.dump()


if __name__ == "__main__":
    raise SystemExit(main())
