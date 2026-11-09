# 清理"测试用"浏览器进程（headless Edge/Chrome）。
#
# 为什么需要它（2026-11-04 事故）：
#   用 `msedge --headless=new --user-data-dir=tmp/...` 反复起浏览器做 CDP 测试，
#   收尾只 kill 了启动器进程。Windows 上 `Popen.terminate()` / `proc.kill()`
#   只杀父进程，**不杀进程树**——renderer/GPU/network 子进程继续占着内存与
#   临时端口。当天累计把提交内存（commit）顶到 124.5 / 124.75 GiB，Edge 报
#   0xE0000008（Chromium 的 OOM 码），系统弹"虚拟内存不足"。
#
# 安全边界：
#   只匹配命令行里 `--user-data-dir=` 指向**仓库 tmp/ 下**的浏览器，
#   用户自己的 Edge（profile 在 AppData\Local\Microsoft\Edge\User Data）
#   永远不会命中。默认只列不杀，必须显式加 -Kill。
#
# 用法：
#   powershell -NoProfile -File smoke/kill-test-edge.ps1              # 只看
#   powershell -NoProfile -File smoke/kill-test-edge.ps1 -Kill        # 清理
#   powershell -NoProfile -File smoke/kill-test-edge.ps1 -Roots 'C:\x' -Kill
# 不注册系统计划任务：由测试脚本在 finally 里调用（Python 用 smoke/edge_session.py）。
param(
    [string[]]$Roots = @(),
    [switch]$Kill,
    # 只处理启动超过 N 分钟的实例；0 = 全部。
    # 给计划任务用：-Kill -OlderThanMinutes 60 只清跑了很久还在的泄漏实例，
    # 不会打断正在进行的一次测试。
    [int]$OlderThanMinutes = 0,
    # 杀掉后顺手删掉 profile 目录（tmp/ 下的测试产物，可重建）。
    # 默认关：排查问题时 often 需要留着现场。
    [switch]$RemoveProfiles
)

$repo = Split-Path -Parent $PSScriptRoot
$roots = if ($Roots.Count -gt 0) { $Roots } else { @((Join-Path $repo 'tmp')) }
$roots = $roots | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') + '\' }

$procs = Get-CimInstance Win32_Process -Filter "name='msedge.exe' or name='chrome.exe'" -ErrorAction SilentlyContinue
$hits = @()
foreach ($p in $procs) {
    $cl = [string]$p.CommandLine
    if ($cl -notmatch 'user-data-dir=("[^"]+"|[^\s]+)') { continue }
    $dir = $Matches[1].Trim('"')
    $matched = $null
    foreach ($r in $roots) {
        if ($dir.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { $matched = $r; break }
    }
    if (-not $matched) { continue }
    $hits += [pscustomobject]@{
        Pid      = $p.ProcessId
        Headless = if ($cl -like '*--headless*') { 'yes' } else { 'no' }
        MB       = [int]((Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).WS / 1MB)
        Profile  = $dir
    }
}

if ($OlderThanMinutes -gt 0 -and $hits.Count -gt 0) {
    $cutoff = (Get-Date).AddMinutes(-$OlderThanMinutes)
    $hits = @($hits | Where-Object {
        $pr = Get-Process -Id $_.Pid -ErrorAction SilentlyContinue
        $pr -and $pr.StartTime -lt $cutoff
    })
}

if (-not $hits) {
    Write-Host "没有指向仓库 tmp/ 的测试浏览器进程。" -ForegroundColor Green
    exit 0
}

$hits | Sort-Object MB -Descending | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
$totalMB = ($hits | Measure-Object MB -Sum).Sum
Write-Host ("共 {0} 个进程，约 {1} MB 工作集。" -f $hits.Count, $totalMB) -ForegroundColor Yellow

if (-not $Kill) {
    Write-Host "只列不杀。确认后加 -Kill 执行（会连同子进程一起结束）。" -ForegroundColor DarkGray
    exit 0
}

foreach ($h in $hits) {
    # /T 杀进程树：缺了它就是本次事故的根因
    & taskkill /PID $h.Pid /T /F 2>&1 | Out-Null
    Write-Host ("  killed {0} (tree)" -f $h.Pid) -ForegroundColor DarkGray
}

if ($RemoveProfiles) {
    $freed = 0
    foreach ($dir in ($hits.Profile | Sort-Object -Unique)) {
        try {
            $mb = 0
            if (Test-Path $dir) {
                $mb = [int](((Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue |
                    Measure-Object Length -Sum).Sum) / 1MB)
            }
            Remove-Item $dir -Recurse -Force -ErrorAction Stop
            $freed += $mb
            Write-Host ("  removed profile {0} (~{1} MB)" -f $dir, $mb) -ForegroundColor DarkGray
        } catch {
            Write-Host ("  ! 删不掉 {0}: {1}" -f $dir, $_.Exception.Message) -ForegroundColor Yellow
        }
    }
    Write-Host ("已删除 profile，释放约 {0} MB。" -f $freed) -ForegroundColor Green
}
Write-Host "已清理。" -ForegroundColor Green
