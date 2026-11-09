#!/bin/bash
# Linux / CI 侧的 apiserver fat jar 构建（等价 build-plugin.ps1 的 [1/5]~[2/5]）。
#
# 为什么单独写：build-plugin.ps1 L45 用 `cmd /c` 重定向 javac 输出，cmd 只在
# Windows 存在。GitHub ubuntu runner 与 fnOS 上跑 ps1 会在第一步就失败。
# 这里只复刻"编译 + 合并依赖 + 打 fat jar"三步；jlink 出来的 jre 与 fpk 无关
# （fpk 用系统 java-21-openjdk，spider.jar 单独挂 classpath）。
#
# 与 ps1 必须保持一致的规则（改动其中一边请同步另一边）：
#   1. 排除 spider.jar：里面有只差大小写的同名类路径，Windows 解压会互相覆盖
#      （详见 ps1 L57-75），而且设计上它就是单独挂 -cp 的。
#   2. 每个依赖解包后立刻删 META-INF/*.SF|*.RSA|*.DSA：bcprov 是签名 jar，
#      只删一次兜底不够，运行时会抛 Invalid signature file digest。
#   3. jar --main-class ApiServer（fpk 的启动参数不写主类，靠这个）。
#
# 用法：
#   bash server/build-plugin-linux.sh
#   OUT=/tmp/x bash server/build-plugin-linux.sh   # 产物落到别处
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$ROOT/build/plugins/apiserver}"
TMP="$ROOT/build/.tmp/plugin-build-linux"

command -v javac >/dev/null || { echo "缺少 javac（需要 JDK 17）" >&2; exit 1; }
command -v jar   >/dev/null || { echo "缺少 jar（需要 JDK 17）" >&2; exit 1; }

rm -rf "$TMP"
mkdir -p "$TMP/classes" "$OUT"

echo "[1/2] javac"
mapfile -t SOURCES < <(find "$ROOT/host/src" -name '*.java' | sort)
echo "  源文件: ${#SOURCES[@]} 个"
javac -encoding UTF-8 -cp "$ROOT/host/libs/*" -d "$TMP/classes" "${SOURCES[@]}"

echo "[2/2] fat jar"
for dep in "$ROOT"/host/libs/*.jar; do
    name="$(basename "$dep")"
    [ "$name" = "spider.jar" ] && continue
    d="$TMP/dep-$name"
    mkdir -p "$d"
    (
        cd "$d"
        jar xf "$dep"
        rm -f META-INF/*.SF META-INF/*.RSA META-INF/*.DSA
    )
    cp -r "$d/." "$TMP/classes/"
done
rm -f "$TMP/classes/META-INF/"*.SF "$TMP/classes/META-INF/"*.RSA "$TMP/classes/META-INF/"*.DSA

(
    cd "$TMP/classes"
    jar --create --file "$OUT/apiserver.jar" --main-class ApiServer .
)

ls -lh "$OUT/apiserver.jar"
