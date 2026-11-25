#!/bin/sh
# 按目标平台裁剪 guard-libs 里的原生库（只删别的平台的 .so/.dll/.dylib，不动 class）。
#
# 为什么可以裁：guard-helper.jar 里改过的 org.scijava.nativelib.NativeLoader 只按
# os.name / os.arch 选**一个** natives/<平台>/ 目录；keystone / capstone / jna /
# demumble 各自也只按 JNA 平台名取自己那份。别的平台在运行期永远不会被打开，
# 六个 jar 里约 17MB 属于死重量（1.2.22 实测：guard-libs 34MB → 16.6MB）。
#
# ★ unicorn 要留两份原生库：GuardShellMain 在 Linux 上显式用 Unicorn2Factory，
#   Windows 上走默认的 legacy UnicornFactory（UnicornBackend）——裁错哪个都会
#   到真解密时才报 "native library not found"。见 GuardNativeProbe 的注释。
#
# 历史：先试过 `jar --delete`，JDK 17 的 jar 没有这个选项（实测报"无法识别的选项"），
# 所以走"解开 → 删 → 重打"。重打不改变 class 内容，脚本会断言 class 数量前后一致。
#
# 用法：trim-guard-libs.sh <win-x64|linux-x64|linux-arm64> <guard-libs 目录>
#
# 约束（改之前先读）：
#   · 只处理下面 6 类 jar，其余文件一个都不动；
#   · keep 前缀必须命中至少一个**原生库文件**（缺一个就 exit 1）——上游升级改了
#     目录名时这一步会直接拦住构建，避免发出"能装、一用加密源就崩"的包；
#   · 重复执行不会再变（idempotent）。
#
# ★ 刻意写成 POSIX sh（不用数组/进程替换）：Docker 构建阶段用的是 dash。
set -eu

TARGET="${1:-}"
DIR="${2:-}"
if [ -z "$TARGET" ] || [ -z "$DIR" ]; then
    echo "usage: $0 <win-x64|linux-x64|linux-arm64> <guard-libs dir>" >&2
    exit 2
fi
[ -d "$DIR" ] || { echo "[trim] 目录不存在: $DIR" >&2; exit 1; }
# 必须在 cd 到临时目录前转绝对路径：jar 解包/重打都在子 shell 里换了 cwd
DIR="$(cd "$DIR" && pwd)"
command -v jar >/dev/null 2>&1 || { echo "[trim] 需要 JDK 的 jar 命令" >&2; exit 1; }

# 每个目标保留哪些前缀（capstone 在 x64 上还有一份 libdisassembler，所以有两个；
# 多个前缀用 | 分隔）
case "$TARGET" in
    win-x64)
        K_UNIDBG=""
        K_UNICORN="natives/windows_64/"
        K_KEYSTONE="win32-x86-64/"
        K_CAPSTONE="win32-x86-64/"
        K_DEMUMBLE=""
        K_JNA="com/sun/jna/win32-x86-64/"
        ;;
    linux-x64)
        K_UNIDBG="natives/linux_64/"
        K_UNICORN=""
        K_KEYSTONE="linux-x86-64/"
        K_CAPSTONE="linux-x86-64/|natives/linux_64/"
        K_DEMUMBLE="natives/linux_64/"
        K_JNA="com/sun/jna/linux-x86-64/"
        ;;
    linux-arm64)
        K_UNIDBG="natives/linux_arm64/"
        K_UNICORN=""
        K_KEYSTONE="linux-aarch64/"
        K_CAPSTONE="linux-aarch64/"
        K_DEMUMBLE="natives/linux_arm64/"
        K_JNA="com/sun/jna/linux-aarch64/"
        ;;
    *)
        echo "[trim] 未知目标: $TARGET（只支持 win-x64 / linux-x64 / linux-arm64）" >&2
        exit 2
        ;;
esac

human() { awk -v b="$1" 'BEGIN { printf "%.1fMB", b/1048576 }'; }
# Windows 上 jar.exe 输出 CRLF，删 \r 后再比较/计数
list_jar() { jar --list --file "$1" | tr -d '\r'; }

# keep 前缀必须各命中至少一个原生库文件；命中总数打到 stdout，缺项报错返回 1。
# 只数 .so/.dll/.dylib/.jnilib/.a —— keystone 等 jar 里还有 .gitkeep，不能拿它充数。
count_keep() {
    _jar="$1"
    _keepf="$2"
    _got=0
    while IFS= read -r _p; do
        [ -n "$_p" ] || continue
        _n=$(list_jar "$_jar" | grep -v '/$' | grep -E '\.(so|dll|dylib|jnilib|a)$' | grep -c "^$_p" || true)
        if [ "$_n" -lt 1 ]; then
            echo "[trim] $(basename "$_jar") 缺少本平台原生库: $_p（上游可能改了目录名）" >&2
            return 1
        fi
        _got=$((_got + _n))
    done < "$_keepf"
    echo "$_got"
}

trim_one() {
    jar="$1"
    keep="$2"
    base=$(basename "$jar")
    before=$(stat -c %s "$jar")
    cls_before=$(list_jar "$jar" | grep -c '\.class$' || true)

    keepf=$(mktemp)
    list=$(mktemp)
    # ★ 必须带换行：`printf '%s'` 不加 \n 时，sh 的 `read` 在 EOF 上返回非 0，
    #   while 循环会把最后一行丢掉 —— 实测（dash）会把所有原生库全删掉。
    printf '%s\n' "$keep" | tr '|' '\n' > "$keepf"

    # 幂等短路：先看有没有要删的原生库。没有就只做断言、不重打 ——
    # 在 QEMU 里重压 6 个 jar 实测 ~50s，而同一目录被重复 trim（本地二次构建、
    # 后续把裁剪结果做缓存）很常见。
    # ★ 用 for 而不是 `while read < 文件`：列表为空时 while 的退出码是 1，
    #   set -e 会直接把脚本干掉（dash 实测，且不打印任何错误）。
    need=0
    for entry in $(list_jar "$jar" | grep -v '/$' | grep -E '\.(so|dll|dylib|jnilib|a)$'); do
        kept=0
        while IFS= read -r p; do
            [ -n "$p" ] || continue
            case "$entry" in
                "$p"*) kept=1 ;;
            esac
        done < "$keepf"
        if [ "$kept" = 0 ]; then need=1; break; fi
    done
    if [ "$need" = 0 ]; then
        if ! got=$(count_keep "$jar" "$keepf"); then
            rm -f "$keepf" "$list"
            exit 1
        fi
        rm -f "$keepf" "$list"
        echo "  $base: 已是目标平台的裁剪结果，跳过重打（原生库 $got 个）"
        return
    fi

    work=$(mktemp -d)
    out="$work.jar"
    ( cd "$work" && jar --extract --file "$jar" >/dev/null )

    # 删掉本平台用不到的原生库；.a 也算（jna 的 aix 包就是 .a）
    find "$work" -type f \( -name '*.so' -o -name '*.dll' -o -name '*.dylib' \
        -o -name '*.jnilib' -o -name '*.a' \) -print > "$list"
    while IFS= read -r f; do
        rel="${f#"$work"/}"
        kept=0
        while IFS= read -r p; do
            [ -n "$p" ] || continue
            case "$rel" in
                "$p"*) kept=1 ;;
            esac
        done < "$keepf"
        [ "$kept" = 1 ] || rm -f "$f"
    done < "$list"

    # 删完文件后剩下的空目录（natives/osx_64/ 之类）一并清掉
    find "$work" -depth -type d -empty -delete

    ( cd "$work" && jar --create --file "$out" . >/dev/null )

    cls_after=$(list_jar "$out" | grep -c '\.class$' || true)
    if [ "$cls_before" != "$cls_after" ]; then
        echo "[trim] $base class 数量变了：$cls_before -> $cls_after" >&2
        rm -rf "$work" "$out" "$keepf" "$list"
        exit 1
    fi

    if ! got=$(count_keep "$out" "$keepf"); then
        rm -rf "$work" "$out" "$keepf" "$list"
        exit 1
    fi

    mv -f "$out" "$jar"
    rm -rf "$work" "$keepf" "$list"
    after=$(stat -c %s "$jar")
    echo "  $base: $(human "$before") -> $(human "$after")  (保留原生库 $got 个)"
}

echo "[trim] target=$TARGET dir=$DIR"
for jar in "$DIR"/*.jar; do
    [ -f "$jar" ] || continue
    base=$(basename "$jar")
    case "$base" in
        unidbg-unicorn2-*.jar) trim_one "$jar" "$K_UNIDBG" ;;
        unicorn-[0-9]*.jar)    trim_one "$jar" "$K_UNICORN" ;;
        keystone-*.jar)        trim_one "$jar" "$K_KEYSTONE" ;;
        capstone-*.jar)        trim_one "$jar" "$K_CAPSTONE" ;;
        demumble-*.jar)        trim_one "$jar" "$K_DEMUMBLE" ;;
        jna-[0-9]*.jar)        trim_one "$jar" "$K_JNA" ;;
    esac
done

echo "[trim] 完成（只影响原生库；解密用的 class 未改动）"
