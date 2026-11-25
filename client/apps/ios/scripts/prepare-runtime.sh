#!/usr/bin/env bash
# 准备 iOS 端内运行环境：
#   1. 下载预编译的 OpenJDK 9 Zero for iOS arm64（Oct4Pie/lib-openjdk-9-ios）；
#   2. 20 个静态库合并成 libOpenJDK.a（-all_load 链进主程序）；
#   3. 裁掉 jmods/include/demo/src.zip/.a，只留 lib/modules + conf + security + tzdb；
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
FFI_OBJS=($(find "$OUT/tmp/ffi" -type f -name '*.o' | sort))
[ ${#FFI_OBJS[@]} -gt 0 ] && LIBS+=("${FFI_OBJS[@]}")

for f in "${LIBS[@]}"; do
  [ -f "$f" ] || { echo "[ios-runtime] 缺静态库: $f" >&2; exit 2; }
done

rm -f "$OUT/libOpenJDK.a"
# _all_load 需要一个自包含的归档；-static 会合并符号表。
libtool -static -o "$OUT/libOpenJDK.a" "${LIBS[@]}"
[ -s "$OUT/libOpenJDK.a" ] || { echo "[ios-runtime] libOpenJDK.a 生成失败" >&2; exit 2; }

# ---- 动态库：把 JVM 从主程序里摘出来 ----
#
# ★ 为什么不是静态链进主程序：实测「静态 JVM + 侧载器（LiveContainer）」会在
#   main 之前就死（LaunchLog 一行都没有），而同一个 App 不链 JVM 就能起。
#   改成 dylib：主程序保持很小（和 C 包一样能起），JVM 在启动流程里 dlopen；
#   加载失败也只影响「本地网关」，App 仍能进界面并给出原因。
#
# fdlibm 的 j* 符号必须在 dylib 内解析（原来由主程序的 fdlibm_shim.c 提供，
# 那个文件已经不再编进 App target）。
DYLIB_DIR="$OUT/openjdk-framework"
rm -rf "$DYLIB_DIR"
mkdir -p "$DYLIB_DIR"
xcrun --sdk iphoneos clang -dynamiclib -arch arm64 -miphoneos-version-min=13.0 \
  -Wl,-all_load "$OUT/libOpenJDK.a" \
  "$ROOT/client/apps/ios/Meow/fdlibm_shim.c" \
  -o "$DYLIB_DIR/libOpenJDK.dylib" \
  -lc++ -lz -liconv \
  -framework Foundation -framework Security -framework CoreFoundation
[ -s "$DYLIB_DIR/libOpenJDK.dylib" ] || { echo "[ios-runtime] libOpenJDK.dylib 生成失败" >&2; exit 2; }
echo "[ios-runtime] dylib: $(du -h "$DYLIB_DIR/libOpenJDK.dylib" | cut -f1)"

# 探针 dylib（10 行 C）：用来区分「侧载器能不能 dlopen 任何内嵌动态库」
# 与「只有 OpenJDK 这个 dylib 有问题」。真机日志里先打它。
printf 'int meow_smoke(void){return 42;}
' > "$DYLIB_DIR/smoke.c"
xcrun --sdk iphoneos clang -dynamiclib -arch arm64 -miphoneos-version-min=13.0   -o "$DYLIB_DIR/libmeow-smoke.dylib" "$DYLIB_DIR/smoke.c"
[ -s "$DYLIB_DIR/libmeow-smoke.dylib" ] || { echo "[ios-runtime] libmeow-smoke.dylib 生成失败" >&2; exit 2; }
echo "[ios-runtime] smoke dylib: $(du -h "$DYLIB_DIR/libmeow-smoke.dylib" | cut -f1)"

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
#
# ★ src.zip 必须删（2026-11-25 实测 61,148,651 B，占 IPA 41%）：
#   JDK 源码归档，只有 IDE/javac 查源码会用；运行时类全部在 lib/modules 里，
#   全仓 Swift/Java/脚本没有任何引用。不删等于白带 61MB。
find "$JHOME/lib" -name '*.a' -delete
find "$JHOME/lib" -name '*.a.*' -delete
find "$JHOME/lib" -name '*.symbols' -delete
rm -rf "$JHOME/lib/server" "$JHOME/lib/jli" "$JHOME/lib/ct.sym" \
       "$JHOME/lib/jrt-fs.jar" "$JHOME/lib/src.zip" "$JHOME/jmods" "$JHOME/include" \
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

# XcodeGen 的 resources 里引用它；构建宿主脚本也会写一份，这里保证缓存命中时也存在。
cp "$ROOT/server/host/config.sites.example.json" "$OUT/config.sites.example.json"

du -sh "$OUT/libOpenJDK.a" "$JHOME/lib/modules" "$OUT/web" 2>/dev/null || true
echo "[ios-runtime] ok: $JHOME"
