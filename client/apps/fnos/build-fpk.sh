#!/bin/bash
# 在 Linux（fnOS 机器 / GitHub ubuntu runner）执行：编 musl 二进制 + 组装 fpk。
# 本机（Windows）不折腾 musl 工具链。
#
# 用法（NAS 上）：
#   SRC=/tmp/meow-src OUT=/tmp/meow-out bash client/apps/fnos/build-fpk.sh
#   PLATFORM=arm SRC=/tmp/meow-src OUT=/tmp/meow-out-arm bash client/apps/fnos/build-fpk.sh
#
# 约定：SRC 是仓库副本（含 client/apps/web/dist、server/host/libs）
#
# ★ apiserver.jar 默认由本脚本自己构建（server/build-plugin-linux.sh）。
#   2026-11-06 踩过：这里直接复制 server/build/ 下 11-03 的旧 jar，
#   结果 /api/health 报 version=1.0.5（源码已是 1.0.8），装上去能跑但版本对不上。
#   确实要复用现成产物时用 SKIP_JAR_BUILD=1，此时强制校验 jar 内 VERSION 与源码一致，
#   不一致直接失败——不允许"静默复制"。
set -euo pipefail

SRC="${SRC:-/tmp/meow-src}"
OUT="${OUT:-/tmp/meow-out}"
RUST_IMAGE="${RUST_IMAGE:-docker.m.daocloud.io/library/rust:1-alpine}"
# x86 / arm 各打一个包：官方 manifest 的 `all` 只允许“包内不含架构相关二进制”，
# 我们的 bin/meowd 是 ELF，只能写具体架构（见 docs/core-concepts/manifest）。
PLATFORM="${PLATFORM:-x86}"
# 可选：由 CI 从 client/package.json 传进来，覆盖 manifest 里的 version。
# 目的：不想把 fpk 的版本号加进 bump-version.ps1 的 13 处（那会让文档与脚本一起漂）。
VERSION="${VERSION:-}"

JAR="$SRC/server/build/plugins/apiserver/apiserver.jar"
SRC_VERSION="$(sed -n 's/.*VERSION *= *"\([0-9][0-9.]*\)".*/\1/p' \
    "$SRC/server/host/src/shared/ApiServer.java" | head -1)"

# 在 jar 的 ApiServer.class 里找**期望的**版本串。不能用 unzip 的文本模式，
# class 常量池是二进制；grep -a 按字节扫最稳（不依赖 strings 是否装了）。
# ★ 按字面匹配而不是正则猜版本格式：原来写死 `1\.0\.[0-9]+`，
#   升到 1.1.0 时会一个都匹配不到、把新 jar 误报成陈旧产物。
# ★ 不能写 `grep -q`：它命中后立刻退出，unzip 还在写 200KB 的 class 会收到
#   SIGPIPE（exit 141），而本脚本开了 pipefail → 整个管道判失败。
#   实测 2026-11-09 在 NAS 上重跑时必现「找不到 VERSION=x」而手工 grep 通过。
#   去掉 -q 让 grep 读完全部输入即可。
jar_has_version() {
    unzip -p "$1" ApiServer.class | grep -aF "$2" >/dev/null
}

mkdir -p "$OUT"

echo "[1/5] apiserver.jar (源码 VERSION=$SRC_VERSION)"
if [ "${SKIP_JAR_BUILD:-0}" = "1" ]; then
    echo "  SKIP_JAR_BUILD=1：复用 $JAR，强制校验版本"
else
    OUT="$SRC/server/build/plugins/apiserver" bash "$SRC/server/build-plugin-linux.sh"
fi
[ -f "$JAR" ] || { echo "缺少 $JAR" >&2; exit 1; }
if ! jar_has_version "$JAR" "$SRC_VERSION"; then
    echo "apiserver.jar 里找不到 VERSION=$SRC_VERSION（源码是这个版本号）。" >&2
    echo "这是陈旧产物，拒绝打包。删掉 $JAR 后重跑（不要用 SKIP_JAR_BUILD=1）。" >&2
    exit 1
fi
echo "  apiserver.jar OK (VERSION=$SRC_VERSION)"

echo "[1b/5] dex2jar（JVM 导入期 dex→class 转换）"
DEX2JAR_DIR="$SRC/server/tools/dex2jar"
if [ ! -d "$DEX2JAR_DIR/lib" ]; then
    bash "$SRC/deploy/scripts/fetch-dex2jar.sh" "$DEX2JAR_DIR"
fi
[ -d "$DEX2JAR_DIR/lib" ] || { echo "缺少 $DEX2JAR_DIR/lib" >&2; exit 1; }

echo "[2/5] build meowd (musl, platform=$PLATFORM, docker $RUST_IMAGE)"
if [ "$PLATFORM" = "arm" ]; then
    # arm 二进制由 build-arm.sh 交叉编译；这里不重复编，避免误用 x86 产物
    test -x "$OUT/meowd-aarch64" || {
        echo "缺少 $OUT/meowd-aarch64，先跑 build-arm.sh" >&2
        exit 1
    }
    cp "$OUT/meowd-aarch64" "$OUT/meowd"
else
    docker run --rm \
        -v "$SRC":/src \
        -v "$OUT":/out \
        -w /src/client/apps/fnos/meowd \
        -e CARGO_TARGET_DIR=/out/cargo-target \
        "$RUST_IMAGE" sh -c \
        'cargo build --release && cp /out/cargo-target/release/meowd /out/meowd'
fi

echo "[3/5] assemble package"
PKG="$OUT/pkg"
rm -rf "$PKG"
cp -r "$SRC/client/apps/fnos/fpk" "$PKG"
sed -i "s/^platform=.*/platform=$PLATFORM/" "$PKG/manifest"
if [ -n "$VERSION" ]; then
    sed -i "s/^version=.*/version=$VERSION/" "$PKG/manifest"
fi
# 包内 app/ 的内容会落到 $TRIM_APPDEST
mkdir -p "$PKG/app/bin" "$PKG/app/web" "$PKG/app/seed/apiserver" "$PKG/app/plugins"
install -m 0755 "$OUT/meowd" "$PKG/app/bin/meowd"
test -f "$SRC/client/apps/web/dist/index.html" || {
    echo "缺少 client/apps/web/dist/index.html —— 网页没构建，打出来的包是白屏" >&2
    exit 1
}
# ★ 必须校验 base：fnOS 微应用挂在 /app/meow/ 下，dist 若用默认 base="/"
#   （即 assets 写成 /assets/...），装上去页面能返回 index.html 但 JS 全 404，
#   表现为标题有、正文空白。正确构建命令见 fpk.yml：
#     VITE_API_BASE=/app/meow pnpm --filter @meow/web exec vite build --base=/app/meow/
#   2026-11-09 实测踩过：本地直接 `pnpm --filter @meow/web build` 打进 fpk，
#   在线升级后整页白屏。
grep -q 'src="/app/meow/assets/' "$SRC/client/apps/web/dist/index.html" || {
    echo "web dist 的 base 不是 /app/meow/（升级后会白屏）。" >&2
    echo "用 VITE_API_BASE=/app/meow pnpm --filter @meow/web exec vite build --base=/app/meow/ 重建" >&2
    exit 1
}
cp -r "$SRC/client/apps/web/dist/." "$PKG/app/web/"
cp "$JAR" "$PKG/app/seed/apiserver/apiserver.jar"
mkdir -p "$PKG/app/seed/apiserver/tools"
cp -a "$DEX2JAR_DIR" "$PKG/app/seed/apiserver/tools/dex2jar"
HAS_SPIDER=0
if [ -f "$SRC/server/host/libs/spider.jar" ]; then
    cp "$SRC/server/host/libs/spider.jar" "$PKG/app/seed/apiserver/"
    HAS_SPIDER=1
else
    echo "  ::warning:: 纯壳 fpk：不含 spider.jar（用户需在应用内导入源包）"
fi

# 随包插件载荷。node 运行时**不在包里**：由应用中心依赖 nodejs_v22 提供
# （manifest 的 install_dep_apps）。
#
# 载荷源 = TV 模块已经在用的那份裁剪版（下面这个 zip 入库、4,332 个文件、
# 不含 node 二进制），PC 插件用的是同一套裁剪规则产出的同一份内容。
# ★ 不要改成 research/upstream/danmu_api：那是全量上游（9,299 文件 / 104MB），
#   且被 gitignore —— CI 里拿不到，本地也会把测试与开发文件打进去。
PAYLOAD_ZIP="$SRC/client/apps/tv/app/src/main/assets/node-payload-danmu.zip"
HAS_PAYLOAD=0
if [ -f "$PAYLOAD_ZIP" ]; then
    HAS_PAYLOAD=1
    mkdir -p "$PKG/app/plugins/danmu-api"
    unzip -q "$PAYLOAD_ZIP" -d "$PKG/app/plugins/danmu-api"
    # 清单复用 PC 契约（server/plugin-manifests/danmu-api.manifest.json），不另立一份
    cp "$SRC/server/plugin-manifests/danmu-api.manifest.json" \
       "$PKG/app/plugins/danmu-api/manifest.json"
else
    echo "  ::warning:: 纯壳 fpk：不含 danmu-api 载荷（弹幕退回内置官方源）"
fi
# 包内绝不允许出现 node 可执行文件：一旦混进去，体积 +52MB 且与依赖版本打架
# ★ 同样避开 `find | grep -q`：grep 提前退出会让 find 吃 SIGPIPE，pipefail 下
#   结果是"有 node 也判成没有"（负向漏检），这里用 -print -quit + 命令替换。
if [ -n "$(find "$PKG/app/plugins" -type f \( -name node -o -name 'node.exe' \) -print -quit 2>/dev/null)" ]; then
    echo "插件载荷里混进了 node 运行时，拒绝打包（node 必须走 install_dep_apps）" >&2
    exit 1
fi

chmod +x "$PKG"/cmd/*

# wizard 静态校验（2026-11-09 踩坑后加）：
#   1) 必须是合法 JSON —— 不合法时 tar 照样能打包，装到应用中心才向导空白/装不上；
#   2) 端口字段不能用 min/max —— 飞牛向导表单是 async-validator，text 字段的
#      min/max 判的是**字符串长度**（"30010".length = 5 < 1024），正确的端口
#      也会被判「端口范围 1024–65535」而拦死安装。改用范围正则。
for f in "$PKG"/wizard/*; do
    if command -v python3 >/dev/null 2>&1; then
        python3 -m json.tool "$f" >/dev/null 2>&1 || { echo "$f 不是合法 JSON" >&2; exit 1; }
    elif command -v node >/dev/null 2>&1; then
        node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" >/dev/null 2>&1 \
            || { echo "$f 不是合法 JSON" >&2; exit 1; }
    fi
    if grep -qE '"min"[^}]*端口范围|"max"[^}]*端口范围' "$f"; then
        echo "$f: 端口规则用了 min/max —— 向导按字符串长度校验，正确端口也会被判越界。" >&2
        echo "改用范围正则（见 wizard/install）；见 docs/36「向导端口规则不能用 min/max」。" >&2
        exit 1
    fi
done

echo "[4/5] pack"
cd "$PKG"
if command -v fnpack >/dev/null 2>&1; then
    fnpack build
else
    # 兜底：fnpack 拿不到时按官方包结构手工打（2026-11-06 从 fnpack 产物解包确认）：
    #   fpk = tar.gz，根下有 manifest / cmd/ / config/ / wizard/ / ICON*.PNG / app.tgz
    echo "  ::warning:: 未找到 fnpack，按官方结构手工打包（未经安装验证，仅应急）"
    tar -czf app.tgz -C app .
    tar -czf meow.fpk manifest ICON.PNG ICON_256.PNG cmd config wizard app.tgz
fi
# fnpack 会把 manifest 重排成 `key                    = value`，
# 所以读回时不能假设 `version=` 紧贴（踩过：静态校验误报 "manifest version 写错"）。
VER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$PKG/manifest" | tr -d '[:space:]')"
mv "$PKG/meow.fpk" "$OUT/meow_${VER}_${PLATFORM}.fpk"
ls -lh "$OUT/meow_${VER}_${PLATFORM}.fpk"

echo "[5/5] static check"
FPK="$OUT/meow_${VER}_${PLATFORM}.fpk"
tar -tzf "$FPK" >/dev/null                       # 至少是合法 tar.gz
TMPX="$OUT/.unpack-$PLATFORM"
rm -rf "$TMPX"; mkdir -p "$TMPX/app"
tar -xzf "$FPK" -C "$TMPX" manifest app.tgz
tar -xzf "$TMPX/app.tgz" -C "$TMPX/app"
grep -qE "^version[[:space:]]*=[[:space:]]*$VER" "$TMPX/manifest" || { echo "manifest version 写错" >&2; exit 1; }
grep -qE "^platform[[:space:]]*=[[:space:]]*$PLATFORM" "$TMPX/manifest" || { echo "manifest platform 写错" >&2; exit 1; }
test -f "$TMPX/app/web/index.html" || { echo "包内缺 web/index.html" >&2; exit 1; }
test -f "$TMPX/app/seed/apiserver/apiserver.jar" || { echo "包内缺 apiserver.jar" >&2; exit 1; }
test -d "$TMPX/app/seed/apiserver/tools/dex2jar/lib" || { echo "包内缺 dex2jar（JVM dex 源转换需要）" >&2; exit 1; }
if [ "$HAS_SPIDER" = "1" ]; then
    test -f "$TMPX/app/seed/apiserver/spider.jar" || { echo "包内缺 spider.jar" >&2; exit 1; }
fi
if [ "$HAS_PAYLOAD" = "1" ]; then
    test -f "$TMPX/app/plugins/danmu-api/manifest.json" || { echo "包内缺插件清单 plugins/danmu-api/manifest.json" >&2; exit 1; }
    test -f "$TMPX/app/plugins/danmu-api/danmu_api/server.js" || { echo "包内缺插件入口 danmu_api/server.js" >&2; exit 1; }
    # 载荷必须来自 TV 那份已打补丁的裁剪版（代理端口/绑定地址可配）：
    # 全量上游或旧产物里没有这两个环境变量，打进去就会把 5321 写死、绑 0.0.0.0
    grep -q 'DANMU_API_PROXY_PORT' "$TMPX/app/plugins/danmu-api/danmu_api/server.js" || {
        echo "插件载荷不是 TV 裁剪版（server.js 缺少 DANMU_API_PROXY_PORT）" >&2
        exit 1
    }
fi
if [ -n "$(find "$TMPX/app/plugins" -type f \( -name node -o -name 'node.exe' \) -print -quit 2>/dev/null)" ]; then
    echo "包内出现 node 运行时（应交给应用中心依赖 nodejs_v22）" >&2
    exit 1
fi
echo "  plugins: $(du -sb "$TMPX/app/plugins" | cut -f1) 字节 / $(find "$TMPX/app/plugins" -type f | wc -l) 个文件"
rm -rf "$TMPX"
echo "  OK: $FPK"
