#!/usr/bin/env bash
# 下载并解压 dex2jar（固定版本 + SHA256），然后裁到「Dex2jarCmd 实际可达」的 13 个 jar。
#
#   bash deploy/scripts/fetch-dex2jar.sh
#   bash deploy/scripts/fetch-dex2jar.sh server/tools/dex2jar
#
# 产物不提交 git（server/tools/ 已忽略）；构建时按需拉取。
#
# ## 为什么要裁
#
# 上游 dex-tools 发布包把**整套工具链**打在一起：ANTLR4 生成器（2.5MB）、它依赖的
# icu4j（12.7MB）、ANTLR3 工具（1.1MB）、ST4、dx，以及另外几个转换方向的命令
# （jasmin / smali / dex-writer）。宿主只调用 `Dex2jarCmd`（dex→jar），这些全是死的：
# 整包 19.7MB，裁后 1.5MB —— 直接决定 fpk / PC 插件 / Docker 镜像各少 18MB
# （2026-11-16 实测：1.1.6→1.1.7 的 +18MB 增长全部来自这里）。
#
# 判据不是"包体要小于某个数"，而是**可达性**：
#   · `Dex2jarCmd.class` 对被裁包零引用（常量池扫描）
#   · 3 个真实 dex 用裁剪后的 lib 转换成功，产物 884 个 class 与全量一致
#   · 保留 asm-analysis / asm-util / antlr-runtime 三个"可能被间接引用"的作保险
#
# ★ 升级 dex2jar 版本必须重新核对白名单：这里的 jar 名带版本号（-v2.4），对不上会在
#   下面的断言里直接失败，不会静默打成残缺包。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$ROOT/server/tools/dex2jar}"
VERSION="${DEX2JAR_VERSION:-2.4}"
URL="https://github.com/pxb1988/dex2jar/releases/download/v${VERSION}/dex-tools-v${VERSION}.zip"
SHA="ee7c45eb3c1d2474a6145d8d447e651a736a22d9664b6d3d3be5a5a817dda23a"

# 白名单：dex→jar 转换必需 + 3 个保险。改这里必须同步：
#   · deploy/scripts/fetch-dex2jar.ps1
#   · deploy/docker/Dockerfile.apiserver
#   · client/apps/fnos/build-fpk.sh 的 jar 数断言（13）
KEEP_JARS="antlr-runtime-3.5.2.jar
antlr4-runtime-4.9.3.jar
asm-9.5.jar
asm-analysis-9.5.jar
asm-commons-9.5.jar
asm-tree-9.5.jar
asm-util-9.5.jar
d2j-base-cmd-v2.4.jar
dex-ir-v2.4.jar
dex-reader-api-v2.4.jar
dex-reader-v2.4.jar
dex-tools-v2.4.jar
dex-translator-v2.4.jar"
# ★ Windows 克隆（core.autocrlf=true）里本文件是 CRLF，上面的多行字符串会带上 \r，
#   导致匹配永远不命中、把白名单全删光。实测踩过，必须剥掉。
KEEP_JARS="${KEEP_JARS//$'\r'/}"

# ★ 用 grep -Fx 而不是 case：Git Bash 上 `case 多行字符串 in *" $b "*)` 实测失配
#   （单行能中、多行不中），换成逐行精确匹配最稳，Linux/Windows 行为一致。
is_kept() { printf '%s\n' "$KEEP_JARS" | grep -Fx -- "$1" >/dev/null; }

# 裁剪 + 自检。已存在的目录也会走一遍（幂等）：老的完整包会被自动瘦身。
prune_lib() {
  local lib="$1"
  local f b removed=0 keep_n=0 miss=""

  for f in "$lib"/*.jar; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    if is_kept "$b"; then
      :
    else
      rm -f "$f"
      removed=$((removed + 1))
    fi
  done

  for b in $KEEP_JARS; do
    if [ -f "$lib/$b" ]; then
      keep_n=$((keep_n + 1))
    else
      miss="$miss $b"
    fi
  done
  if [ -n "$miss" ]; then
    echo "dex2jar 缺少白名单里的 jar:$miss" >&2
    echo "（升级了 dex2jar 版本？请重新核对 KEEP_JARS）" >&2
    return 1
  fi
  echo "dex2jar 裁剪完成：保留 $keep_n 个 jar，删除 $removed 个（lib $(du -sh "$lib" | cut -f1)）"
}

if [ -d "$DEST/lib" ] && ls "$DEST"/lib/dex-tools-*.jar >/dev/null 2>&1; then
  echo "dex2jar 已存在：$DEST（只做裁剪校验）"
  prune_lib "$DEST/lib"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "下载 dex2jar v$VERSION ..."
curl -fsSL --max-time 180 -o "$tmp/dex-tools.zip" "$URL"
echo "$SHA  $tmp/dex-tools.zip" | sha256sum -c -
unzip -q "$tmp/dex-tools.zip" -d "$tmp"
src="$tmp/dex-tools-v$VERSION"
[ -d "$src" ] || { echo "解压后找不到 $src" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -a "$src" "$DEST"
prune_lib "$DEST/lib"
echo "dex2jar 已安装：$DEST"
