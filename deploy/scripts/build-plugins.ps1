# 只构建插件 + 插件源清单（单链路）。
#
# 为什么单独一个脚本：插件列表原本写死在三个地方
#   ① deploy/scripts/release.ps1 的 foreach 数组
#   ② .github/workflows/_pc_plugins.yml 的四个独立 step
#   ③ deploy/README.md 的枚举
# 改一处忘两处就是"文档记录不及时"的根因。现在统一读 deploy/units.json。
#
# 用法：
#   ./deploy/scripts/build-plugins.ps1                    # 全量插件 + packages 清单
#   ./deploy/scripts/build-plugins.ps1 -OutDir tmp/plug   # 指定输出目录
#   ./deploy/scripts/build-plugins.ps1 -Only drpy,ffmpeg  # 只构建指定插件
#   ./deploy/scripts/build-plugins.ps1 -NoIndex           # 不生成 packages 清单
#
# 退出码：必需插件失败 => 非 0；可选插件失败只警告（CI 里 ffmpeg 下载常失败，
# 不该因此让整次发版红掉）。

param(
    # packages 清单与 zip 的输出目录（默认 server/release）
    [string]$OutDir = '',
    # 只构建这些插件 id（逗号分隔）；空 = 全部
    [string[]]$Only,
    [switch]$NoIndex
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$unitsPath = Join-Path $root 'deploy/units.json'
if (-not (Test-Path $unitsPath)) { throw "找不到构建单元清单：$unitsPath" }
$units = [IO.File]::ReadAllText($unitsPath) | ConvertFrom-Json

$sw = [Diagnostics.Stopwatch]::StartNew()
$built = @()
$skipped = @()
$warned = @()

Write-Host "构建单元清单：deploy/units.json（$($units.plugins.Count) 个插件）" -ForegroundColor Cyan

foreach ($u in $units.plugins) {
    # -Only 过滤
    if ($Only -and $Only.Count -gt 0 -and $Only -notcontains $u.id) { continue }

    $script = Join-Path $root $u.script
    if (-not (Test-Path $script)) {
        if ($u.required) { throw "缺少必需插件脚本：$($u.script)" }
        Write-Host "  跳过 $($u.id)（脚本不存在）" -ForegroundColor DarkYellow
        $skipped += $u.id
        continue
    }

    # 可选插件的前置（danmu 需要不入库的上游源码）
    if ($u.needs -and -not (Test-Path (Join-Path $root $u.needs))) {
        if ($u.required) { throw "$($u.id) 缺少前置：$($u.needs)" }
        Write-Host "  跳过 $($u.id)（缺 $($u.needs)）" -ForegroundColor DarkYellow
        $skipped += $u.id
        continue
    }

    Write-Host "`n=== $($u.id) → $($u.script)" -ForegroundColor Cyan
    $stepSw = [Diagnostics.Stopwatch]::StartNew()
    # ★ 必须起子进程：同进程 & 调用后 $LASTEXITCODE 不可靠，
    #   会读到上一次无关命令的码（表现为插件明明构建成功却被记成"失败"）。
    # ★ 平台差异（2026-11 实测）：CI 的插件链已搬到 Linux，那里只有 pwsh；
    #   -ExecutionPolicy 也只在 Windows 认。写死 powershell 会直接
    #   "The term 'powershell' is not recognized"。
    if ($IsWindows -or $env:OS -eq 'Windows_NT') {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script
    } else {
        & pwsh -NoProfile -File $script
    }
    $stepSw.Stop()

    if ($LASTEXITCODE -ne 0) {
        if ($u.required) { throw "$($u.id) 构建失败（必需插件）" }
        Write-Host "  ! $($u.id) 构建失败，继续（非必需）" -ForegroundColor Yellow
        $warned += $u.id
        continue
    }
    Write-Host ("  {0:m\:ss}" -f $stepSw.Elapsed) -ForegroundColor DarkGray
    $built += $u.id
}

if (-not $NoIndex) {
    $indexScript = Join-Path $root $units.index.script
    if (-not (Test-Path $indexScript)) { throw "缺少清单脚本：$($units.index.script)" }
    Write-Host "`n=== 生成 packages 清单 → $($units.index.script)" -ForegroundColor Cyan
    # 显式分支而不是 @idxArgs splatting：splatting 配 -File 时参数容易错位，
    # 实测把父进程的 $built 冲成空（小结显示"已构建："为空）。
    if ($OutDir) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $indexScript -OutDir $OutDir
    } else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $indexScript
    }
    if ($LASTEXITCODE -ne 0) { throw '插件清单生成失败' }
}

$sw.Stop()

Write-Host "`n===== 小结 =====" -ForegroundColor Green
Write-Host "  已构建：$($built -join ', ')"
if ($skipped.Count) { Write-Host "  已跳过：$($skipped -join ', ')（缺前置或脚本）" -ForegroundColor DarkYellow }
if ($warned.Count)  { Write-Host "  有警告：$($warned -join ', ')（非必需，失败不阻断）" -ForegroundColor Yellow }
Write-Host "  总耗时：$([int]$sw.Elapsed.TotalSeconds) 秒"
