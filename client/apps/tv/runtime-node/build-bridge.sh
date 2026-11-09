#!/usr/bin/env bash
# 编译 JNI 桥（不走 CMake —— AGP 拉 cmake 3.22.1 会被网络掐掉）。
#
# 产物直接落 jniLibs，由 AGP 打包进模块 APK。
# 需要：NDK（ANDROID_NDK 或 C:/Android/ndk/<ver>）+ 预编译 libnode.so 已在 jniLibs。
set -euo pipefail
NDK="${ANDROID_NDK:-C:/Android/ndk/26.1.10909125}"
# 宿主目录名随平台变：Windows=windows-x86_64，Linux=linux-x86_64，macOS=darwin-x86_64
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) HOST=windows-x86_64 ;;
  Darwin)               HOST=darwin-x86_64 ;;
  *)                    HOST=linux-x86_64 ;;
esac
BIN="$NDK/toolchains/llvm/prebuilt/$HOST/bin"
SYS="$NDK/toolchains/llvm/prebuilt/$HOST/sysroot/usr/lib"

for abi_target in x86_64-linux-android26 aarch64-linux-android26 armv7a-linux-androideabi26; do
  case "$abi_target" in
    x86_64-*)  abi=x86_64 ;;
    aarch64-*) abi=arm64-v8a ;;
    armv7a-*)  abi=armeabi-v7a ;;
  esac
  [ -f "src/main/jniLibs/$abi/libnode.so" ] || { echo "skip $abi (无 libnode.so)"; continue; }
  # Windows 的 NDK 叫 clang++.cmd，Linux/CI 上没有后缀
  CXX="$BIN/$abi_target-clang++"
  [ -f "$CXX.cmd" ] && CXX="$CXX.cmd"
  "$CXX" -std=c++17 -shared -fPIC -O2 -static-libstdc++ \
    -Wl,--no-undefined -o "src/main/jniLibs/$abi/libmeow_node_bridge.so" \
    src/main/cpp/node_bridge.cpp -L"src/main/jniLibs/$abi" -lnode -llog
  case "$abi" in
    x86_64)  cp "$SYS/x86_64-linux-android/libc++_shared.so"     "src/main/jniLibs/$abi/" ;;
    arm64-v8a) cp "$SYS/aarch64-linux-android/libc++_shared.so"  "src/main/jniLibs/$abi/" ;;
    armeabi-v7a) cp "$SYS/arm-linux-androideabi/libc++_shared.so" "src/main/jniLibs/$abi/" ;;
  esac
  echo "built $abi"
done
