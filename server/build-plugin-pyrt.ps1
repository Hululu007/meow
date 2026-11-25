# 打包 pyrt 运行时插件：server/pyrt/ -> build/plugins/pyrt/
#
# 与 drpy 的差别只有一处：drpy 把 node_modules 装进包，pyrt 把 Python 依赖
# 装进 vendor/（pip --target）。理由相同——用户不该为了一个插件先自己 pip install。
#
# ★ 源脚本（scripts/py）**不进插件包**：那是私有内容（与 spider.jar 同性质），
#   由源包导入到 {appData}/py-scripts。插件包只带加载器 + 基类契约。
#
# 用法： .\build-plugin-pyrt.ps1 [-Clean]
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'pyrt'
$out = Join-Path $root 'build\plugins\pyrt'

if (-not (Test-Path $src)) { throw "找不到源码目录：$src" }
if ($Clean -and (Test-Path $out)) { Remove-Item $out -Recurse -Force }

New-Item -ItemType Directory -Force -Path $out | Out-Null

foreach ($f in @('pyrt.py', 'requirements.txt', 'README.md')) {
    if (-not (Test-Path (Join-Path $src $f))) {
        throw "缺少必需文件：$f（pyrt 插件打不全会静默起不来）"
    }
    Copy-Item (Join-Path $src $f) (Join-Path $out $f) -Force
}

# 基类契约必须带上：源脚本 `from base.spider import Spider` 靠它
$base = Join-Path $src 'scripts\base'
if (-not (Test-Path $base)) { throw "缺少 scripts/base（源脚本的 ImportError 全靠它）" }
New-Item -ItemType Directory -Force -Path (Join-Path $out 'scripts') | Out-Null
Copy-Item $base (Join-Path $out 'scripts\base') -Recurse -Force

# manifest 由 plugin-manifests 统一维护；release 按 build/plugins/<id>/manifest.json 取版本
$mf = Join-Path $root 'plugin-manifests\pyrt.manifest.json'
if (Test-Path $mf) { Copy-Item $mf (Join-Path $out 'manifest.json') -Force }

Write-Host "  安装依赖（requests / bs4 / lxml / pyquery / pycryptodome）…"
$vendor = Join-Path $out 'vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Push-Location $out
try {
    # --target 装到 vendor：pyrt.py 启动时把 vendor 插到 sys.path 最前
    python -m pip install --no-compile --target "$vendor" -r requirements.txt -q
    if ($LASTEXITCODE -ne 0) { throw "pip install 失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

$mb = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "  pyrt 插件: ${mb}MB → $out" -ForegroundColor Green
