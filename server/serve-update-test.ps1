# 生成一份"假版本"的更新清单，用来本地测应用在线更新。
#
# 为什么需要它：真发一次版要几分钟（构建 exe + apk + 上传），而验证更新链路
# 只需要"清单里的版本号比当前高 + 安装包可下载可校验"。这个脚本把当前版本的
# 真实安装包**原样复制**，只把清单里的 version 写成 N+1，于是能在 30 秒内
# 反复走通「检测到新版 → 下载 → 校验 → 拉起安装器」。
#
# 副作用：装上去的还是当前版本（包内容没变），所以不会真的升级——
# 这正好：验证的是链路，不是"新版本功能有没有生效"。
#
# 用法：
#   powershell -File server/serve-update-test.ps1
#   powershell -File server/serve-update-test.ps1 -Bump 0.9.31   # 指定假版本号
#   powershell -File server/serve-update-test.ps1 -Port 8099     # 生成后直接起服务
#
# 生成目録：release/update-test/（gitignore 覆盖 release/）
# 然后在应用「设置 → 应用更新 → 更新源」填：
#   http://127.0.0.1:8099/packages.json

param(
    # 假版本号。空 = 自动取当前版本 +1（0.9.29 → 0.9.30）
    [string]$Bump = '',
    # 有值时生成完直接起 serve-release.ps1
    [int]$Port = 0,
    # 从哪个 release 目录取真实安装包（空 = 最新的 release/v*）
    [string]$From = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'release\update-test'

function Get-CurrentVersion {
    $p = Join-Path $root 'client\package.json'
    $j = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    return $j.version
}

function Add-Patch([string]$v) {
    $parts = $v.Split('.')
    if ($parts.Count -lt 3) { return "$v.1" }
    $parts[2] = [string]([int]$parts[2] + 1)
    return ($parts -join '.')
}

# ---------------------------------------------------------------- 找源目录
if (-not $From) {
    # 取版本号最高的 release/v* 目录
    $From = Get-ChildItem (Join-Path $root 'release') -Directory -Filter 'v*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^v(\d+\.\d+\.\d+)$' } |
        Sort-Object { [version]($_.Name.Substring(1)) } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $From -or -not (Test-Path $From)) {
    throw "找不到带有产物的 release/v* 目录。先跑 ./deploy/scripts/release.ps1，或用 -From 指定。"
}

$cur = Get-CurrentVersion
$fake = if ($Bump) { $Bump } else { Add-Patch $cur }

Write-Host "当前版本: $cur" -ForegroundColor DarkGray
Write-Host "假版本号: $fake  （清单里写这个，客户端才会认为有更新）" -ForegroundColor Cyan
Write-Host "安装包来源: $From" -ForegroundColor DarkGray

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# ---------------------------------------------------------------- 复制安装包
#
# 用 ASCII 文件名：中文名进 URL 要百分号编码，测起来会多一层干扰。
$packages = @()

# ★ 不用 -Filter：那个走文件系统通配实现，对中文文件名匹配不可靠
#   （build-release.ps1 里实测过 '*版本*x64-setup.exe' 返回空）。
$pcSetup = Get-ChildItem $From -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*x64-setup.exe' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($pcSetup) {
    $name = "meow_pc-$fake.exe"
    Copy-Item $pcSetup.FullName (Join-Path $outDir $name) -Force
    $sha = (Get-FileHash $pcSetup.FullName -Algorithm SHA256).Hash.ToLower()
    $packages += [ordered]@{
        id       = 'meow-pc'
        version  = $fake
        size     = $pcSetup.Length
        sha256   = $sha
        url      = $name
        platform = @('windows-x64')
        display  = 'PC 安装包（本地测试）'
    }
    Write-Host ("  meow-pc  <- {0}  {1}MB" -f $pcSetup.Name, [math]::Round($pcSetup.Length / 1MB, 2)) -ForegroundColor Green
} else {
    Write-Host "  跳过 meow-pc（$From 里没有 *x64-setup.exe）" -ForegroundColor DarkYellow
}

$tvApk = Get-ChildItem $From -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*TV*.apk' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($tvApk) {
    $name = "meow_tv-$fake.apk"
    Copy-Item $tvApk.FullName (Join-Path $outDir $name) -Force
    $sha = (Get-FileHash $tvApk.FullName -Algorithm SHA256).Hash.ToLower()
    $packages += [ordered]@{
        id       = 'meow-tv'
        version  = $fake
        size     = $tvApk.Length
        sha256   = $sha
        url      = $name
        platform = @('android-arm64', 'android-armv7', 'android-x86_64')
        display  = 'TV 安装包（本地测试）'
    }
    Write-Host ("  meow-tv  <- {0}  {1}MB" -f $tvApk.Name, [math]::Round($tvApk.Length / 1MB, 2)) -ForegroundColor Green
} else {
    Write-Host "  跳过 meow-tv（$From 里没有 *TV*.apk）" -ForegroundColor DarkYellow
}

if (-not $packages.Count) {
    throw "$From 里既没有 PC 安装包也没有 TV APK，无法生成测试清单。"
}

# ---------------------------------------------------------------- 写清单
#
# 手拼 JSON 而不是 ConvertTo-Json：PS 5.1 的 ConvertTo-Json 会把中文/
# 特殊字符转成 \uXXXX，虽然合法但肉眼看不懂，排查时很烦。
function Esc([string]$s) {
    if ($null -eq $s) { return '""' }
    $s = $s.Replace('\', '\\').Replace('"', '\"')
    $s = $s.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $s + '"'
}

$sb = New-Object System.Text.StringBuilder
$today = (Get-Date).ToString('yyyy-MM-dd')
$nowUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
[void]$sb.AppendLine('{')
[void]$sb.AppendLine('  "schema_version": 1,')
[void]$sb.AppendLine("  `"generated_at`": $(Esc $nowUtc),")
[void]$sb.AppendLine("  `"author`": { `"name`": `"local-test`", `"url`": `"`" },")
[void]$sb.AppendLine('  "min_app_version": "0.6.0",')
[void]$sb.AppendLine('  "packages": {')
for ($i = 0; $i -lt $packages.Count; $i++) {
    $p = $packages[$i]
    [void]$sb.AppendLine("    $(Esc $p.id): {")
    [void]$sb.AppendLine("      `"display_name`": $(Esc $p.display),")
    [void]$sb.AppendLine("      `"version`": $(Esc $p.version),")
    $platJson = '[' + (($p.platform | ForEach-Object { Esc $_ }) -join ',') + ']'
    [void]$sb.AppendLine("      `"platform`": $platJson,")
    $descText = '本地测试清单：实际安装包是 ' + $cur + ' 的内容'
    [void]$sb.AppendLine("      `"desc`": $(Esc $descText),")
    [void]$sb.AppendLine("      `"size`": $($p.size),")
    [void]$sb.AppendLine("      `"sha256`": $(Esc $p.sha256),")
    [void]$sb.AppendLine("      `"url`": $(Esc $p.url),")
    [void]$sb.AppendLine('      "requires": [],')
    # ★ hidden 必须 true：否则会出现在「本机插件」的可安装列表里，
    #   用户点了走插件安装器、解压找不到 manifest.json 而失败。
    [void]$sb.AppendLine('      "hidden": true,')
    [void]$sb.AppendLine("      `"lasttime`": $(Esc $today)")
    $comma = if ($i -lt $packages.Count - 1) { ',' } else { '' }
    [void]$sb.AppendLine("    }$comma")
}
[void]$sb.AppendLine('  }')
[void]$sb.AppendLine('}')

$manifestPath = Join-Path $outDir 'packages.json'
[System.IO.File]::WriteAllText($manifestPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))

Write-Host "`n清单已生成: $manifestPath" -ForegroundColor Cyan
Write-Host "假版本 $fake（真实内容是 $cur）" -ForegroundColor Cyan

if ($Port -gt 0) {
    Write-Host "`n起服务 → 应用里填 http://127.0.0.1:$Port/packages.json`n" -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'serve-release.ps1') -Port $Port -Dir $outDir
} else {
    Write-Host "`n下一步：" -ForegroundColor Yellow
    Write-Host "  powershell -File server/serve-release.ps1 -Port 8099 -Dir release/update-test" -ForegroundColor Gray
    Write-Host '  应用 → 设置 → 应用更新 → 更新源填 http://127.0.0.1:8099/packages.json' -ForegroundColor Gray
    Write-Host '  （验证完把更新源清空，否则一直显示「有新版本」）' -ForegroundColor DarkGray
}
