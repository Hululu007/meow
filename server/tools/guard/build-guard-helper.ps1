# 编译加密 Guard 子进程（unidbg + dex2jar + 字节码修复），产物进 guard-libs/。
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$libs = Join-Path $root '..\..\host\guard-libs'
$classes = Join-Path $root 'build\classes'
if (Test-Path $classes) { Remove-Item $classes -Recurse -Force }
New-Item -ItemType Directory -Path $classes -Force | Out-Null
$src = Get-ChildItem -Path (Join-Path $root 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$argsFile = Join-Path $root 'build\sources.txt'
New-Item -ItemType Directory -Path (Join-Path $root 'build') -Force | Out-Null
[System.IO.File]::WriteAllLines($argsFile, $src, [System.Text.Encoding]::ASCII)
$javac = cmd /c "javac -encoding UTF-8 -cp ""$libs\*"" -d ""$classes"" @""$argsFile"" 2>&1"
if ($LASTEXITCODE -ne 0) { $javac | Write-Host; throw "guard helper javac failed" }
& jar cf (Join-Path $libs 'guard-helper.jar') -C $classes .
if ($LASTEXITCODE -ne 0) { throw "guard helper jar failed" }
Write-Host "[guard] helper -> $libs\guard-helper.jar" -ForegroundColor Green
