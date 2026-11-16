#!/usr/bin/env bash
# dex2jar 冒烟：用仓库夹具跑一遍 Dex2jarCmd，确认裁剪后的 lib 还能真正转换。
#
#   bash deploy/scripts/smoke-dex2jar.sh
#
# 为什么要有：dex2jar 的 lib 被裁到 13 个 jar（见 fetch-dex2jar.sh 顶部注释）。
# 裁剪判据是"可达性"，但可达性是静态判断——这里用真实 dex 跑一遍兜底：
# 少一个运行期真正需要的 jar，症状是 ClassNotFoundException/NoClassDefFoundError，
# 而 fpk 里要等用户导入源包时才炸，属于最难定位的一类故障。
#
# 加夹具：把任意含 classes.dex 的 jar 放进 server/host/test-fixtures/dex/ 即可，
# 本脚本按 *.jar 全跑（夹具要小，别把几 MB 的站包塞进仓库）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
D2J="${DEX2JAR_DIR:-$ROOT/server/tools/dex2jar}"
FIX="$ROOT/server/host/test-fixtures/dex"

command -v java >/dev/null || { echo "缺少 java（JDK 17+）" >&2; exit 1; }

# 幂等：已存在时只做裁剪校验，不会重复下载
bash "$ROOT/deploy/scripts/fetch-dex2jar.sh" "$D2J" >/dev/null

[ -d "$FIX" ] || { echo "缺少夹具目录 $FIX" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Windows 的 java 不认 Git Bash 的 /p/... 形态路径。有 cygpath 就转成原生路径；
# CI（Linux）没有 cygpath，保持原样。
CP="$D2J/lib/*"
if command -v cygpath >/dev/null 2>&1; then
  CP="$(cygpath -w "$D2J/lib")/*"
fi

n=0
for f in "$FIX"/*.jar; do
  [ -e "$f" ] || continue
  name="$(basename "$f" .jar)"
  cp "$f" "$tmp/$name.in.jar"
  # 与 Dex2Jvm 的调用方式保持一致（-f -o，Dex2jarCmd）。
  # 在 $tmp 里用相对路径跑，顺带避开输入/输出路径的平台差异。
  ( cd "$tmp" && java -Xmx256m -cp "$CP" com.googlecode.dex2jar.tools.Dex2jarCmd \
      -f -o "$name.classes.jar" "$name.in.jar" >/dev/null )
  out="$tmp/$name.classes.jar"
  [ -s "$out" ] || { echo "$name: 没有产出文件" >&2; exit 1; }
  cnt="$(unzip -l "$out" | grep -c '\.class$' || true)"
  [ "${cnt:-0}" -gt 0 ] || { echo "$name: 转换后没有 class（lib 可能缺 jar）" >&2; exit 1; }
  echo "  $name -> $cnt 个 class"
  n=$((n + 1))
done

[ "$n" -gt 0 ] || { echo "夹具目录里没有 .jar：$FIX" >&2; exit 1; }
echo "dex2jar 冒烟通过（$n 个夹具，lib: $(ls "$D2J"/lib/*.jar | wc -l) 个 jar）"
