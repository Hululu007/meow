#!/usr/bin/env bash
# 准备 iOS 端内 Node 运行时（nodejs-mobile 的 iOS 构建）。
#
# 为什么是它：V8 的 JIT 需要可执行内存，iOS 非越狱设备不给 → 官方 Node 跑不了。
# nodejs-mobile 的 iOS 构建**把 V8 配成启动即关 JIT**（interpreter only），
# 所以能进 App；对外接口就一个 C 函数：
#
#     int node_start(int argc, char *argv[]);
#
# 我们用它跑 TV 同款弹幕服务（danmu_api/server.js），从而对齐安卓 TV 的
# 「运行时模块 + danmu_api」形态（见 site/docs/dev/ios-integration.md §0）。
#
# 产物：
#   client/apps/ios/build/node/NodeMobile.framework   ← 真机 arm64 那份
#   client/apps/ios/build/node/probe.txt              ← 结构/lipo 报告（CI 存档）
#
# 用法：
#   bash client/apps/ios/scripts/prepare-node-runtime.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
BUILD="$ROOT/client/apps/ios/build"
CACHE="$BUILD/cache"
OUT="$BUILD/node"
WORK="$BUILD/node-tmp"

# 版本与 URL：nodejs-mobile 的 iOS 预编译包（含真机 arm64 / 模拟器 arm64 / x86_64）
NODEJS_MOBILE_VERSION="${NODEJS_MOBILE_VERSION:-18.20.4}"
ZIP_NAME="nodejs-mobile-v${NODEJS_MOBILE_VERSION}-ios.zip"
ZIP_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${NODEJS_MOBILE_VERSION}/${ZIP_NAME}"

mkdir -p "$CACHE" "$OUT"

ZIP="$CACHE/$ZIP_NAME"
if [ ! -f "$ZIP" ]; then
  echo "[node] 下载 $ZIP_URL"
  curl -fL --retry 3 --retry-delay 3 -o "$ZIP.part" "$ZIP_URL"
  mv "$ZIP.part" "$ZIP"
fi
echo "[node] 运行时包 $(du -h "$ZIP" | cut -f1)"

rm -rf "$WORK"
mkdir -p "$WORK"
unzip -q -o "$ZIP" -d "$WORK"

# 发行包里有多份 framework（真机 / 模拟器 arm64 / 模拟器 x86_64）。
# 真机与模拟器都是 arm64，靠 **平台**（ios vs ios-simulator）区分，不是靠架构。
#   platform_build_version <bin> → "platform: ios" / "platform: ios-simulator"
platform_build_version() {
  if command -v vtool >/dev/null 2>&1; then
    vtool -show-build-version "$1" 2>/dev/null | grep -i "platform" | head -1
  else
    otool -l "$1" 2>/dev/null | grep -A4 LC_BUILD_VERSION | grep -E "platform|minos" | head -2 | tr '\n' ' '
  fi
}

rm -rf "$OUT/NodeMobile.framework" "$OUT/sim"
DEVICE_FW=""
SIM_FW=""
while IFS= read -r fw; do
  bin="$fw/NodeMobile"
  [ -f "$bin" ] || continue
  plat="$(platform_build_version "$bin" | tr '[:upper:]' '[:lower:]')"
  case "$plat" in
    *ios-simulator*|*iossimulator*)
      [ -z "$SIM_FW" ] && SIM_FW="$fw"
      ;;
    *ios*)
      [ -z "$DEVICE_FW" ] && DEVICE_FW="$fw"
      ;;
  esac
done < <(find "$WORK" -type d -name 'NodeMobile.framework')

if [ -z "$DEVICE_FW" ]; then
  echo "[node] 没找到真机（ios）的 NodeMobile.framework，包结构：" >&2
  find "$WORK" -maxdepth 5 -name 'NodeMobile.framework' >&2
  exit 1
fi

cp -R "$DEVICE_FW" "$OUT/NodeMobile.framework"
if [ -n "$SIM_FW" ]; then
  mkdir -p "$OUT/sim"
  cp -R "$SIM_FW" "$OUT/sim/NodeMobile.framework"
fi

BIN="$OUT/NodeMobile.framework/NodeMobile"
{
  echo "version=$NODEJS_MOBILE_VERSION"
  echo "device_source=$DEVICE_FW"
  echo "device_lipo=$(lipo -info "$BIN" 2>/dev/null || echo unknown)"
  echo "device_platform=$(platform_build_version "$BIN")"
  echo "device_size=$(du -h "$BIN" | cut -f1)"
  echo "sim_source=${SIM_FW:-none}"
  echo "sim_lipo=$( [ -n "$SIM_FW" ] && lipo -info "$OUT/sim/NodeMobile.framework/NodeMobile" 2>/dev/null || echo none)"
  echo "headers:"
  find "$OUT/NodeMobile.framework" -maxdepth 3 -name '*.h' | sed 's#^.*/NodeMobile.framework/#  #'
} > "$OUT/probe.txt"

rm -rf "$WORK"
echo "[node] NodeMobile.framework -> $OUT"
cat "$OUT/probe.txt"
