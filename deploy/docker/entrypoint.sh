#!/bin/sh
# 镜像默认源：多仓（chunk1 肥猫+Jable，chunk2 脚本源）。
#
# 根 config.all.json 是多仓索引 {"urls":[{name,url}]}：
# 导入时只加载第一个仓，其余由客户端存成列表供切换（Fongmi 同语义）。
#
# 有 /mounted-sources/config.all.json 时，整目录复制覆盖默认源（不做占位符替换，
# 挂载包必须自带绝对地址）。
set -eu

HTML=/usr/share/nginx/html
DEFAULT=/opt/meow-sources/default
MOUNT=/mounted-sources
BASE="${MEOW_SOURCES_BASE:-http://127.0.0.1:18080}"

if [ -f "$MOUNT/config.all.json" ]; then
    echo "[meow-sources] using mounted source pack from $MOUNT"
    cp -a "$MOUNT"/. "$HTML"/
else
    echo "[meow-sources] using built-in multi-repo pack, base=$BASE"
    cp -a "$DEFAULT"/. "$HTML"/
    # ★ 必须递归：多仓改造后每个仓自己的 config 在 packs/<id>/ 下，
    #   只 sed 根配置会漏掉它们，部署后仓内 URL 全是 __SOURCE_BASE__ 字面量，
    #   导入时报 "must be http(s) absolute"。
    find "$HTML" -type f -name 'config*.json' -exec \
        sed -i "s|__SOURCE_BASE__|${BASE}|g" {} +
    # 校验清单覆盖所有仓的配置与 jar
    ( cd "$HTML" && find . -type f \( -name 'config*.json' -o -name '*.jar' \) \
        | sort | xargs sha256sum > SHA256SUMS.txt )
fi
