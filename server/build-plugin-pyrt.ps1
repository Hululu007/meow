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

# ★ 不能裸调 `python`：CI 的 windows runner 上它可能是 Microsoft Store 别名
#   （调用即失败，且报错指向商店而不是缺 Python），也可能只有 `py -3`。
#   这条脚本在 units.json 里是 required:false —— 失败会被 build-plugins.ps1
#   静默跳过，Release 里就没有 pyrt-*.zip，而应用内只是"看不到这个插件"，
#   完全没有线索。所以这里逐个探一遍，探不到就明确抛错。
$pyExe = $null; $pyPre = @()

# 显式覆盖：vendor 里的 C 扩展绑**次版本号**，本地用 3.10 打、发行用 3.12 打，
# 会得到两个互不兼容的包。要对齐发行版就设 PYRT_PYTHON=py -3.12 再跑。
if ($env:PYRT_PYTHON) {
    $parts = $env:PYRT_PYTHON -split '\s+'
    $pyExe = $parts[0]
    $pyPre = @($parts | Select-Object -Skip 1)
    Write-Host "  使用 PYRT_PYTHON=$env:PYRT_PYTHON" -ForegroundColor DarkGray
}
if (-not $pyExe) {
foreach ($cand in @(@('python'), @('py', '-3'), @('python3'))) {
    $exe = $cand[0]
    $pre = @($cand | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    $ver = & $exe @pre -c "import sys;print(sys.version_info[0])" 2>$null
    if ($LASTEXITCODE -eq 0 -and "$ver".Trim() -eq '3') { $pyExe = $exe; $pyPre = $pre; break }
}
}
if (-not $pyExe) {
    throw "找不到可用的 Python 3（试过 python / py -3 / python3）。装了 Python 3 再跑，否则 pyrt 插件不会出现在 Release 里。"
}
Write-Host "  使用 $pyExe $($pyPre -join ' ')" -ForegroundColor DarkGray

Push-Location $out
try {
    # --target 装到 vendor：pyrt.py 启动时把 vendor 插到 sys.path 最前
    & $pyExe @pyPre -m pip install --no-compile --target "$vendor" -r requirements.txt -q
    if ($LASTEXITCODE -ne 0) { throw "pip install 失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

$mb = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "  pyrt 插件: ${mb}MB → $out" -ForegroundColor Green
