# 下载并解压 dex2jar（固定版本 + SHA256），然后裁到「Dex2jarCmd 实际可达」的 13 个 jar。
#
#   powershell -File deploy/scripts/fetch-dex2jar.ps1
#   powershell -File deploy/scripts/fetch-dex2jar.ps1 -Dest server/tools/dex2jar
#
# 产物不提交 git（server/tools/ 已忽略）；构建时按需拉取。
#
# 为什么裁、判据是什么、要同步哪几处：见 fetch-dex2jar.sh 顶部注释（同一份白名单）。

param(
    [string]$Dest = '',
    [string]$Version = '2.4'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Dest) { $Dest = Join-Path $root 'server\tools\dex2jar' }
$Dest = [IO.Path]::GetFullPath($Dest)

# 白名单：改这里必须同步 fetch-dex2jar.sh / Dockerfile.apiserver /
# client/apps/fnos/build-fpk.sh 的 jar 数断言（13）。
$KeepJars = @(
    'antlr-runtime-3.5.2.jar',
    'antlr4-runtime-4.9.3.jar',
    'asm-9.5.jar',
    'asm-analysis-9.5.jar',
    'asm-commons-9.5.jar',
    'asm-tree-9.5.jar',
    'asm-util-9.5.jar',
    'd2j-base-cmd-v2.4.jar',
    'dex-ir-v2.4.jar',
    'dex-reader-api-v2.4.jar',
    'dex-reader-v2.4.jar',
    'dex-tools-v2.4.jar',
    'dex-translator-v2.4.jar'
)

# 裁剪 + 自检。已存在的目录也会走一遍（幂等）：老的完整包会被自动瘦身。
function Prune-Lib([string]$Lib) {
    if (-not (Test-Path $Lib)) { return }
    $removed = 0
    foreach ($f in Get-ChildItem $Lib -Filter '*.jar' -File) {
        if ($KeepJars -notcontains $f.Name) {
            Remove-Item $f.FullName -Force
            $removed++
        }
    }
    $miss = @($KeepJars | Where-Object { -not (Test-Path (Join-Path $Lib $_)) })
    if ($miss.Count -gt 0) {
        throw "dex2jar 缺少白名单里的 jar：$($miss -join ', ')（升级了 dex2jar 版本？请重新核对 KeepJars）"
    }
    $bytes = (Get-ChildItem $Lib -File | Measure-Object Length -Sum).Sum
    Write-Host ("dex2jar 裁剪完成：保留 {0} 个 jar，删除 {1} 个（lib {2:N2}MB）" -f $KeepJars.Count, $removed, ($bytes / 1MB))
}

$lib = Join-Path $Dest 'lib'
if ((Test-Path $lib) -and @(Get-ChildItem $lib -Filter 'dex-tools-*.jar' -ErrorAction SilentlyContinue).Count -gt 0) {
    Write-Host "dex2jar 已存在：$Dest（只做裁剪校验）"
    Prune-Lib $lib
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
    Prune-Lib $lib
    Write-Host "dex2jar 已安装：$Dest"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
