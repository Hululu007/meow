# 下载并解压 dex2jar（固定版本 + SHA256）。构建插件/fpk 前调用。
#
#   powershell -File deploy/scripts/fetch-dex2jar.ps1
#   powershell -File deploy/scripts/fetch-dex2jar.ps1 -Dest server/tools/dex2jar
#
# 产物不提交 git（server/tools/ 已忽略）；构建时按需拉取。

param(
    [string]$Dest = '',
    [string]$Version = '2.4'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Dest) { $Dest = Join-Path $root 'server\tools\dex2jar' }
$Dest = [IO.Path]::GetFullPath($Dest)

$lib = Join-Path $Dest 'lib'
if ((Test-Path $lib) -and @(Get-ChildItem $lib -Filter 'dex-tools-*.jar' -ErrorAction SilentlyContinue).Count -gt 0) {
    Write-Host "dex2jar 已存在：$Dest"
    exit 0
}

$url = "https://github.com/pxb1988/dex2jar/releases/download/v$Version/dex-tools-v$Version.zip"
$sha = 'ee7c45eb3c1d2474a6145d8d447e651a736a22d9664b6d3d3be5a5a817dda23a'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("dex2jar-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $zip = Join-Path $tmp 'dex-tools.zip'
    Write-Host "下载 dex2jar v$Version ..."
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $sha.ToLowerInvariant()) {
        throw "dex2jar SHA256 不匹配：$actual"
    }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Join-Path $tmp "dex-tools-v$Version"
    if (-not (Test-Path $src)) { throw "解压后找不到 $src" }
    New-Item -ItemType Directory -Path (Split-Path $Dest -Parent) -Force | Out-Null
    if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
    Copy-Item $src $Dest -Recurse -Force
    Write-Host "dex2jar 已安装：$Dest"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
