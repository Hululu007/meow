# 构建 danmu-api 插件（Node 服务 + 内嵌 node 运行时）
#
# 产物（与 build-plugin.ps1 统一到 build/plugins/）：
#   build/plugins/
#   ├── danmu-api/
#   │   ├── manifest.json
#   │   ├── danmu_api/          ← 服务源码
#   │   ├── node_modules/       ← 依赖（纯 JS，无原生模块）
#   │   ├── config/             ← 配置模板
#   │   └── package.json
#   └── node/
#       └── node.exe            ← 内嵌运行时（可选，没有就用系统 node）
#
# 为什么不做成单文件 exe：
#   danmu_api 依赖 9000+ 个 node_modules 文件，打包成单文件要么用 pkg/nexe
#   （对 ESM + 动态 import 支持差），要么自己实现模块解析。
#   直接放目录 + 内嵌 node.exe 更可靠，也便于用户看日志、改 config/.env。
#
# 与其他插件的关系：
#   本插件是**可选**的。没装时 apiserver 自动降级为官方源（爱奇艺直连）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build-plugin-danmu.ps1
#   powershell -ExecutionPolicy Bypass -File build-plugin-danmu.ps1 -SkipNode  # 不内嵌 node

param(
    [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# 源码在 research/upstream/（上游参考，浅克隆，不入库）
$src  = Join-Path $root '..\research\upstream\danmu_api'
$out  = Join-Path $root 'build\plugins\danmu-api'
$nodeOut = Join-Path $root 'build\plugins\node'

if (-not (Test-Path $src)) {
    throw "找不到 danmu_api 源码：$src`n请先浅克隆到 research/upstream/danmu_api"
}

Write-Host "[1/4] 校验源码..." -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $src 'danmu_api\server.js'))) {
    throw "源码结构不对：缺少 danmu_api/server.js"
}
if (-not (Test-Path (Join-Path $src 'node_modules'))) {
    throw "缺少 node_modules，请先在 research/upstream/danmu_api 执行 npm install"
}
# 纯 JS 才能直接复制；有 .node 原生模块就要考虑 ABI 与平台匹配
$nativeCount = (Get-ChildItem (Join-Path $src 'node_modules') -Recurse -Filter '*.node' -ErrorAction SilentlyContinue | Measure-Object).Count
if ($nativeCount -gt 0) {
    Write-Host "  警告：发现 $nativeCount 个原生模块（.node），跨机器可能不兼容" -ForegroundColor DarkYellow
} else {
    Write-Host "  纯 JS 依赖，可安全复制" -ForegroundColor Green
}

Write-Host "[2/4] 复制文件（并裁剪无用依赖）..." -ForegroundColor Yellow
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Path $out -Force | Out-Null

# 只复制运行所需，排除开发/部署产物
# 运行时不需要的开发/部署产物。★ 上游仓库里的 .github / .gitignore /
# .pr_agent.toml / .devcontainer 等会被一概复制进插件 zip（实测 zip 里
# 混进 9 个这类条目，用户装完看到一个带 CI 配置的插件目录）。
# 用前缀判断而不是逐个列名：上游随时可能新增 .xxx 文件。
$exclude = @('node-functions', 'netlify', 'vercel.json', 'netlify.toml',
             'wrangler.toml', 'edgeone.json', 'forward', '.git', 'test', 'tests')
Get-ChildItem $src -Force | Where-Object {
    # 跳过所有点开头的隐藏项（.git/.github/.gitignore/.pr_agent.toml/.devcontainer…）
    # 它们只服务上游仓库，运行时用不到
    -not $_.Name.StartsWith('.') -and $exclude -notcontains $_.Name
} | ForEach-Object {
    Copy-Item $_.FullName -Destination $out -Recurse -Force -ErrorAction SilentlyContinue
}

# 裁掉 danmu_api/ 从不引用的重型包。
# 实测依据（grep 引用数）：
#   @electric-sql  36MB  引用 0 次  → 删
#   drizzle-orm    25MB  引用 0 次  → 删
#   @esbuild       11MB  引用 0 次  → 删
#   redis         7.7MB  引用 1 次  → 必须保留
# 裁剪后 116MB → 47MB，实测健康检查 200、真实搜索 203 条候选，
# 无 MODULE_NOT_FOUND。
$drop = @('@electric-sql', 'drizzle-orm', '@esbuild')
foreach ($d in $drop) {
    $p = Join-Path $out "node_modules\$d"
    if (Test-Path $p) {
        Remove-Item $p -Recurse -Force
        Write-Host "  裁剪 node_modules/$d" -ForegroundColor DarkGray
    }
}

$files = (Get-ChildItem $out -Recurse -File | Measure-Object).Count
$sizeMb = [math]::Round(((Get-ChildItem $out -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "  danmu-api: ${sizeMb}MB / $files 个文件（裁剪后）" -ForegroundColor Green

Write-Host "[3/4] 内嵌 node 运行时..." -ForegroundColor Yellow
if ($SkipNode) {
    Write-Host "  跳过（-SkipNode），将使用系统 node" -ForegroundColor DarkYellow
} else {
    $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe) {
        Write-Host "  找不到 node，跳过内嵌；用户机器必须有 node 才能启用此插件" -ForegroundColor DarkYellow
    } else {
        New-Item -ItemType Directory -Path $nodeOut -Force | Out-Null
        Copy-Item $nodeExe (Join-Path $nodeOut 'node.exe') -Force
        $nodeMb = [math]::Round((Get-Item (Join-Path $nodeOut 'node.exe')).Length / 1MB, 1)
        Write-Host "  node.exe: ${nodeMb}MB（来自 $nodeExe）" -ForegroundColor Green
    }
}

Write-Host "[4/4] 写入 manifest..." -ForegroundColor Yellow
Copy-Item (Join-Path $root 'plugin-manifests\danmu-api.manifest.json') (Join-Path $out 'manifest.json') -Force
Write-Host "  manifest.json 已写入" -ForegroundColor Green

Write-Host "`n完成: $out" -ForegroundColor Cyan
Write-Host "提示：此插件默认 enabled=false，需在设置页手动开启。" -ForegroundColor DarkGray
