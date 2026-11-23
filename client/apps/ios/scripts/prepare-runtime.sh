#!/usr/bin/env bash
# 准备 iOS 端内运行环境：
#   1. 下载预编译的 OpenJDK 9 Zero for iOS arm64（Oct4Pie/lib-openjdk-9-ios）；
#   2. 20 个静态库合并成 libOpenJDK.a（-all_load 链进主程序）；
#   3. 裁掉 jmods/include/demo/.a，只留 lib/modules + conf + security + tzdb；
#   4. 换掉包里 32 字节的占位 cacerts（换成构建机的真实信任库）；
#   5. 把 web/dist 拷成 App 资源。
#
# 只在 macOS + Xcode 命令行工具下运行（libtool / xcrun / java_home）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
OUT="$ROOT/client/apps/ios/build"
CACHE="$OUT/cache"
mkdir -p "$CACHE"

JDK_URL="https://github.com/Oct4Pie/lib-openjdk-9-ios/releases/download/v1.0-lib/lib-openjdk-9_ios-arm64_bundle.tar.gz"
FFI_URL="https://github.com/Oct4Pie/lib-openjdk-9-ios/releases/download/v1.0-lib/libffi-3.3_ios-arm64_bundle.tar.gz"
JDK_TAR="$CACHE/openjdk9-ios.tar.gz"
FFI_TAR="$CACHE/libffi-ios.tar.gz"

command -v xcrun >/dev/null || { echo "[ios-runtime] 需要 macOS + Xcode 命令行工具" >&2; exit 2; }
command -v libtool >/dev/null || { echo "[ios-runtime] 需要 libtool（Xcode CLT）" >&2; exit 2; }

[ -f "$JDK_TAR" ] || curl -fL --retry 3 --retry-delay 3 -o "$JDK_TAR" "$JDK_URL"
[ -f "$FFI_TAR" ] || curl -fL --retry 3 --retry-delay 3 -o "$FFI_TAR" "$FFI_URL"

rm -rf "$OUT/tmp" "$CACHE/tree" "$CACHE/ffi"
mkdir -p "$OUT/tmp/tree" "$OUT/tmp/ffi"
tar xzf "$JDK_TAR" -C "$OUT/tmp/tree"
tar xzf "$FFI_TAR" -C "$OUT/tmp/ffi"

SRC="$(find "$OUT/tmp/tree" -maxdepth 6 -type d -name 'openjdk-9-internal' | sed -n '1p')"
[ -n "$SRC" ] || { echo "[ios-runtime] 压缩包里找不到 openjdk-9-internal" >&2; exit 2; }
LIBFFI="$(find "$OUT/tmp/ffi" -type f -name 'libffi.a' | sed -n '1p')"

LIBS=(
  "$SRC/lib/server/libjvm.a"
  "$SRC/lib/libjava.a"
  "$SRC/lib/libnet.a"
  "$SRC/lib/libnio.a"
  "$SRC/lib/libjimage.a"
  "$SRC/lib/libzip.a"
  "$SRC/lib/libverify.a"
  "$SRC/lib/libsunec.a"
  "$SRC/lib/libjaas_unix.a"
  "$SRC/lib/libj2gss.a"
  "$SRC/lib/libmanagement.a"
  "$SRC/lib/librmi.a"
)
[ -f "$SRC/lib/libfreetype.a.6" ] && LIBS+=("$SRC/lib/libfreetype.a.6")
[ -n "$LIBFFI" ] && LIBS+=("$LIBFFI")

for f in "${LIBS[@]}"; do
  [ -f "$f" ] || { echo "[ios-runtime] 缺静态库: $f" >&2; exit 2; }
done

rm -f "$OUT/libOpenJDK.a"
# _all_load 需要一个自包含的归档；-static 会合并符号表。
libtool -static -o "$OUT/libOpenJDK.a" "${LIBS[@]}"
[ -s "$OUT/libOpenJDK.a" ] || { echo "[ios-runtime] libOpenJDK.a 生成失败" >&2; exit 2; }

JHOME="$OUT/openjdk"
rm -rf "$JHOME"
mkdir -p "$JHOME"
cp -R "$SRC/lib" "$JHOME/lib"
cp -R "$SRC/conf" "$JHOME/conf"
cp "$SRC/release" "$JHOME/release" 2>/dev/null || true
[ -d "$SRC/legal" ] && cp -R "$SRC/legal" "$JHOME/legal"

# jni.h 给 ObjC++ 桥用；不进 App 资源。
rm -rf "$OUT/jni"
mkdir -p "$OUT/jni"
cp -R "$SRC/include" "$OUT/jni/include"

# 运行期只需要 modules/conf/security/tzdb；静态库已经并进主程序。
find "$JHOME/lib" -name '*.a' -delete
find "$JHOME/lib" -name '*.a.*' -delete
find "$JHOME/lib" -name '*.symbols' -delete
rm -rf "$JHOME/lib/server" "$JHOME/lib/jli" "$JHOME/lib/ct.sym" \
       "$JHOME/lib/jrt-fs.jar" "$JHOME/jmods" "$JHOME/include" \
       "$JHOME/demo" "$JHOME/man"
find "$JHOME" -name '._*' -delete
find "$JHOME" -name '.DS_Store' -delete

# 包里的 cacerts 是 32 字节占位文件；换构建机的真实信任库（PKCS12/JKS 都能被 JDK9 读）。
CACERTS=""
if [ -n "${JAVA_HOME:-}" ] && [ -s "$JAVA_HOME/lib/security/cacerts" ]; then
  CACERTS="$JAVA_HOME/lib/security/cacerts"
else
  JH="$(/usr/libexec/java_home 2>/dev/null || true)"
  [ -n "$JH" ] && [ -s "$JH/lib/security/cacerts" ] && CACERTS="$JH/lib/security/cacerts"
fi
if [ -n "$CACERTS" ]; then
  cp "$CACERTS" "$JHOME/lib/security/cacerts"
  echo "[ios-runtime] cacerts <- $CACERTS ($(stat -f%z "$JHOME/lib/security/cacerts") bytes)"
else
  echo "[ios-runtime] WARN: 找不到真实 cacerts，HTTPS 会失败" >&2
fi

[ -s "$JHOME/lib/modules" ] || { echo "[ios-runtime] 缺 lib/modules" >&2; exit 2; }

# Web 前端
WEB_SRC="$ROOT/client/apps/web/dist"
[ -f "$WEB_SRC/index.html" ] || {
  echo "[ios-runtime] 缺 $WEB_SRC/index.html；先构建 web（pnpm build）" >&2
  exit 2
}
rm -rf "$OUT/web"
cp -R "$WEB_SRC" "$OUT/web"

du -sh "$OUT/libOpenJDK.a" "$JHOME/lib/modules" "$OUT/web" 2>/dev/null || true
echo "[ios-runtime] ok: $JHOME"
