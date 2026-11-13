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

# 可选：把 cargo 的依赖缓存（CARGO_HOME）与增量产物（target）挂到宿主机目录，
# 让 CI 的 actions/cache 复用。meowd 编译是单腿最大开销（实测 83~102s），
# 增量编译后只重编改动的 crate。
# ★ 两个变量都不传时，行为与原来完全一致（编在 /out 里、一次性）。
CARGO_MOUNTS=()
CARGO_ENVS=()
TARGET_DIR_IN_CONTAINER=/out/cargo-target
if [ -n "${CARGO_HOME_CACHE:-}" ]; then
    # ★ 不能挂到 /usr/local/cargo：官方 rust 镜像的 cargo/rustc 可执行文件就在
    #   那里（/usr/local/cargo/bin），整目录挂上去 = 工具链消失，报
    #   "sh: cargo: not found"（2026-11-13 CI 实测 exit 127）。
    #   所以挂到独立路径并改 CARGO_HOME，只把 registry/git 缓存搬出容器。
    mkdir -p "$CARGO_HOME_CACHE"
    CARGO_MOUNTS+=(-v "$CARGO_HOME_CACHE:/cargo-home")
    CARGO_ENVS+=(-e CARGO_HOME=/cargo-home)
fi
if [ -n "${CARGO_TARGET_CACHE:-}" ]; then
    mkdir -p "$CARGO_TARGET_CACHE"
    CARGO_MOUNTS+=(-v "$CARGO_TARGET_CACHE:/cargo-target")
    TARGET_DIR_IN_CONTAINER=/cargo-target
fi

docker run --rm \
    -v "$SRC":/src \
    -v "$OUT":/out \
    "${CARGO_MOUNTS[@]}" \
    "${CARGO_ENVS[@]}" \
    -w /src/client/apps/fnos/meowd \
    -e CARGO_TARGET_DIR="$TARGET_DIR_IN_CONTAINER" \
    -e RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes" \
    "$IMG" sh -c \
    "rustup target add aarch64-unknown-linux-musl && cargo build --release --target aarch64-unknown-linux-musl && cp $TARGET_DIR_IN_CONTAINER/aarch64-unknown-linux-musl/release/meowd /out/meowd-aarch64"

file "$OUT/meowd-aarch64" || true
ls -l "$OUT/meowd-aarch64"
