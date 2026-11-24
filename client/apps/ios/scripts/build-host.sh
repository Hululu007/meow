#!/usr/bin/env bash
# 编译 iOS 端内 Java 宿主（ApiServer + 路由 + 原生源）。
#
# 与 PC/Docker 的 build.bat 差异：
#   1. --release 9：端上跑的是预编译的 OpenJDK 9 Zero，不能吃 17 的字节码；
#   2. dex→class 用端内库（host-stub 的 Dex2JvmInProcess）：iOS 没有 fork/exec，
#      运行时靠 -Dmeow.dex2jar.inprocess=true 生效；vendor/dex2jar 随包进 jvm/libs。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
# 进包的只有 host.jar + libs/；中间产物（class 文件、源码清单）放 jvm-build/，
# 不进 App 包 —— 少几百个文件，签名/安装环节少一份不确定性。
OUT="$ROOT/client/apps/ios/build/jvm"
WORK="$ROOT/client/apps/ios/build/jvm-build"
SRC_LIST="$WORK/sources.txt"

rm -rf "$OUT" "$WORK"
mkdir -p "$OUT/libs" "$WORK/classes"

find "$ROOT/server/host/src" -name '*.java' > "$SRC_LIST"
echo "$ROOT/client/apps/ios/host-stub/shared/core/Dex2JvmInProcess.java" >> "$SRC_LIST"

# Git Bash 下 javac/jar 是 Windows 程序：分隔符是 ';'，且路径必须是原生形态。
case "$(uname -s)" in
  MSYS*|MINGW*|CYGWIN*) CP_SEP=';'; NATIVE_PATH=1 ;;
  *) CP_SEP=':'; NATIVE_PATH=0 ;;
esac
native() { if [ "$NATIVE_PATH" = 1 ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
if [ "$NATIVE_PATH" = 1 ]; then
  find "$ROOT/server/host/src" -name '*.java' | while IFS= read -r f; do
    cygpath -w "$f"
  done > "$SRC_LIST"
  echo "$(cygpath -w "$ROOT/client/apps/ios/host-stub/shared/core/Dex2JvmInProcess.java")" >> "$SRC_LIST"
fi

# JDK 9 的 javac 在旧 macOS 上也能跑；CI 用 Temurin 17/21 的 --release 9。
javac --release 9 -encoding UTF-8 \
  -cp "$(native "$ROOT/server/host/libs")/*${CP_SEP}$(native "$ROOT/client/apps/ios/vendor/dex2jar")/*" \
  -d "$(native "$WORK/classes")" @"$(native "$SRC_LIST")"

jar --create --file "$(native "$OUT/host.jar")" -C "$(native "$WORK/classes")" .

# 宿主依赖的公开 jar 一起进包：okhttp/okio/gson/android-json/bcprov/smbj...
cp "$ROOT"/server/host/libs/*.jar "$OUT/libs/"
# 端内 dex2jar（1.1MB 子集）是 Dex2JvmInProcess 的运行时依赖。
cp "$ROOT"/client/apps/ios/vendor/dex2jar/*.jar "$OUT/libs/"

# 首次启动的空配置（0 站）；用户从设置页导入源包后覆盖。
mkdir -p "$ROOT/client/apps/ios/build"
cp "$ROOT/server/host/config.sites.example.json" \
   "$ROOT/client/apps/ios/build/config.sites.example.json"

echo "[ios-host] host.jar + $(ls "$OUT/libs" | wc -l | tr -d ' ') libs -> $OUT"
