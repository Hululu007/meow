# 打包 pyrt 运行时插件：server/pyrt/ -> build/plugins/pyrt/
#
# 与 drpy 的差别只有一处：drpy 把 node_modules 装进包，pyrt 把 Python 依赖
# 装进 vendor/（pip --target）。理由相同——用户不该为了一个插件先自己 pip install。
#
# ★ Python **解释器也打进包里**（python/，官方 embeddable 11MB）：
#   对齐 node 插件的做法（danmu 插件把 node.exe 拷进 plugins/node/，用户零依赖）。
#   这条尤其重要，因为 vendor 里的 C 扩展绑**次版本号**（*.cp312-win_amd64.pyd）——
#   让用户自己装 Python，就得让他的次版本和构建机一致，3.10 / 3.13 全会 ImportError。
#
# ★ 源脚本（scripts/py）**不进插件包**：那是私有内容（与 spider.jar 同性质），
#   由源包导入到 {appData}/py-scripts。插件包只带加载器 + 基类契约。
#
# 用法： .\build-plugin-pyrt.ps1 [-Clean] [-SkipPython]
param(
    [switch]$Clean,
    # 不内嵌解释器（只打 vendor）。仅本地排查用；发版必须内嵌。
    [switch]$SkipPython
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root 'pyrt'
$out = Join-Path $root 'build\plugins\pyrt'

# ★ 这两个版本必须成对：vendor 里的 C 扩展是 cp312，内嵌解释器也必须是 3.12.x。
#   只改一个 → 用户机器上 ImportError，而日志要等 20 秒健康检查失败后才出现。
$PySeries = '3.12'
$PyFull = '3.12.8'

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

# ---------------------------------------------------------------- 找 pip
# ★ 不要求构建机的 Python 是 3.12：下面用 --python-version 3.12 跨版本挑 wheel，
#   任何 Python 3 的 pip 都能做（实测 3.10 的 pip 拉出 cp312 的 .pyd）。
#   好处是 CI（setup-python 3.12）和本地（3.10 / 3.11 …）产出完全一致。
# ★ 也不能裸调 `python`：CI 的 windows runner 上它可能是 Microsoft Store 别名
#   （调用即失败、报错指向商店）。逐个探一遍，探不到就明确抛错 —— 这条脚本在
#   units.json 里是 required:false，失败会被 build-plugins.ps1 静默跳过。
$pyExe = $null; $pyPre = @()
if ($env:PYRT_PYTHON) {
    $parts = $env:PYRT_PYTHON -split '\s+'
    $pyExe = $parts[0]; $pyPre = @($parts | Select-Object -Skip 1)
    Write-Host "  使用 PYRT_PYTHON=$env:PYRT_PYTHON" -ForegroundColor DarkGray
}
if (-not $pyExe) {
    foreach ($cand in @(@('python'), @('py', '-3'), @('python3'))) {
        $exe = $cand[0]; $pre = @($cand | Select-Object -Skip 1)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        $v = & $exe @pre -c "import sys;print(sys.version_info[0])" 2>$null
        if ($LASTEXITCODE -eq 0 -and "$v".Trim() -eq '3') { $pyExe = $exe; $pyPre = $pre; break }
    }
}
if (-not $pyExe) {
    throw "找不到可用的 Python 3（试过 python / py -3 / python3）。它只用来跑 pip 下载 wheel，装任意 3.x 都行。"
}
Write-Host "  使用 $pyExe $($pyPre -join ' ')（仅用于 pip）" -ForegroundColor DarkGray

# ---------------------------------------------------------------- vendor
Write-Host "  安装依赖（requests / bs4 / lxml / pyquery / pycryptodome）…"
$vendor = Join-Path $out 'vendor'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Push-Location $out
try {
    # --python-version/--platform/--implementation：只挑 cp312-win_amd64 的 wheel，
    #   不运行、不编译，所以宿主版本无关。--only-binary 保证不会拿源码包现场编译。
    # --target 装到 vendor：pyrt.py 启动时把 vendor 插到 sys.path 最前。
    & $pyExe @pyPre -m pip install --no-compile --target "$vendor" `
        --python-version $PySeries --only-binary :all: `
        --platform win_amd64 --implementation cp `
        -r requirements.txt -q
    if ($LASTEXITCODE -ne 0) { throw "pip install 失败（exit $LASTEXITCODE）" }
} finally {
    Pop-Location
}

# 版本一致性：带 cpNNN 后缀的 .pyd 必须全是本系列（pycryptodome 的 pyd 不带版本号，
# 所以只校验带后缀的那些）。
$pyTag = 'cp' + $PySeries.Replace('.', '')
$bad = @(Get-ChildItem $vendor -Recurse -Filter '*.pyd' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.cp\d+' -and $_.Name -notmatch $pyTag })
if ($bad.Count -gt 0) {
    throw "vendor 里混进了非 $pyTag 的 C 扩展（$($bad[0].Name)）：内嵌解释器会 import 失败"
}

# ---------------------------------------------------------------- 内嵌解释器
if (-not $SkipPython) {
    Write-Host "  内嵌 Python $PyFull（官方 embeddable）…"
    $cache = Join-Path $root 'build\.deps'
    $zipName = "python-$PyFull-embed-amd64.zip"
    $zip = Join-Path $cache $zipName
    if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 5MB) {
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        # 顺序：npmmirror（国内快）→ 华为云 → 官方（最权威但境外慢）
        $urls = @(
            "https://registry.npmmirror.com/-/binary/python/$PyFull/$zipName",
            "https://mirrors.huaweicloud.com/python/$PyFull/$zipName",
            "https://www.python.org/ftp/python/$PyFull/$zipName"
        )
        $ok = $false
        foreach ($u in $urls) {
            try {
                Write-Host "    下载 $u"
                Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing -TimeoutSec 300
                if ((Get-Item $zip).Length -gt 5MB) { $ok = $true; break }
            } catch {
                Write-Host "    失败：$($_.Exception.Message)" -ForegroundColor DarkYellow
            }
        }
        if (-not $ok) { throw "下载 $zipName 失败（npmmirror / 华为云 / python.org 都不通）" }
    }
    $pyDir = Join-Path $out 'python'
    if (Test-Path $pyDir) { Remove-Item $pyDir -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $pyDir -Force

    $embedded = Join-Path $pyDir 'python.exe'
    if (-not (Test-Path $embedded)) { throw "embeddable 包里没有 python.exe" }

    # ★ 自检：用**内嵌解释器**把 vendor 全 import 一遍。这是唯一能提前发现
    #   "版本对不上 / 缺 DLL / 少 wheel"的检查 —— 没有它，错误会留到用户机器上，
    #   症状是「插件装好了但源跑不了」。
    Write-Host "  自检：内嵌解释器 import vendor …"
    $probeFile = Join-Path $out '.probe.py'
    $probe = @"
import os, sys
sys.path.insert(0, os.path.join(os.getcwd(), 'vendor'))
import requests, bs4, lxml.etree, pyquery, Crypto
print('ok', sys.version.split()[0], 'lxml', lxml.etree.__version__)
"@
    [System.IO.File]::WriteAllText($probeFile, $probe, (New-Object System.Text.UTF8Encoding $false))
    Push-Location $out
    try {
        $res = & $embedded $probeFile 2>&1
        if ($LASTEXITCODE -ne 0) { throw "内嵌解释器跑不起来：$res" }
        Write-Host "    $res" -ForegroundColor DarkGray
    } finally {
        Pop-Location
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    }
}

$mb = [math]::Round((Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "  pyrt 插件: ${mb}MB → $out" -ForegroundColor Green
