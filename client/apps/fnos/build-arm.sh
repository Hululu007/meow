#!/bin/bash
# 交叉编译 aarch64 musl 版 meowd（在 fnOS 的 x86 Docker 里执行）。
#
# 用法（NAS 上）：
#   SRC=/tmp/meow-src OUT=/tmp/meow-out-arm bash client/apps/fnos/build-arm.sh
#
# 为什么不用 messense/rust-musl-cross：daocloud 镜像站不在白名单，直连
# Docker Hub 又超时。改用已拉下来的 rust:1-alpine，靠 rustup 补 target，
# 并用 rustc 自带的自包含 musl + rust-lld 链接，不需要额外 C 交叉工具链
# （本项目只依赖 libc，纯 Rust FFI，没有要本地编译的 C 代码）。
set -euo pipefail

SRC="${SRC:-}"
OUT="${OUT:-/tmp/meow-out-arm}"
IMG="${IMG:-docker.m.daocloud.io/library/rust:1-alpine}"

# ★ 故意不给 SRC 兜底默认值：静默回落 /tmp/meow-src 会把空目录挂进容器，
#   cargo 报 "could not find Cargo.toml"（2026-11-06 CI 踩过，exit 101），
#   而报错点离真正原因（调用方没传 SRC）隔了一层，极难看出。
if [ -z "$SRC" ]; then
    echo "缺少 SRC：必须显式传入仓库根目录的绝对路径（例：SRC=\$PWD OUT=/tmp/meow-out-arm）" >&2
    exit 2
fi
if [ ! -f "$SRC/client/apps/fnos/meowd/Cargo.toml" ]; then
    echo "SRC=$SRC 下没有 client/apps/fnos/meowd/Cargo.toml，看起来不是仓库根目录" >&2
    exit 2
fi

mkdir -p "$OUT"

docker run --rm \
    -v "$SRC":/src \
    -v "$OUT":/out \
    -w /src/client/apps/fnos/meowd \
    -e CARGO_TARGET_DIR=/out/cargo-target \
    -e RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes" \
    "$IMG" sh -c \
    'rustup target add aarch64-unknown-linux-musl && cargo build --release --target aarch64-unknown-linux-musl && cp /out/cargo-target/aarch64-unknown-linux-musl/release/meowd /out/meowd-aarch64'

file "$OUT/meowd-aarch64" || true
ls -l "$OUT/meowd-aarch64"
