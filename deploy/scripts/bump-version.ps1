# 版本号一键提升 / 一致性校验。
#
# ## 为什么需要这个脚本
#
# 版本号散在 **13 处**，"代码是新的、跑起来是旧行为"的事故里，有两次根因
# 就是漏改（compose 兜底、TV versionCode）。本脚本一次输入，全量替换，
# 替换后逐处回读校验。
#
# ## 覆盖的位置（与 AGENTS.md §4.1 同步维护）
#
#   前端 3× package.json（client / web / desktop）
#   tauri.conf.json + Cargo.toml + Cargo.lock（仅 meow-player 条目）
#   ApiServer.java  VERSION
#   apiserver.manifest.json
#   .env / .env.example  MEOW_VERSION（.env 不入库，存在才改）
#   client/apps/tv/app/build.gradle  versionName + versionCode
#   docker-compose.yml / build.yml / with-sources.yml / standalone.yml
#         MEOW_VERSION 兜底（standalone 是站点「下载即用」那份，
#         靠这里自动跟进发版，站点构建重建时下载到的就是当前版本）
#   fnOS：fpk/manifest 的 version + meowd 的 Cargo.toml/Cargo.lock
#         （meowd 用 CARGO_PKG_VERSION 报 /api/health，漏改会出现
#          "manifest 1.1.6、页面 1.1.5" 这种永远提示可升级的假象）
#
# versionCode 规则：major*1000 + minor*100 + patch（0.9.12 → 912）。
# 1.0.0 会变成 1000，大于所有 0.x，符合 Android「只能增大」的要求。
#
# ## 用法
#
#   .\bump-version.ps1 -Check                    # 只校验当前树是否一致
#   .\bump-version.ps1 -Version 0.9.13           # 提升版本
#   .\bump-version.ps1 -Version 0.9.13 -DryRun   # 预演，不写盘
#
# 不做 git 提交——提交节奏由人控制（AGENTS.md §三）。
# 跨脚本调用请用 `powershell -NoProfile -File`：脚本用 exit 表达结果，
# 同进程 `&` 调用会把整个会话带崩。

param(
    [string]$Version,
    [switch]$Check,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# 仓库根：脚本在 deploy/scripts/，退两层才是根（client/ server/ docs/ 所在处）
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Read-Text([string]$Path) {
    # ReadAllText 自动剥 BOM；写回时按原文件的 BOM 有无还原，避免 diff 噪音
    $bytes = [IO.File]::ReadAllBytes($Path)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    return @{ Text = [IO.File]::ReadAllText($Path); Bom = $bom }
}

function Write-Text([string]$Path, $data) {
    [IO.File]::WriteAllText($Path, $data.Text, (New-Object System.Text.UTF8Encoding($data.Bom)))
}

# ---------------------------------------------------------------- 清单定义
# scriptblock 里引用 $script:Old 等：Build-Entries 的函数参数在函数作用域，
# scriptblock 看不见，所以先抄到脚本作用域再构造。
function Build-Entries([string]$Old, [string]$New, [int]$OldCode, [int]$NewCode) {
    $script:Old = $Old
    $script:New = $New
    $script:OldCode = $OldCode
    $script:NewCode = $NewCode
    $list = @()
    $list += ,@('client\package.json', { param($t) $t.Replace("`"version`": `"$script:Old`"", "`"version`": `"$script:New`"") })
    $list += ,@('client\apps\web\package.json', { param($t) $t.Replace("`"version`": `"$script:Old`"", "`"version`": `"$script:New`"") })
    $list += ,@('client\apps\desktop\package.json', { param($t) $t.Replace("`"version`": `"$script:Old`"", "`"version`": `"$script:New`"") })
    $list += ,@('client\apps\desktop\src-tauri\tauri.conf.json', { param($t) $t.Replace("`"version`": `"$script:Old`"", "`"version`": `"$script:New`"") })
    $list += ,@('client\apps\desktop\src-tauri\Cargo.toml', { param($t) $t -replace "(?m)^version = `"$script:Old`"", "version = `"$script:New`"" })
    # Cargo.lock 里第三方包（如 dbus）也可能恰好 0.9.x，只能动 meow-player 那条
    $list += ,@('client\apps\desktop\src-tauri\Cargo.lock', {
        param($t) $t -replace "(?s)(name = `"meow-player`"\s*\r?\nversion = `")$script:Old(`")", "`${1}$script:New`${2}"
    })
    $list += ,@('server\host\src\shared\ApiServer.java', { param($t) $t.Replace("VERSION = `"$script:Old`"", "VERSION = `"$script:New`"") })
    $list += ,@('server\plugin-manifests\apiserver.manifest.json', { param($t) $t.Replace("`"version`": `"$script:Old`"", "`"version`": `"$script:New`"") })
    $list += ,@('client\apps\tv\app\build.gradle', {
        param($t)
        $t = $t -replace "versionCode $script:OldCode\b", "versionCode $script:NewCode"
        $t = $t -replace "versionName '$script:Old'", "versionName '$script:New'"
        return $t
    })
    $list += ,@('deploy/docker/.env.example', { param($t) $t -replace "(?m)^MEOW_VERSION=$script:Old\s*$", "MEOW_VERSION=$script:New" })
    if (Test-Path (Join-Path $script:root 'deploy/docker/.env')) {
        $list += ,@('deploy/docker/.env', { param($t) $t -replace "(?m)^MEOW_VERSION=$script:Old\s*$", "MEOW_VERSION=$script:New" })
    }
    # compose 兜底跟版本走：它曾是 0.8.0 时坑过——没 .env 就拉旧镜像
    $list += ,@('deploy/docker/docker-compose.yml', { param($t) $t.Replace("MEOW_VERSION:-$script:Old", "MEOW_VERSION:-$script:New") })
    $list += ,@('deploy/docker/docker-compose.build.yml', { param($t) $t.Replace("MEOW_VERSION:-$script:Old", "MEOW_VERSION:-$script:New") })
    # with-sources 曾因漏在这里残留过 1.1.6（站点「下载即用」的 standalone 同理）
    $list += ,@('deploy/docker/docker-compose.with-sources.yml', { param($t) $t.Replace("MEOW_VERSION:-$script:Old", "MEOW_VERSION:-$script:New") })
    $list += ,@('deploy/docker/docker-compose.standalone.yml', { param($t) $t.Replace("MEOW_VERSION:-$script:Old", "MEOW_VERSION:-$script:New") })
    # fnOS fpk：manifest 是裸 `version=x.y.z`（无引号、无空格）；meowd 的 Cargo 版本
    # 会被 /api/health 直接报出去，两者必须跟着走。
    $list += ,@('client\apps\fnos\fpk\manifest', {
        param($t) $t -replace ("(?m)^version=" + [regex]::Escape($script:Old) + "\s*$"), "version=$script:New"
    })
    $list += ,@('client\apps\fnos\meowd\Cargo.toml', {
        param($t) $t -replace ("(?m)^version = `"" + [regex]::Escape($script:Old) + "`""), "version = `"$script:New`""
    })
    $list += ,@('client\apps\fnos\meowd\Cargo.lock', {
        param($t) $t -replace ("(?s)(name = `"meowd`"\s*\r?\nversion = `")" + [regex]::Escape($script:Old) + "(`")"), "`${1}$script:New`${2}"
    })
    return $list
}

function Test-Consistency([string]$Expect) {
    # 返回不一致清单（空数组 = 通过）。只判"文件里有没有这个版本串"，
    # 更细的 versionCode/公式校验在 build-apk.ps1 里做。
    $cp = $Expect.Split('.')
    $code = [int]$cp[0] * 1000 + [int]$cp[1] * 100 + [int]$cp[2]
    $entries = Build-Entries $Expect $Expect $code $code
    $bad = @()
    foreach ($e in $entries) {
        $full = Join-Path $root $e[0]
        if (-not (Test-Path $full)) { $bad += "$($e[0])  文件不存在"; continue }
        $t = [IO.File]::ReadAllText($full)
        if ($t.IndexOf($Expect, [StringComparison]::Ordinal) -lt 0) {
            if ($e[0] -like '*Cargo.lock') {
                # Cargo.lock 由 cargo 生成，只改 Cargo.toml 不会自动同步它。
                # 不给出修法的话，下一个人只会看到"版本不一致"却不知道怎么办
                # （实际卡过一次 CI：prepare 的版本校验失败，整条发版链 skipped）。
                $bad += "$($e[0])  找不到 $Expect（Cargo.lock 未同步 Cargo.toml）"
                $bad += "   修法1（推荐）：cd client/apps/desktop/src-tauri; cargo update -p meow-player --offline"
                $bad += "   修法2：手动把 meow-player 条目的 version 改成 $Expect"
            } else {
                $bad += "$($e[0])  找不到 $Expect"
            }
        }
    }
    return $bad
}

# ---------------------------------------------------------------- 主流程
$pkgPath = Join-Path $root 'client\package.json'
$current = ([IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json).version
if (-not $current) { throw '读不到 client/package.json 的 version' }

if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "版本号必须是三段数字（如 0.9.13），收到：$Version"
}

if ($Check) {
    $bad = Test-Consistency $current
    if ($bad.Count) {
        Write-Host "版本不一致（当前 $current）：" -ForegroundColor Red
        $bad | ForEach-Object { Write-Host "  x $_" -ForegroundColor Red }
        exit 1
    }
    Write-Host "版本一致：全部位置均为 $current" -ForegroundColor Green
    exit 0
}

if (-not $Version) { throw '需要 -Version x.y.z，或用 -Check 只做校验' }
if ($Version -eq $current) { Write-Host "目标版本与当前相同（$current），无事可做"; exit 0 }
if ([version]$Version -le [version]$current) {
    # Android versionCode 只能增大；镜像 tag 倒退同样会造成"拉到旧包"的错觉
    throw "目标版本 $Version 不大于当前 $current，禁止倒退"
}

$p = $Version.Split('.')
$newCode = [int]$p[0] * 1000 + [int]$p[1] * 100 + [int]$p[2]
$cp = $current.Split('.')
$curCode = [int]$cp[0] * 1000 + [int]$cp[1] * 100 + [int]$cp[2]

# 常见失误：上一轮就没对齐 TV 的 versionCode，按它推新值会写错。
# 不在这里硬拦——把实情摆出来，人工确认后仍可继续（Replace 按当前值匹配，
# 对不上会在下面逐文件结果里以"未找到"暴露）。
$gradleText = [IO.File]::ReadAllText((Join-Path $root 'client\apps\tv\app\build.gradle'))
if ($gradleText -notmatch "versionCode $curCode\b") {
    $haveCode = if ($gradleText -match 'versionCode (\d+)') { $Matches[1] } else { '?' }
    Write-Host "⚠ TV build.gradle 的 versionCode 是 $haveCode，与 $current（应 $curCode）不匹配。继续执行，但请留意该文件的替换结果。" -ForegroundColor Yellow
}

$entries = Build-Entries $current $Version $curCode $newCode
$failed = @()
foreach ($e in $entries) {
    $full = Join-Path $root $e[0]
    if (-not (Test-Path $full)) { $failed += "$($e[0])  文件不存在"; continue }
    $data = Read-Text $full
    $after = & $e[1] $data.Text
    if ($after -eq $data.Text) {
        $failed += "$($e[0])  未找到 $current（可能已改过或模式漂移）"
        continue
    }
    if ($DryRun) {
        Write-Host "  [dry] $($e[0])"
    } else {
        $data.Text = $after
        Write-Text $full $data
        Write-Host "  ok $($e[0])"
    }
}

if ($failed.Count) {
    Write-Host "`n以下位置没改到，必须人工处理：" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  x $_" -ForegroundColor Red }
    exit 1
}

if ($DryRun) {
    Write-Host "`n预演完成，未写盘。去掉 -DryRun 实际执行。" -ForegroundColor Cyan
    exit 0
}

# 写完必须回读，别信"Replace 没抛就是改了"。经子进程跑，exit 码才有意义。
$verifyOut = & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Check 2>&1
Write-Host $verifyOut
if ($LASTEXITCODE -ne 0) { throw '替换后回读校验失败，见上方清单' }

Write-Host "`n版本已提升：$current → $Version（versionCode $curCode → $newCode）" -ForegroundColor Green
Write-Host '下一步：git diff 复查后自行提交（本脚本不代提交）。' -ForegroundColor Cyan
