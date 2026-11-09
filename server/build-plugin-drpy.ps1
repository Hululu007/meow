# 打包 drpy 运行时插件：server/drpy/ -> build/plugins/drpy/（含 node_modules）
#
# 为什么需要这一步：drpy 的运行时代码是**我们自己的源码**（可入库），
# 而 build/plugins/ 整体被 .gitignore 排除（构建产物）。所以发布前必须
# 从源码目录复制一次，并把依赖装进去——否则插件 zip 里没有 cheerio。
#
# 用法： .\build-plugin-drpy.ps1 [-Clean]
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'drpy'
$out = Join-Path $root 'build\plugins\drpy'

if (-not (Test-Path $src)) { throw "找不到源码目录：$src" }
if ($Clean -and (Test-Path $out)) { Remove-Item $out -Recurse -Force }

New-Item -ItemType Directory -Force -Path $out | Out-Null

# ★ worker.js 必须在清单里。
# 它是 drpy 的 worker 线程执行体（server.js 用 `new Worker(join(__dirname,'worker.js'))`
# 加载）。漏了它包能打出来、容器能起，但**每个源调用都会失败**：
# `Cannot find module .../worker.js`，症状是所有 .js 源返回空结果。
foreach ($f in @('server.js', 'worker.js', 'host.js', 'package.json', 'package-lock.json', 'README.md')) {
    if (-not (Test-Path (Join-Path $src $f))) {
        throw "缺少必需文件：$f（drpy 插件打不全会静默丢源）"
    }
    Copy-Item (Join-Path $src $f) (Join-Path $out $f) -Force
}
# manifest 由 plugin-manifests 统一维护（和其他插件同一套来源）。
# release 脚本按 build/plugins/<id>/manifest.json 取版本，缺了会打成 0.0.0。
$mf = Join-Path $root 'plugin-manifests\drpy.manifest.json'
if (Test-Path $mf) { Copy-Item $mf (Join-Path $out 'manifest.json') -Force }
if (Test-Path (Join-Path $src 'lib')) {
    Copy-Item (Join-Path $src 'lib') (Join-Path $out 'lib') -Recurse -Force
}

Write-Host "  安装依赖（cheerio / sync-fetch / crypto-js）…"
Push-Location $out
try {
    npm install --omit=dev --no-audit --no-fund | Out-Null
} finally {
    Pop-Location
}

$mb = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "  drpy 插件: ${mb}MB → $out" -ForegroundColor Green
