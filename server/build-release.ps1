# 打包发布资产：把 build/plugins/ 下的插件打成 zip，并生成插件源清单
#
# 产出（release/ 目录，直接上传到文件服务器 / GitHub Releases / Gitee）：
#   release/
#   ├── packages.json              ← 插件源清单（应用读这个）
#   ├── apiserver-0.8.0.zip
#   ├── danmu-api-1.0.0.zip
#   └── node-22.18.0.zip
#
# 前置：先跑 build-plugin.ps1 和 build-plugin-danmu.ps1 生成 build/plugins/
#
# ## 插件源清单格式（packages 风格）
#
# 顶层 key 就是插件 id，不再需要 id 字段：
#
# ```json
# {
#   "schema_version": 1,
#   "generated_at": "2026-10-22T...",
#   "author": { "name": "...", "url": "..." },
#   "packages": {
#     "apiserver": {
#       "display_name": "影视后端",
#       "version": "0.6.2",
#       "platform": ["windows-x64"],
#       "desc": "...",
#       "author": "meow",
#       "homepage": "https://...",
#       "download": { "url": "apiserver-0.6.2.zip", "size": 38843935, "sha256": "..." },
#       "min_app_version": "0.6.0",
#       "api_version": 1,
#       "requires": [],
#       "hidden": false,
#       "lasttime": "2026-10-22"
#     }
#   }
# }
# ```
#
# 为什么用「顶层 key = id」而不是数组：
#   用户手写自定义源时，一眼能看出装了哪个插件，改起来不容易错位；
#   数组方案一旦漏个括号，整份配置就废了。
#
# ## url 用相对路径
#
# 应用按「插件源地址 + url」拼完整下载地址。这样同一份资产可以放本地
# 文件服务器、GitHub Releases、Gitee、自建对象存储，不用改任何代码。
#
# ## 锁死的两个 id
#
# `apiserver` 和 `danmu-api` 是应用内置识别的 id（前者提供后端 API，
# 后者被 capability=danmaku 识别）。自定义源里的**其他 id 也能装**，
# 但应用不知道它们的用途，只当普通 sidecar 进程管理。

param(
    [string]$MinAppVersion = '0.8.0',
    [string]$OutDir = '',
    [string]$Author = 'meow',
    [string]$Homepage = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'release' }
# 转绝对路径：脚本内部会 Push-Location，相对路径会失效
$OutDir = [IO.Path]::GetFullPath($OutDir)
# 与 build-plugin.ps1 / build-plugin-danmu.ps1 的输出目录保持一致
$pluginsRoot = Join-Path $root 'build\plugins'

if (-not (Test-Path $pluginsRoot)) {
    throw "找不到 build/plugins/，请先执行 build-plugin.ps1 和 build-plugin-danmu.ps1"
}

$nodeExe = Join-Path $pluginsRoot 'node\node.exe'
$nodeVersion = '22.18.0'
if (Test-Path $nodeExe) {
    $raw = & $nodeExe --version 2>$null
    if ($raw) { $nodeVersion = $raw.TrimStart('v') }
}

Write-Host "输出目录: $OutDir" -ForegroundColor Cyan
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# ---------------------------------------------------------------- JSON 转义
# 手工拼 JSON，不用 ConvertTo-Json：后者对嵌套空数组会输出 `{}`，
# Rust 的 Vec<T> 直接解析失败（实测踩过）。
function Esc-Json([string]$s) {
    if ($null -eq $s) { return '""' }
    $s = $s.Replace('\', '\\').Replace('"', '\"')
    $s = $s.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $s + '"'
}

$packages = [ordered]@{}

function Add-Plugin {
    param(
        [string]$Id,
        [string]$Dir,
        [string]$Version,
        [string]$DisplayName,
        [string]$Desc,
        [string[]]$Requires,
        [switch]$Hidden
    )

    if (-not (Test-Path $Dir)) {
        Write-Host "  跳过 $Id（目录不存在）" -ForegroundColor DarkYellow
        return
    }

    $zipName = "$Id-$Version.zip"
    # ★ 必须先转绝对路径：下面会 Push-Location 到插件目录，
    #   此时相对 OutDir 会解析到错误位置（实测：传相对路径报
    #   'tar 打包失败'，传绝对路径才成功）。
    $zipPath = Join-Path (Resolve-Path $OutDir).Path $zipName
    Write-Host "  打包 $Id ..." -ForegroundColor Yellow

    # 用 tar 打 zip：Windows 自带 bsdtar，与应用解压用的是同一工具，格式必兼容。
    # 必须在目录内用 * 打包（保持 manifest.json 在 zip 根层级），
    # 否则应用解压后要额外剥一层目录。
    Push-Location $Dir
    try {
        & "$env:SystemRoot\System32\tar.exe" -a -cf $zipPath *
        if ($LASTEXITCODE -ne 0) { throw "tar 打包 $Id 失败" }
    } finally {
        Pop-Location
    }

    # 打包必须包含 manifest.json，否则应用无法识别
    $hasManifest = (& "$env:SystemRoot\System32\tar.exe" -tf $zipPath) -contains 'manifest.json'
    if (-not $hasManifest) {
        throw "$zipName 里没有 manifest.json，应用装不了"
    }

    $size = (Get-Item $zipPath).Length
    $sha = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
    $sizeMb = [math]::Round($size / 1MB, 2)
    Write-Host "    $zipName  ${sizeMb}MB  sha256=$($sha.Substring(0,12))…" -ForegroundColor Green

    $packages[$Id] = [ordered]@{
        version    = $Version
        display    = $DisplayName
        desc       = $Desc
        size       = $size
        sha256     = $sha
        url        = $zipName
        requires   = if ($Requires -and $Requires.Count -gt 0) {
            '[' + (($Requires | ForEach-Object { Esc-Json $_ }) -join ',') + ']'
        } else { '[]' }
        hidden     = if ($Hidden) { 'true' } else { 'false' }
        lasttime   = (Get-Date).ToString('yyyy-MM-dd')
    }
}

# ---------------------------------------------------------------- 各插件
function Get-ManifestVersion([string]$Id) {
    $mf = Join-Path $pluginsRoot "$Id\manifest.json"
    if (Test-Path $mf) {
        $j = Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json
        return $j.version
    }
    return '0.0.0'
}

Add-Plugin -Id 'apiserver' `
    -Dir (Join-Path $pluginsRoot 'apiserver') `
    -Version (Get-ManifestVersion 'apiserver') `
    -DisplayName '影视后端' `
    -Desc '宿主后端：搜索 / 详情 / 播放 / 弹幕代理' 

Add-Plugin -Id 'danmu-api' `
    -Dir (Join-Path $pluginsRoot 'danmu-api') `
    -Version (Get-ManifestVersion 'danmu-api') `
    -DisplayName '弹幕增强' `
    -Desc '弹幕多源聚合（22 源）' `
    -Requires @('node')

# drpy：把 .js 源接到 Node 里跑。没有它，配置里 200+ 个 drpy 站会被判"不可用"。
Add-Plugin -Id 'drpy' `
    -Dir (Join-Path $pluginsRoot 'drpy') `
    -Version (Get-ManifestVersion 'drpy') `
    -DisplayName 'drpy 脚本运行时' `
    -Desc '执行 .js（drpy）源，需要 node 运行时' `
    -Requires @('node')

# ffmpeg：浏览器内核没有 HEVC 解码器，用户的 MKV（H.265）在 PC/Web 端要靠它转码。
# tool 型插件，装好后应用会把 {pluginDir}/ffmpeg.exe 写进 policy.json 的
# ffmpegPath，后端 core/Transcode 从这里取路径，用户零配置。
# 体积大（约 80MB），所以 hidden 且非 required——用户不装也不影响在线播放。
$ffmpegExe = Join-Path (Join-Path $pluginsRoot 'ffmpeg') 'ffmpeg.exe'
if (Test-Path $ffmpegExe) {
    Add-Plugin -Id 'ffmpeg' `
        -Dir (Join-Path $pluginsRoot 'ffmpeg') `
        -Version '9.0.2' `
        -DisplayName 'FFmpeg 转码器' `
        -Desc '把 NAS 上的 MKV/HEVC 转成浏览器能播的格式（源文件不改动）' `
        -Hidden
} else {
    Write-Host "  跳过 ffmpeg（未构建，先跑 build-plugin-ffmpeg.ps1）" -ForegroundColor DarkYellow
}

# node 运行时单独打包。
# ★ 必须给它写一个 manifest.json —— 应用按 manifest 识别插件，
#   没有 manifest 的 zip 会被判为"包结构不对"。之前漏了这步，
#   导致装 danmu-api 时依赖安装失败。
if (Test-Path $nodeExe) {
    $nodeStage = Join-Path $env:TEMP "z_node_stage"
    Remove-Item $nodeStage -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $nodeStage -Force | Out-Null
    Copy-Item $nodeExe (Join-Path $nodeStage 'node.exe')

    # 手工拼 manifest：ConvertTo-Json 在 PS 5.1 下会把中文写成乱码，
    # 而且 exec 必须是 zip 内的真实文件名 node.exe（写 node 找不到）。
    $nodeManifest = @"
{
  "id": "node",
  "name": "Node 运行时",
  "version": "$nodeVersion",
  "tool": true,
  "exec": "node.exe",
  "args": [],
  "autostart": false
}
"@
    [System.IO.File]::WriteAllText(
        (Join-Path $nodeStage 'manifest.json'),
        $nodeManifest,
        (New-Object System.Text.UTF8Encoding $false)
    )

    Add-Plugin -Id 'node' -Dir $nodeStage -Version $nodeVersion `
        -DisplayName 'Node 运行时' -Desc '弹幕插件依赖的 Node 运行环境' -Hidden
    Remove-Item $nodeStage -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 应用自身（exe / apk）
#
# 应用在线更新复用同一份清单，用两个保留 id：
#   meow-pc → Windows 安装包（NSIS）
#   meow-tv → Android APK
#
# ★ 为什么必须两条而不是一条带多平台：清单里单个包只有**一个 url + 一个 sha256**。
#   写成 platform:["windows-x64","android-arm64"] + 单个 url 会让 Windows 客户端
#   去下 apk。详见 client/apps/web/src/api/appUpdate.ts 文件头。
#
# ★ 两条都必须 hidden：否则会出现在应用「本机插件」的可安装列表里
#   （那边只过滤 hidden），用户点了会走插件安装器、解压找不到 manifest.json 而失败。
#
# ★★ 安装包不在 $OutDir 里，而在它的**父目录**。
#   release.ps1 调本脚本时传的是 `-OutDir release/vX.Y.Z/plugins`，而 PC/TV 产物
#   由 release.ps1 直接拷到 `release/vX.Y.Z/`（根目录）。而且本脚本开头会
#   `Remove-Item $OutDir -Recurse`，所以往 OutDir 里找安装包一定是空——
#   （实测症状：两块都"跳过"，清单里没有 meow-*）。
$appSrcDir = Split-Path -Parent (Resolve-Path $OutDir).Path
function Add-App {
    param(
        [string]$Id,
        [string]$File,
        [string]$Version,
        [string]$DisplayName,
        [string[]]$Platforms,
        [string]$Desc
    )
    if (-not (Test-Path $File)) {
        Write-Host "  跳过 $Id（找不到安装包）" -ForegroundColor DarkYellow
        return
    }
    $item = Get-Item $File
    $size = $item.Length
    $sha = (Get-FileHash $File -Algorithm SHA256).Hash.ToLower()
    $sizeMb = [math]::Round($size / 1MB, 2)

    # 文件名必须是 ASCII：中文名进 URL 要百分号编码，Content-Disposition
    # 与中间代理都有出问题的先例。release 里同时保留中文名给人看。
    #
    # 拷到**父目录**（= release/vX.Y.Z/），与 exe/apk 并列：
    # 清单里 url 是相对名，客户端按"清单所在目录 + 相对名"解析，
    # 而清单最终在父目录（见末尾把 packages.json 同时写一份到父目录）。
    $asciiName = $Id.Replace('-', '_') + "-$Version" + $item.Extension
    $asciiPath = Join-Path $appSrcDir $asciiName
    Copy-Item $item.FullName $asciiPath -Force

    Write-Host ("  {0}  -> {1}  {2}MB  sha256={3}…" -f $Id, $asciiName, $sizeMb, $sha.Substring(0, 12)) -ForegroundColor Green

    $packages[$Id] = [ordered]@{
        version    = $Version
        display    = $DisplayName
        desc       = $Desc
        size       = $size
        sha256     = $sha
        url        = $asciiName
        requires   = '[]'
        hidden     = 'true'
        lasttime   = (Get-Date).ToString('yyyy-MM-dd')
        # 覆盖默认的 windows-x64：meow-tv 是 Android 包
        platform   = '[' + (($Platforms | ForEach-Object { Esc-Json $_ }) -join ',') + ']'
    }
}

# 版本号取 client/package.json（bump-version.ps1 会把它与 web/desktop/TV 一次改齐）。
# 不另外读 build.gradle：那里与这里同源，多读一处只是多一个失败点。
#
# ★ $root 在本脚本里等于 server/（= $PSScriptRoot），不是仓库根——
#   所以这里必须用 ..\client，写 'client\...' 会解析到 server\client
#   （实测症状是版本号永远 0.0.0，然后两块 Add-App 都被跳过）。
$appVersion = '0.0.0'
$pkgJson = Join-Path (Split-Path -Parent $root) 'client\package.json'
if (Test-Path $pkgJson) {
    try { $appVersion = (Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
}
if ($appVersion -eq '0.0.0') {
    Write-Host "! 读不到 client/package.json 的版本号，应用在线更新条目将被跳过" -ForegroundColor DarkYellow
}

# PC 安装包（在父目录找：release/vX.Y.Z/ 根）
#
# ★ 不用 Get-ChildItem -Filter 做匹配：-Filter 走文件系统的通配实现，
#   对**中文文件名**匹配不上（实测：目录里明明有 `猫窝_0.9.29_x64-setup.exe`，
#   -Filter '*0.9.29*x64-setup.exe' 仍返回空）。改成先列出全部再 Where-Object。
$pcSetup = Get-ChildItem $appSrcDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*$appVersion*x64-setup.exe" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($pcSetup) {
    Add-App -Id 'meow-pc' -File $pcSetup.FullName -Version $appVersion `
        -DisplayName 'PC 安装包' -Platforms @('windows-x64') `
        -Desc "猫窝 PC 版 $appVersion"
} else {
    Write-Host "  跳过 meow-pc（$appSrcDir 里没有 *$appVersion*x64-setup.exe）" -ForegroundColor DarkYellow
}

# TV APK：build-apk.ps1 产出 `猫窝-TV-<版本>.apk`（同样在父目录找）
#
# ★ platform 里必须带 android-x86_64：模拟器（MuMu/AVD）报的是 x86_64，
#   不在列表里就永远看不到更新。这个包实测 `lib/` 条目为 0（纯 Java，
#   没有原生库），在 x86_64 上装得上，所以列进去是安全的。
$tvApk = Get-ChildItem $appSrcDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*TV*$appVersion*.apk" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($tvApk) {
    Add-App -Id 'meow-tv' -File $tvApk.FullName -Version $appVersion `
        -DisplayName 'TV 安装包' -Platforms @('android-arm64', 'android-armv7', 'android-x86_64') `
        -Desc "猫窝 TV 版 $appVersion"
} else {
    Write-Host "  跳过 meow-tv（$appSrcDir 里没有 *TV*$appVersion*.apk）" -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- packages.json
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('{')
[void]$sb.AppendLine('  "schema_version": 1,')
[void]$sb.AppendLine("  `"generated_at`": $(Esc-Json ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))),")
[void]$sb.AppendLine("  `"author`": { `"name`": $(Esc-Json $Author), `"url`": $(Esc-Json $Homepage) },")
[void]$sb.AppendLine("  `"min_app_version`": $(Esc-Json $MinAppVersion),")
[void]$sb.AppendLine('  "packages": {')

$ids = @($packages.Keys)
for ($i = 0; $i -lt $ids.Count; $i++) {
    $id = $ids[$i]
    $p = $packages[$id]
    [void]$sb.AppendLine("    $(Esc-Json $id): {")
    [void]$sb.AppendLine("      `"display_name`": $(Esc-Json $p.display),")
    [void]$sb.AppendLine("      `"version`": $(Esc-Json $p.version),")
    # meow-pc / meow-tv 自带 platform（Add-App 里设的），插件默认 windows-x64
    $plat = if ($p.Contains('platform')) { $p.platform } else { '["windows-x64"]' }
    [void]$sb.AppendLine("      `"platform`": $plat,")
    [void]$sb.AppendLine("      `"desc`": $(Esc-Json $p.desc),")
    [void]$sb.AppendLine("      `"author`": $(Esc-Json $Author),")
    [void]$sb.AppendLine("      `"homepage`": $(Esc-Json $Homepage),")
    [void]$sb.AppendLine("      `"size`": $($p.size),")
    [void]$sb.AppendLine("      `"sha256`": $(Esc-Json $p.sha256),")
    [void]$sb.AppendLine("      `"url`": $(Esc-Json $p.url),")
    [void]$sb.AppendLine("      `"requires`": $($p.requires),")
    [void]$sb.AppendLine("      `"hidden`": $($p.hidden),")
    [void]$sb.AppendLine("      `"lasttime`": $(Esc-Json $p.lasttime),")
    [void]$sb.AppendLine("      `"api_version`": 1,")
    [void]$sb.AppendLine("      `"min_app_version`": $(Esc-Json $MinAppVersion)")
    $comma = if ($i -lt $ids.Count - 1) { ',' } else { '' }
    [void]$sb.AppendLine("    }$comma")
}
[void]$sb.AppendLine('  }')
[void]$sb.AppendLine('}')

$packPath = Join-Path $OutDir 'packages.json'
[System.IO.File]::WriteAllText($packPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Host "`n插件源清单已生成：$packPath" -ForegroundColor Cyan

# 带 meow-* 条目的清单再往**父目录**放一份。
#
# ★ 为什么必须两份：客户端按"清单地址所在目录 + 相对 url"解析安装包地址。
#   meow-* 的 url 是 `meow_pc-0.9.30.exe`，文件在父目录（release/vX.Y.Z/），
#   所以清单也必须能被父目录下的地址取到，否则解析成 `plugins/meow_pc-...`
#   而下 404。插件清单（plugins/ 下那份）保持原样，服务插件源那套用法。
$hasApp = $packages.Contains('meow-pc') -or $packages.Contains('meow-tv')
$appPackPath = $null
if ($hasApp) {
    $appPackPath = Join-Path $appSrcDir 'packages.json'
    [System.IO.File]::WriteAllText($appPackPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
    Write-Host "含应用更新条目：$appPackPath" -ForegroundColor Cyan
}

# index.json 是早期别名。保留是因为：
#   · 用户在应用里存的源地址可能还是 `http://host:8099/`（目录形式，
#     客户端会先试 packages.json 再试 index.json）
#   · 早期版本的读取逻辑只认 index.json
# 新代码一律写 packages.json。
Copy-Item $packPath (Join-Path $OutDir 'index.json') -Force
if ($hasApp) {
    Copy-Item $appPackPath (Join-Path $appSrcDir 'index.json') -Force
}

# ---------------------------------------------------------------- 汇总
Write-Host "`n=== 发布资产 ===" -ForegroundColor Cyan
Get-ChildItem $OutDir | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 2)
    Write-Host ("  {0,-28} {1,8}MB" -f $_.Name, $mb)
}
$totalMb = [math]::Round(((Get-ChildItem $OutDir | Where-Object { $_.Extension -eq '.zip' } | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
Write-Host "`n插件合计: ${totalMb}MB" -ForegroundColor Green

Write-Host @"

下一步：
  1) 本地测试：  powershell -File serve-release.ps1
                 应用里把「插件源」设为 http://127.0.0.1:8099/packages.json
  2) 线上发布：把 $OutDir 下所有文件上传到静态服务器，
                 让 packages.json 可公开访问即可
"@ -ForegroundColor DarkGray
