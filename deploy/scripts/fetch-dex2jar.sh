#!/usr/bin/env bash
# 下载并解压 dex2jar（固定版本 + SHA256）。构建插件/fpk 前调用。
#
#   bash deploy/scripts/fetch-dex2jar.sh
#   bash deploy/scripts/fetch-dex2jar.sh server/tools/dex2jar
#
# 产物不提交 git（server/tools/ 已忽略）；构建时按需拉取。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${1:-$ROOT/server/tools/dex2jar}"
VERSION="${DEX2JAR_VERSION:-2.4}"
URL="https://github.com/pxb1988/dex2jar/releases/download/v${VERSION}/dex-tools-v${VERSION}.zip"
SHA="ee7c45eb3c1d2474a6145d8d447e651a736a22d9664b6d3d3be5a5a817dda23a"

if [ -d "$DEST/lib" ] && ls "$DEST"/lib/dex-tools-*.jar >/dev/null 2>&1; then
  echo "dex2jar 已存在：$DEST"
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
echo "dex2jar 已安装：$DEST"
