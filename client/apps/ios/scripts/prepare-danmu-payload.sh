#!/usr/bin/env bash
# 准备 iOS 端内弹幕载荷（danmu_api）。
#
# 为什么用发布出来的 zip：TV / PC 用的就是同一个包（`danmu-api-1.0.0.zip`），
# 里面是已经裁过的运行期文件（~12MB 压缩 / ~40MB 解开）。直接打进 IPA，
# 首次启动拷到 Documents 就能跑 —— iOS 没有 fork/exec，也不能在沙盒外写文件，
# 但「读包里只读目录 → 拷到容器」这条是允许的。
#
# 产物：
#   client/apps/ios/build/danmu-api/           ← 解开的载荷（含 node_modules）
#   client/apps/ios/build/danmu-api/.payload-version   ← 版本标记（App 用来判断要不要重拷）
#
# 用法：
#   bash client/apps/ios/scripts/prepare-danmu-payload.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
BUILD="$ROOT/client/apps/ios/build"
CACHE="$BUILD/cache"
OUT="$BUILD/danmu-api"

VERSION="${DANMU_PAYLOAD_VERSION:-1.0.0}"
ZIP_NAME="danmu-api-${VERSION}.zip"
# latest 会跳到最新 release；失败再回退到已知可用的 tag（两处都只改这一行）
URL_LATEST="https://github.com/upchr/meow/releases/latest/download/${ZIP_NAME}"
URL_PINNED="https://github.com/upchr/meow/releases/download/release-v1.2.21/${ZIP_NAME}"

mkdir -p "$CACHE"
ZIP="$CACHE/$ZIP_NAME"
if [ ! -s "$ZIP" ]; then
  echo "[danmu] 下载 $URL_LATEST"
  if ! curl -fL --retry 2 --retry-delay 2 -o "$ZIP.part" "$URL_LATEST"; then
    echo "[danmu] latest 失败，回退 $URL_PINNED" >&2
    curl -fL --retry 3 --retry-delay 3 -o "$ZIP.part" "$URL_PINNED"
  fi
  mv "$ZIP.part" "$ZIP"
fi
echo "[danmu] 载荷包 $(du -h "$ZIP" | cut -f1)"

rm -rf "$OUT"
mkdir -p "$OUT"
unzip -q -o "$ZIP" -d "$OUT"

# 载荷**不裁剪**：发布出来的 zip 已经是 TV/PC 用的那份（构建时已去掉
# @electric-sql / drizzle-orm / @esbuild 等没人引的重型包）。再裁容易踩到
# 动态 import 的依赖 —— 宁可大 40MB，也不要运行时 MODULE_NOT_FOUND。
rm -f "$OUT/build-forward-widget.js" "$OUT/Dockerfile" 2>/dev/null || true

[ -f "$OUT/danmu_api/server.js" ] || { echo "[danmu] 载荷结构不对：缺 danmu_api/server.js" >&2; exit 2; }
[ -d "$OUT/node_modules" ] || { echo "[danmu] 载荷结构不对：缺 node_modules" >&2; exit 2; }

echo "$VERSION" > "$OUT/.payload-version"
du -sh "$OUT"
echo "[danmu] ok: $OUT"
