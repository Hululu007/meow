#!/usr/bin/env bash
# 准备 iOS 端内 JS 源运行时载荷（drpy）。
#
# 形态与 prepare-danmu-payload.sh 一致：CI 备料 → 落 client/apps/ios/build/drpy →
# 打成 App 资源（project.yml 的 resources）→ 首次启动拷到 Documents → NodeBridge
# 在**同一个 node 进程**里再 require 一次（nodejs-mobile 一进程只能 node_start 一次）。
#
# 与 PC/Docker 的差异（都是 iOS 的硬约束，别照抄回去）：
#   1) undici 必须换成桩：cheerio@1.2 依赖 undici，而 nodejs-mobile 的 V8 没编 WASM，
#      加载真实 undici 会抛 `WebAssembly is not defined` 并带走 App（NodeBridge 有注释）。
#      drpy 抓取走 sync-fetch，不用 cheerio.fromURL，所以桩掉不影响功能。
#   2) 裁剪 sourcemap 与多分发格式：web-streams-polyfill 8.8MB 里 ~4MB 是 .map，
#      es6/es2018 两份目录没人引；裁完载荷从 ~19MB 降到 ~9MB。
#
# 产物：
#   client/apps/ios/build/drpy/                 ← 载荷（含 node_modules）
#   client/apps/ios/build/drpy/.payload-version ← 版本标记（App 判断要不要重拷）
#
# 用法：bash client/apps/ios/scripts/prepare-drpy-payload.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SRC="$ROOT/server/drpy"
BUILD="$ROOT/client/apps/ios/build"
OUT="$BUILD/drpy"

[ -f "$SRC/server.js" ] || { echo "[drpy] 缺 $SRC/server.js" >&2; exit 2; }
[ -f "$SRC/package-lock.json" ] || { echo "[drpy] 缺 package-lock.json（依赖必须锁定）" >&2; exit 2; }

rm -rf "$OUT"
mkdir -p "$OUT"
for f in server.js host.js worker.js package.json package-lock.json; do
  cp "$SRC/$f" "$OUT/$f"
done
[ -d "$SRC/lib" ] && cp -R "$SRC/lib" "$OUT/lib"

echo "[drpy] 安装依赖（--omit=dev --ignore-scripts）"
( cd "$OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )

# ---- undici 桩（见文件头 1）----
rm -rf "$OUT/node_modules/undici"
mkdir -p "$OUT/node_modules/undici"
cat > "$OUT/node_modules/undici/package.json" <<'JSON'
{ "name": "undici", "version": "0.0.0-ios-stub", "main": "index.js" }
JSON
cat > "$OUT/node_modules/undici/index.js" <<'JS'
// iOS 端内桩：nodejs-mobile 的 V8 无 WASM，真实 undici 一加载就抛 ReferenceError。
// drpy 的抓取走 sync-fetch（SharedArrayBuffer + Atomics），不需要 undici。
function nope() { throw new Error('undici stubbed on iOS: use sync-fetch'); }
module.exports = { fetch: nope, request: nope, Agent: nope, setGlobalDispatcher: nope };
JS

# ---- 裁 sourcemap 与多分发格式（见文件头 2）----
find "$OUT/node_modules" -name '*.map' -delete 2>/dev/null || true
WSP="$OUT/node_modules/web-streams-polyfill"
if [ -d "$WSP" ]; then
  rm -rf "$WSP/es6" "$WSP/es2018" "$WSP/ponyfill" 2>/dev/null || true
  # 只留 node 用的 dist（main = dist/polyfill，module = dist/polyfill.mjs）
  find "$WSP/dist" -type f ! -name 'polyfill*' -delete 2>/dev/null || true
  find "$WSP/dist" -type d -empty -delete 2>/dev/null || true
fi
# 其它包的 docs/tests 也顺手清掉（不改变运行期）
find "$OUT/node_modules" -type d \( -name test -o -name tests -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} + 2>/dev/null || true

[ -f "$OUT/server.js" ] || { echo "[drpy] 载荷结构不对：缺 server.js" >&2; exit 2; }
[ -f "$OUT/node_modules/cheerio/package.json" ] || { echo "[drpy] 载荷结构不对：缺 cheerio" >&2; exit 2; }
[ -f "$OUT/node_modules/sync-fetch/package.json" ] || { echo "[drpy] 载荷结构不对：缺 sync-fetch" >&2; exit 2; }

SIZE_KB=$(du -sk "$OUT" | cut -f1)
# 19MB 是未裁的上限；裁完实测 ~9MB。超过 26MB 说明依赖树变了，先看新增大件再放行。
if [ "$SIZE_KB" -gt 26624 ]; then
  echo "[drpy] 载荷超预算：${SIZE_KB}KB > 26624KB（26MB），先查 node_modules 里的新增大件" >&2
  exit 3
fi

# 版本标记：package-lock 与脚本任一变就重拷（与 danmu 的 .payload-version 同语义）
if command -v shasum >/dev/null 2>&1; then
  H=$( { cat "$SRC/package-lock.json"; cat "$0"; } | shasum -a 256 | cut -d' ' -f1 )
else
  H=$( { cat "$SRC/package-lock.json"; cat "$0"; } | sha256sum | cut -d' ' -f1 )
fi
echo "drpy-${H:0:16}" > "$OUT/.payload-version"

echo "[drpy] OK $(du -sh "$OUT" | cut -f1)（未裁基线 19MB）-> $OUT"
