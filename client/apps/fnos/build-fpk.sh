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
#   现在版本已运行期化（jar 不内嵌版本），复用 jar 不会再有"报旧版本"问题；
#   SKIP_JAR_BUILD=1 时只校验产物可用性，版本由包内 VERSION 文件保证。
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

# ★ 版本号不再是编译期常量（见 server/host/src/shared/ApiServer.java 的 resolveVersion）。
#   以前这里从 ApiServer.java 里 sed 出版本、再断言 jar 的 class 常量池里有这串——
#   那套做法的副作用是"版本参与编译"，插件/Docker 按源码 hash 的缓存每版必失效。
#   现在版本走打包期文件：这里把 manifest 的版本落到 app/seed/apiserver/VERSION，
#   jar 只校验"确实是可用的产物"（有 ApiServer.class、体量正常）。
jar_looks_valid() {
    # 不能写 `grep -q`：命中即退出会给 unzip 发 SIGPIPE（exit 141），pipefail 下整条管道判失败。
    # 实测 2026-11-09 在 NAS 上必现，去掉 -q 让 grep 读完。
    unzip -p "$1" ApiServer.class | grep -aF "ApiServer" >/dev/null
}

mkdir -p "$OUT"

echo "[1/5] apiserver.jar"
if [ "${SKIP_JAR_BUILD:-0}" = "1" ]; then
    echo "  SKIP_JAR_BUILD=1：复用 $JAR（版本已运行期化，复用不再有'报旧版本'风险）"
else
    OUT="$SRC/server/build/plugins/apiserver" bash "$SRC/server/build-plugin-linux.sh"
fi
[ -s "$JAR" ] || { echo "缺少 $JAR" >&2; exit 1; }
jar_looks_valid "$JAR" || { echo "$JAR 里没有 ApiServer.class，产物损坏" >&2; exit 1; }
echo "  apiserver.jar OK ($(du -h "$JAR" | cut -f1))"

echo "[1b/5] dex2jar（JVM 导入期 dex→class 转换）"
DEX2JAR_DIR="$SRC/server/tools/dex2jar"
if [ ! -d "$DEX2JAR_DIR/lib" ]; then
    bash "$SRC/deploy/scripts/fetch-dex2jar.sh" "$DEX2JAR_DIR"
fi
[ -d "$DEX2JAR_DIR/lib" ] || { echo "缺少 $DEX2JAR_DIR/lib" >&2; exit 1; }
# ★ 结构化门禁：dex2jar 必须正好是裁剪后的 13 个 jar。
#   不拦的话，手工放进来的完整包会让 fpk 一夜变大 18MB —— 1.1.7 就是这样涨的
#   （ANTLR 工具链 + icu4j 全被打进包），而当时没有任何体积/白名单检查。
#   白名单与判据见 deploy/scripts/fetch-dex2jar.sh。
D2J_N="$(find "$DEX2JAR_DIR/lib" -maxdepth 1 -name '*.jar' | wc -l)"
[ "$D2J_N" -eq 13 ] || {
    echo "dex2jar lib 里有 $D2J_N 个 jar（应为 13）——先跑 deploy/scripts/fetch-dex2jar.sh 裁剪" >&2
    exit 1
}

echo "[2/5] build meowd (musl, platform=$PLATFORM, docker $RUST_IMAGE)"
if [ "$PLATFORM" = "arm" ]; then
    # arm 二进制由 build-arm.sh 交叉编译；这里不重复编，避免误用 x86 产物
    test -x "$OUT/meowd-aarch64" || {
        echo "缺少 $OUT/meowd-aarch64，先跑 build-arm.sh" >&2
        exit 1
    }
    cp "$OUT/meowd-aarch64" "$OUT/meowd"
else
    # 可选：cargo 依赖缓存 / 增量产物挂到宿主机目录（同 build-arm.sh）。
    # 都不传时与原来一致：编在 /out 里、一次性。
    CARGO_MOUNTS=()
    CARGO_ENVS=()
    TARGET_DIR_IN_CONTAINER=/out/cargo-target
    if [ -n "${CARGO_HOME_CACHE:-}" ]; then
        # 不能挂 /usr/local/cargo（cargo 可执行文件在那儿，见 build-arm.sh 注释）
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
        "$RUST_IMAGE" sh -c \
        "cargo build --release && cp $TARGET_DIR_IN_CONTAINER/release/meowd /out/meowd"
fi

echo "[3/5] assemble package"
PKG="$OUT/pkg"
rm -rf "$PKG"
cp -r "$SRC/client/apps/fnos/fpk" "$PKG"
sed -i "s/^platform=.*/platform=$PLATFORM/" "$PKG/manifest"
if [ -n "$VERSION" ]; then
    sed -i "s/^version=.*/version=$VERSION/" "$PKG/manifest"
fi
# ★ desc 长度闸门（2026-11-20 实测）：
#   fnpack 1.2.3 会把超过 600 字节的 manifest 行折行，续行以 "#" 开头。
#   HTML 富文本 desc 里正好有 `color:#2dd4bf`，折行点落在 # 前 → 续行被飞牛
#   当注释忽略，商店里 desc 从那里被静默截断（1.2.17 / 1.2.18 的「使用说明 /
#   项目主页」链接就是这样丢的，看起来像"描述没更新"）。
#   fnpack 会把 key 对齐成 27 列（比源文件的 `desc=` 多 24 字节），所以源行要 <576。
DESC_BYTES="$(grep '^desc=' "$PKG/manifest" | LC_ALL=C wc -c | tr -d '[:space:]')"
if [ "${DESC_BYTES:-0}" -gt 575 ]; then
    echo "manifest desc 行 ${DESC_BYTES} 字节（含换行）> 575：fnpack 会折行并截断。" >&2
    echo "把 desc 压到 576 字节以内（去掉行内 style / target 最省），或把长文挪进 README。" >&2
    exit 1
fi
# 包内 app/ 的内容会落到 $TRIM_APPDEST
mkdir -p "$PKG/app/bin" "$PKG/app/web" "$PKG/app/seed/apiserver" "$PKG/app/plugins"
install -m 0755 "$OUT/meowd" "$PKG/app/bin/meowd"
# ★ /api/health 的 version 由 meowd **运行时**读这个文件（src/version.rs），不是编译期常量。
#   这样做是为了让 Cargo.toml 的版本号不再参与编译：否则每发一版都要重编整个 crate
#   （实测两腿各 33-35s），而版本号本质上只是元数据。
APP_VER="$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$PKG/manifest" | tr -d '[:space:]')"
[ -n "$APP_VER" ] || { echo "manifest 里读不到 version" >&2; exit 1; }
printf '%s\n' "$APP_VER" > "$PKG/app/bin/VERSION"

# ★ manifest 的 changelog 按版本从 CHANGELOG.md 写入（2026-11-20）。
#   应用中心「更新详情」读的是**包内 manifest** 的 changelog（app-center
#   /update/info?packageType=path），不是 fnpack.json 的 releases[].changelog。
#   以前这里是一行陈旧的固定文案，用户点更新永远看到"端口校验误报"那条。
#   FnDepot 的归一化函数会把字面量 "\n" 换成换行，所以多条之间用 \n 连接。
CHANGELOG_SECTION="$(awk -v v="$APP_VER" '
  $0 ~ "^##[[:space:]]*" v "[[:space:]]*$" {on=1; next}
  on && /^##[[:space:]]/ {exit}
  on && NF {sub(/^[[:space:]]+/,""); sub(/[[:space:]]+$/,""); lines[++n]=$0}
  END {out=""; for (i=1;i<=n;i++) out = out (i>1 ? "\\\\n" : "") lines[i]; printf "%s", out}
' "$SRC/CHANGELOG.md")"
if [ -n "$CHANGELOG_SECTION" ]; then
    if grep -q '^changelog[[:space:]]*=' "$PKG/manifest"; then
        CHANGELOG_SECTION="$CHANGELOG_SECTION" awk '
            /^changelog[[:space:]]*=/ {print "changelog=" ENVIRON["CHANGELOG_SECTION"]; next}
            {print}
        ' "$PKG/manifest" > "$PKG/manifest.new" && mv "$PKG/manifest.new" "$PKG/manifest"
    else
        printf 'changelog=%s\n' "$CHANGELOG_SECTION" >> "$PKG/manifest"
    fi
else
    echo "  ::warning::CHANGELOG.md 没有 $APP_VER 一节，manifest.changelog 保持原值" >&2
fi
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
# 后端版本文件：ApiServer 运行时读它（与 bin/VERSION 同一套思路），
# 这样 jar 本身与版本无关，插件/Docker 的源码-hash 缓存才能跨版本复用。
printf '%s\n' "$APP_VER" > "$PKG/app/seed/apiserver/VERSION"
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

# ★ 体积绊线（不是设计目标，是"有人又把大依赖打进来"的报警器）：
#   2026-11-16 实测量级 19.5MiB（dex2jar 裁剪后）。1.1.7 那次没拦，一夜 +18MB。
FPK_BYTES="$(stat -c%s "$OUT/meow_${VER}_${PLATFORM}.fpk")"
FPK_MAX_MIB="${FPK_MAX_MIB:-24}"
if [ "$FPK_BYTES" -gt $((FPK_MAX_MIB * 1048576)) ]; then
    echo "fpk 体积 $(awk -v b="$FPK_BYTES" 'BEGIN{printf "%.1f", b/1048576}')MiB 超过绊线 ${FPK_MAX_MIB}MiB。" >&2
    echo "先看是不是有大依赖被顺手打进包（参考 dex2jar 裁剪：deploy/scripts/fetch-dex2jar.sh）。" >&2
    exit 1
fi

echo "[5/5] static check"
FPK="$OUT/meow_${VER}_${PLATFORM}.fpk"
tar -tzf "$FPK" >/dev/null                       # 至少是合法 tar.gz
TMPX="$OUT/.unpack-$PLATFORM"
rm -rf "$TMPX"; mkdir -p "$TMPX/app"
tar -xzf "$FPK" -C "$TMPX" manifest app.tgz
tar -xzf "$TMPX/app.tgz" -C "$TMPX/app"
grep -qE "^version[[:space:]]*=[[:space:]]*$VER" "$TMPX/manifest" || { echo "manifest version 写错" >&2; exit 1; }
grep -qE "^platform[[:space:]]*=[[:space:]]*$PLATFORM" "$TMPX/manifest" || { echo "manifest platform 写错" >&2; exit 1; }
# ★ desc 必须逐字节与源一致（2026-11-20）。
#   长度闸门只能防"太长"，防不了 fnpack 版本换算法；这里直接拿解包结果比对：
#   折行后 sed 只能取到前半截，比较必然不等 → 构建失败而不是悄悄发一个截断描述。
SRC_DESC="$(sed -n 's/^desc[[:space:]]*=[[:space:]]*//p' "$SRC/client/apps/fnos/fpk/manifest")"
PKG_DESC="$(sed -n 's/^desc[[:space:]]*=[[:space:]]*//p' "$TMPX/manifest" | head -1)"
if [ "$SRC_DESC" != "$PKG_DESC" ]; then
    echo "包内 manifest 的 desc 与源不一致（fnpack 折行/截断）：" >&2
    echo "  src: ${#SRC_DESC} 字符" >&2
    echo "  pkg: ${#PKG_DESC} 字符" >&2
    exit 1
fi
if grep -qE '^# ' "$TMPX/manifest"; then
    echo "manifest 里出现以 '# ' 开头的续行 —— fnpack 折行产物，desc 会少一截" >&2
    exit 1
fi
# ★ changelog 也必须与 CHANGELOG.md 一致：应用中心更新弹框读的就是这个字段。
if [ -n "$CHANGELOG_SECTION" ]; then
    PKG_CL="$(sed -n 's/^changelog[[:space:]]*=[[:space:]]*//p' "$TMPX/manifest" | head -1)"
    if [ "$PKG_CL" != "$CHANGELOG_SECTION" ]; then
        echo "包内 manifest 的 changelog 与 CHANGELOG.md 不一致（fnpack 折行/截断）" >&2
        echo "  src: ${#CHANGELOG_SECTION} 字符, pkg: ${#PKG_CL} 字符" >&2
        exit 1
    fi
fi
test -f "$TMPX/app/web/index.html" || { echo "包内缺 web/index.html" >&2; exit 1; }
test -f "$TMPX/app/seed/apiserver/apiserver.jar" || { echo "包内缺 apiserver.jar" >&2; exit 1; }
# 后端版本文件必须存在且与 manifest 一致：ApiServer 运行时就靠它报 /api/health 的 version
test -f "$TMPX/app/seed/apiserver/VERSION" || { echo "包内缺 seed/apiserver/VERSION（后端版本来源）" >&2; exit 1; }
[ "$(tr -d '[:space:]' < "$TMPX/app/seed/apiserver/VERSION")" = "$VER" ] || {
    echo "seed/apiserver/VERSION 与 manifest version 不一致：$(cat "$TMPX/app/seed/apiserver/VERSION") vs $VER" >&2
    exit 1
}
test -d "$TMPX/app/seed/apiserver/tools/dex2jar/lib" || { echo "包内缺 dex2jar（JVM dex 源转换需要）" >&2; exit 1; }
D2J_PKG_N="$(find "$TMPX/app/seed/apiserver/tools/dex2jar/lib" -maxdepth 1 -name '*.jar' | wc -l)"
[ "$D2J_PKG_N" -eq 13 ] || { echo "包内 dex2jar 有 $D2J_PKG_N 个 jar（应为裁剪后的 13）" >&2; exit 1; }
# meowd 的 /api/health version 读的是这个文件（src/version.rs）；与 manifest 必须一致，
# 否则会出现"装的是 1.2.9、health 报别的版本"这类只有用户能看见的漂移。
test -f "$TMPX/app/bin/VERSION" || { echo "包内缺 bin/VERSION（health 的版本来源）" >&2; exit 1; }
[ "$(tr -d '[:space:]' < "$TMPX/app/bin/VERSION")" = "$VER" ] || {
    echo "bin/VERSION 与 manifest version 不一致：$(cat "$TMPX/app/bin/VERSION") vs $VER" >&2
    exit 1
}
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
