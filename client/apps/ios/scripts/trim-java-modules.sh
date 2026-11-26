#!/usr/bin/env bash
# 生成裁减后的 iOS OpenJDK `lib/modules`（Phase 1：只删工具链/CORBA/WS/JAXB）。
#
# 背景：iOS 包里的 openjdk/lib/modules 压缩后 44MB，占整包 44%。Phase 1 只删
# 运行期绝不使用的模块，实测 133.35MB -> 90.84MB（zip 43.97 -> 33.24MB，
# IPA 100.1 -> 88.3MB）。Phase 2（java.desktop/jdk.localedata/nashorn）风险另评估，
# 不要直接加进这里的 REMOVE。
#
# 用法：
#   trim-java-modules.sh <openjdk-9-ios bundle.tar.gz> <jlink-9 可执行> <输出 modules 路径>
#
# 要求：jlink/jimage 必须是 **JDK 9**（JDK 17 会报 “版本 17.0 与目标 9.0 不匹配”）。
# 输出只写 <输出>，不改 bundle；恢复原版 = 重新跑 prepare-runtime.sh 或重装完整 IPA。
set -euo pipefail

TAR="${1:?用法: trim-java-modules.sh <bundle.tar.gz> <jlink9> <out/modules>}"
JLINK="${2:?缺少 jlink 路径}"
OUT="${3:?缺少输出 modules 路径}"

# Phase 1 白名单式删除：工具链、CORBA、JAX-WS/JAXB、SE 聚合模块（聚合会把这些
# 依赖重新拉回来，必须一起删）。不要在这里加 java.desktop / jdk.localedata /
# jdk.scripting.nashorn —— 那是 Phase 2，需按 jar 源审计后单独决定。
REMOVE="
jdk.compiler jdk.javadoc jdk.jshell jdk.jdi jdk.jdeps jdk.jlink jdk.jconsole
jdk.rmic jdk.internal.vm.ci java.corba java.xml.ws jdk.xml.ws java.xml.bind
jdk.xml.bind java.se java.se.ee
"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/meow-jlink.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "[trim] 从 bundle 提取 jmods"
python3 - "$TAR" "$WORK/jmods" <<'PY'
import os, sys, tarfile
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
n = 0
with tarfile.open(src, "r:gz") as t:
    for m in t:
        if "/jmods/" in m.name and m.name.endswith(".jmod") and m.isfile():
            m.name = os.path.basename(m.name)
            t.extract(m, dst)
            n += 1
print(f"[trim] jmods {n}")
PY

MODS="$(python3 - "$WORK/jmods" $REMOVE <<'PY'
import os, sys
d, removed = sys.argv[1], set(sys.argv[2:])
mods = sorted(f[:-5] for f in os.listdir(d)
              if f.endswith(".jmod") and f[:-5] not in removed)
print(",".join(mods))
PY
)"
echo "[trim] 保留模块 $(echo "$MODS" | tr ',' '\n' | wc -l | tr -d ' ') 个"

"$JLINK" --module-path "$WORK/jmods" --add-modules "$MODS" \
  --output "$WORK/image" --no-header-files --no-man-pages

# 校验：模块数/关键模块/被删模块都不能还在
JIMAGE="$(dirname "$JLINK")/jimage"
"$JIMAGE" list "$WORK/image/lib/modules" 2>/dev/null \
  | grep '^Module: ' | sed 's/Module: //' > "$WORK/mods.txt"
for m in java.base java.logging java.xml java.security.jgss jdk.httpserver \
         java.sql java.naming java.scripting java.desktop jdk.localedata \
         jdk.crypto.ec jdk.charsets jdk.zipfs jdk.unsupported; do
  grep -qx "$m" "$WORK/mods.txt" || { echo "[trim] 缺关键模块 $m" >&2; exit 1; }
done
for m in $REMOVE; do
  grep -qx "$m" "$WORK/mods.txt" && { echo "[trim] 被删模块又回来了: $m" >&2; exit 1; }
done
echo "[trim] 模块 $(wc -l < "$WORK/mods.txt") 个，体积："
ls -lh "$WORK/image/lib/modules" | awk '{print "[trim]   raw " $5}'

mkdir -p "$(dirname "$OUT")"
cp "$WORK/image/lib/modules" "$OUT"
echo "[trim] 写入 $OUT"
