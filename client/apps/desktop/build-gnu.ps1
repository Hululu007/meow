# 构建 Tauri 桌面版（GNU 工具链，完全不需要 MSVC）
#
# Windows 上的坑：
#  1. Git for Windows 自带 coreutils 的 link.exe，会抢占 MSVC 的 linker
#  2. 默认 rustup toolchain 是 *-msvc，导致 build script 也去找 MSVC
# 解法：使用 GNU host toolchain + MinGW，并把 Git\usr\bin 从 PATH 移除
$ErrorActionPreference = 'Stop'

# MinGW 位置因安装方式而异，按顺序探测：
#   1. 环境变量 MINGW_BIN（最省事，随便装哪都能用）
#   2. winget 安装的 WinLibs 包（路径里带哈希目录，只能 glob）
#   3. PATH 上已有 x86_64-w64-mingw32-gcc
$mingw = $null
if ($env:MINGW_BIN -and (Test-Path "$env:MINGW_BIN\x86_64-w64-mingw32-gcc.exe")) {
    $mingw = $env:MINGW_BIN
}
if (-not $mingw) {
    $hit = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'BrechtSanders.WinLibs*' } |
        ForEach-Object { Get-ChildItem $_.FullName -Directory -Recurse -ErrorAction SilentlyContinue } |
        Where-Object { Test-Path (Join-Path $_.FullName 'bin\x86_64-w64-mingw32-gcc.exe') } |
        Select-Object -First 1
    if ($hit) { $mingw = Join-Path $hit.FullName 'bin' }
}
if (-not $mingw) {
    $gcc = Get-Command x86_64-w64-mingw32-gcc -ErrorAction SilentlyContinue
    if ($gcc) { $mingw = Split-Path $gcc.Source }
}

if (-not $mingw -or -not (Test-Path "$mingw\x86_64-w64-mingw32-gcc.exe")) {
    throw "MinGW not found. Install: winget install BrechtSanders.WinLibs.POSIX.UCRT`n或者把 MINGW_BIN 设成 mingw64\bin 的绝对路径。"
}
$cargo = "$env:USERPROFILE\.cargo\bin"

# 剔除 Git 的 usr/bin（里面有冲突的 link.exe），其余保留
$parts = $env:PATH -split ';' | Where-Object { $_ -and ($_ -notlike '*Git\usr\bin*') }
$env:PATH = (@($mingw, $cargo) + $parts) -join ';'

# npx 需要 node。PATH 过滤后若丢了 node，从常见的 npm 全局位置补回来
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeDir = Split-Path (Get-Command npm -ErrorAction SilentlyContinue).Source -ErrorAction SilentlyContinue
    if ($nodeDir -and (Test-Path (Join-Path $nodeDir 'node.exe'))) {
        $env:PATH = "$nodeDir;$env:PATH"
    }
}

# 让 cargo 用 GNU host toolchain
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "$mingw\x86_64-w64-mingw32-gcc.exe"
$env:CC_x86_64_pc_windows_gnu  = "$mingw\x86_64-w64-mingw32-gcc.exe"
$env:CXX_x86_64_pc_windows_gnu = "$mingw\x86_64-w64-mingw32-g++.exe"
$env:AR_x86_64_pc_windows_gnu  = "$mingw\x86_64-w64-mingw32-ar.exe"

Set-Location $PSScriptRoot
Write-Host "toolchain: $env:RUSTUP_TOOLCHAIN"
Write-Host "gcc      : $mingw\x86_64-w64-mingw32-gcc.exe"
Write-Host "building : x86_64-pc-windows-gnu"

# ★ MEOW_SKIP_WEB_BUILD=1：跳过 tauri.conf.json 的 beforeBuildCommand。
#   它是 `pnpm --filter @meow/web build`（含 vue-tsc），而 CI 的 web job 已经
#   建过 dist 并用 artifact 传进来了 —— 再跑一遍纯浪费（2026-11-13 实测 30s），
#   而且 PC 包里打包的就变成"PC 自己重建的那份"，四端前端字节不再一致。
#   用 config 文件覆盖（而不是空串）：空串的行为各版本不稳，no-op 命令最安全。
#   本地不带这个环境变量，行为与以前完全一致。
$cfgArgs = @()
$tmpCfg = $null
if ($env:MEOW_SKIP_WEB_BUILD -eq '1') {
    $tmpCfg = Join-Path $PSScriptRoot '.tauri.ci.json'
    '{ "build": { "beforeBuildCommand": "echo skip-web-build: reuse dist from artifact" } }' |
        Set-Content -Path $tmpCfg -Encoding utf8
    $cfgArgs = @('--config', $tmpCfg)
    Write-Host 'beforeBuildCommand 已覆盖为 no-op（复用 web job 的 dist）'
}

try {
    $common = @('--target', 'x86_64-pc-windows-gnu') + $cfgArgs
    if ($args.Count -gt 0) {
        & npx tauri build @common @args
    } else {
        & npx tauri build @common --no-bundle
    }
} finally {
    if ($tmpCfg) { Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue }
}
