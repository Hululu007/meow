#!/usr/bin/env bash
# 准备 iOS 端内 CPython 运行时（Python 3.12，beeware Python-Apple-support）。
#
# 产物（不进 git，CI 缓存 + 打进 App）：
#   client/apps/ios/build/python/Python.framework/      ← 动态库（arm64 device）
#   client/apps/ios/build/python/include/python3.12/    ← 编译扩展用（目前只给 C 桥）
#   client/apps/ios/build/python/runtime/lib/python3.12/ ← 裁剪后的标准库 + lib-dynload + site-packages
#   client/apps/ios/build/python/runtime/pyrt.py        ← 源运行时入口
#
# 裁剪原则（2026-11-26，包体优先）：
#   - 标准库去掉 test/idlelib/tkinter/ensurepip/lib2to3/venv/turtledemo/pydoc_data（约 -30MB 原始）
#   - lib-dynload 去掉测试/桌面/无用模块，保留 ssl/hashlib/codecs/压缩/XML/结构化数据
#   - 第三方只带 requests/bs4（纯 Python wheel）；AES/Hash 用 python-shim 的纯 Python 实现
#
# 用法：bash client/apps/ios/scripts/prepare-python-payload.sh
# 环境变量：PYTHON_IOS_URL 可覆盖下载地址（镜像/离线缓存）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build"
PV="3.12"
PB="b13"
URL="${PYTHON_IOS_URL:-https://github.com/beeware/Python-Apple-support/releases/download/${PV}-${PB}/Python-${PV}-iOS-support.${PB}.tar.gz}"

CACHE="$BUILD/pycache"
TAR="$CACHE/python-${PV}-${PB}.tar.gz"
STAGE="$CACHE/stage"
OUT="$BUILD/python"
RT="$OUT/runtime"

PY3="python3"
command -v "$PY3" >/dev/null 2>&1 || PY3="python"

mkdir -p "$CACHE"
if [ ! -s "$TAR" ]; then
  echo "[py] downloading $URL"
  curl -fL --retry 4 --retry-all-errors -o "$TAR.part" "$URL"
  mv "$TAR.part" "$TAR"
fi
echo "[py] archive $(du -h "$TAR" | cut -f1)"

echo "[py] extracting"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE" "$OUT" "$RT"
tar xzf "$TAR" -C "$STAGE" \
  "Python.xcframework/ios-arm64/Python.framework" \
  "Python.xcframework/ios-arm64/include" \
  "Python.xcframework/lib/python3.12" \
  "Python.xcframework/ios-arm64/lib-arm64/python3.12/lib-dynload"

echo "[py] assembling framework"
cp -R "$STAGE/Python.xcframework/ios-arm64/Python.framework" "$OUT/Python.framework"
cp -R "$STAGE/Python.xcframework/ios-arm64/include" "$OUT/include"

STDLIB="$RT/lib/python${PV}"
mkdir -p "$STDLIB"
cp -R "$STAGE/Python.xcframework/lib/python3.12/." "$STDLIB/"
# sysconfig 需要这份构建参数表（原始在 lib-arm64，不在共享 lib 里）
cp "$STAGE"/Python.xcframework/ios-arm64/lib-arm64/python3.12/_sysconfigdata*.py "$STDLIB/" 2>/dev/null || true

# 去掉标准库里的大块无关项（保留 json/http/urllib/email/ssl/asyncio/concurrent）
for d in test idlelib tkinter turtledemo ensurepip lib2to3 pydoc_data venv unittest; do
  rm -rf "$STDLIB/$d"
done
rm -f "$STDLIB/turtle.py" "$STDLIB/antigravity.py" "$STDLIB/this.py"

# 扩展模块（C .so）：**不能**放在 resources 里 —— 侧载器只给 Frameworks 递归签名，
# 资源目录里的 Mach-O 会因无签名无法 dlopen。这里单独放 build/python/pyext，
# project.yml 用 copyFiles(destination: frameworks) 拷进 App.app/Frameworks/pyext，
# PythonRuntime 再把它加进 PYTHONPATH。
DYN="$OUT/pyext"
mkdir -p "$DYN"
cp -R "$STAGE/Python.xcframework/ios-arm64/lib-arm64/python3.12/lib-dynload/." "$DYN/"
find "$DYN" -type f \( \
  -name '_test*' -o -name 'xx*' -o -name '_ctypes_test*' -o -name '_xxtestfuzz*' \
  -o -name 'audioop*' -o -name 'sunau*' -o -name 'ossaudiodev*' -o -name 'nis*' \
  -o -name 'spwd*' -o -name 'crypt*' -o -name '_curses*' -o -name 'readline*' \
  -o -name '_dbm*' -o -name '_gdbm*' -o -name '_tkinter*' -o -name '_scproxy*' \
  -o -name '_sqlite3*' \) -delete

echo "[py] vendoring pure-python deps"
WHEELS="$CACHE/wheels"
mkdir -p "$WHEELS"
"$PY3" -m pip download --quiet --disable-pip-version-check \
  --only-binary=:all: --no-deps \
  --platform any --python-version "$PV" --implementation py --abi none \
  -d "$WHEELS" \
  requests urllib3 certifi idna charset-normalizer beautifulsoup4 soupsieve
SITE="$STDLIB/site-packages"
mkdir -p "$SITE"
"$PY3" - "$WHEELS" "$SITE" <<'PY'
import sys, zipfile, pathlib
wheels, site = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for w in sorted(wheels.glob('*.whl')):
    with zipfile.ZipFile(w) as z:
        z.extractall(site)
    print('[py] +', w.name)
PY
# 纯 Python 的 Crypto 兼容层（AES/Hash）覆盖 pycryptodome 的常用子集
cp -R "$ROOT/python-shim/Crypto" "$SITE/Crypto"
# cryptography 兼容层（19 个源里的 16 个只用 AES-CBC/Fernet，见 shim 注释）
cp -R "$ROOT/python-shim/cryptography" "$SITE/cryptography"
# pyaes 只有 sdist（pip 只取 wheel 装不到），源码直接 vendor（1.6.1，MIT）
cp -R "$ROOT/python-shim/pyaes" "$SITE/pyaes"
# host 上跑过 shim 自测会留 3.10 的 pycache，带进 3.12 只会占体积/干扰排查
find "$SITE" -name __pycache__ -type d -prune -exec rm -rf {} +

cp "$ROOT/../../../server/pyrt/pyrt.py" "$RT/pyrt.py"
# 版本标记：App 按它判断要不要重拷（运行时本身在 bundle，主要给日志/自检）
echo "${PV}-${PB}-1" > "$OUT/.payload-version"

echo "[py] sizes:"
du -sh "$OUT/Python.framework" "$OUT/pyext" "$RT/lib/python${PV}" "$RT/pyrt.py" | sed 's/^/[py]   /'
du -sh "$OUT" | sed 's/^/[py] total /'
[ -f "$RT/pyrt.py" ] || { echo "[py] pyrt.py missing" >&2; exit 1; }
[ -d "$STDLIB/encodings" ] || { echo "[py] stdlib missing" >&2; exit 1; }
[ -f "$OUT/pyext/_ssl.cpython-312-iphoneos.so" ] || { echo "[py] _ssl missing" >&2; exit 1; }
echo "[py] ok"
