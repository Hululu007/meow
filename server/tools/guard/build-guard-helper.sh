#!/bin/sh
# 编译加密 Guard 子进程（unidbg + dex2jar + 字节码修复），产物进 guard-libs/。
set -e
cd "$(dirname "$0")"
LIBS="$(cd ../../host/guard-libs && pwd)"
rm -rf build/classes
mkdir -p build/classes
javac -encoding UTF-8 -cp "$LIBS/*" -d build/classes $(find src -name '*.java')
jar cf "$LIBS/guard-helper.jar" -C build/classes .
echo "[guard] helper -> $LIBS/guard-helper.jar"
