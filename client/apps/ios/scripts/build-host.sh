#!/usr/bin/env bash
# 编译 iOS 端内 Java 宿主（ApiServer + 路由 + 原生源）。
#
# 与 PC/Docker 的 build.bat 差异只有两点：
#   1. --release 9：端上跑的是预编译的 OpenJDK 9 Zero，不能吃 17 的字节码；
#   2. 排除 Dex2Jvm（它靠 ProcessBuilder 调 dex2jar，iOS 没有 fork/exec），
#      换成 host-stub 里的同签名桩；dex 形态的源包在上游转好再导入。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
OUT="$ROOT/client/apps/ios/build/jvm"
SRC_LIST="$OUT/sources.txt"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/libs"

find "$ROOT/server/host/src" -name '*.java' \
  ! -path '*/shared/core/Dex2Jvm.java' > "$SRC_LIST"
echo "$ROOT/client/apps/ios/host-stub/shared/core/Dex2Jvm.java" >> "$SRC_LIST"

# JDK 9 的 javac 在旧 macOS 上也能跑；CI 用 Temurin 17/21 的 --release 9。
javac --release 9 -encoding UTF-8 \
  -cp "$ROOT/server/host/libs/*" \
  -d "$OUT/classes" @"$SRC_LIST"

jar --create --file "$OUT/host.jar" -C "$OUT/classes" .

# 宿主依赖的公开 jar 一起进包：okhttp/okio/gson/android-json/bcprov/smbj...
cp "$ROOT"/server/host/libs/*.jar "$OUT/libs/"

# 首次启动的空配置（0 站）；用户从设置页导入源包后覆盖。
mkdir -p "$ROOT/client/apps/ios/build"
cp "$ROOT/server/host/config.sites.example.json" \
   "$ROOT/client/apps/ios/build/config.sites.example.json"

echo "[ios-host] host.jar + $(ls "$OUT/libs" | wc -l | tr -d ' ') libs -> $OUT"
