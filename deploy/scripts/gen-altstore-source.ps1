# 生成 SideStore / LiveContainer / AltStore 可订阅的源清单（altstore-source.json）。
#
# 与 packages.json 的区别：
#   packages.json 每个包只留**最新一条**（客户端更新弹框用）；
#   本清单是**每个版本一条**的 versions[] 数组，每条指向该版本自己的 IPA 资产
#   （不是固定名），并带版本号与 CHANGELOG 里那一版的更新说明 —— 与 fpk 的
#   fnpack.json 同一个思路：发版后在 CI 里重建，用户端刷新源即可看到新版本。
#
# 输入：
#   -ReleasesJson  GitHub /repos/{repo}/releases 的数组（可多页合并），必填，便于离线测试
#   -RepoRoot      仓库根（读 CHANGELOG.md 生成每版说明），可选
#   -OutFile       输出路径，必填
#
# 用法（CI 里由 sync-packages.ps1 调；本地可拿缓存的 releases JSON 直接跑）：
#   pwsh gen-altstore-source.ps1 -ReleasesJson rels.json -RepoRoot .. -OutFile altstore-source.json
param(
    [Parameter(Mandatory = $true)][string]$ReleasesJson,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Repo = 'upchr/meow',
    [string]$RepoRoot = '',
    # 源清单自身的公开地址（SideStore 里填这个）
    [string]$SourceURL = '',
    [string]$MinOSVersion = '15.0'
)

$ErrorActionPreference = 'Stop'

if (-not $SourceURL) { $SourceURL = "https://github.com/$Repo/releases/latest/download/altstore-source.json" }

# ★ 不要写成 `@(... | ConvertFrom-Json)`：PS 5.1 里 ConvertFrom-Json 把顶层数组
#   当成**一个对象**写进管道，@() 收进来就是 count=1 的嵌套数组（实测）。
#   直接赋值拿到的是 Object[]，再 @() 包一层才是逐项的。
$relsRaw = [IO.File]::ReadAllText($ReleasesJson, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$rels = if ($null -eq $relsRaw) { @() } else { @($relsRaw) }

# ---------------------------------------------------------------- 每版更新说明
# 复用 gen-history.ps1 的解析（CHANGELOG 的写作约定只在那里面实现一次），
# 失败不阻塞：没有说明就退回「猫窝 <版本>」。
$desc = @{}
if ($RepoRoot) {
    try {
        $histTmp = Join-Path ([IO.Path]::GetTempPath()) ("meow-hist-" + [guid]::NewGuid().ToString('N') + '.json')
        & (Join-Path $PSScriptRoot 'gen-history.ps1') -RepoRoot $RepoRoot -OutFile $histTmp | Out-Null
        $hj = [IO.File]::ReadAllText($histTmp, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
        foreach ($v in @($hj.versions)) {
            if ($v.version) { $desc[[string]$v.version] = (@($v.lines) -join "`n") }
        }
        Remove-Item $histTmp -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "  ! CHANGELOG 解析失败，版本说明退回占位：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# ---------------------------------------------------------------- 收集版本
# 只认「版本化」的 IPA：Meow-unsigned-<x.y.z>.ipa。
# 固定名 Meow-unsigned.ipa 与 nojvm 排障包都不是可安装版本，排除。
$byVer = @{}
foreach ($r in $rels) {
    if ($r.draft -or $r.prerelease) { continue }
    if (-not $r.published_at) { continue }
    $pub = [datetimeoffset]::Parse([string]$r.published_at)
    foreach ($a in @($r.assets)) {
        if ($a.name -notmatch '^Meow-unsigned-(\d+\.\d+\.\d+)\.ipa$') { continue }
        $ver = $Matches[1]
        # 同一版本出现在多个 release（重跑/补发）：保留发布时间最晚的那条
        if ($byVer.ContainsKey($ver) -and $byVer[$ver].published -ge $pub) { continue }
        $sha = ''
        if ($a.digest -and ([string]$a.digest) -match '^sha256:([0-9a-fA-F]{64})$') { $sha = $Matches[1] }
        $byVer[$ver] = [pscustomobject]@{
            version   = $ver
            published = $pub
            date      = $pub.ToString('yyyy-MM-dd')
            url       = "https://github.com/$Repo/releases/download/$($r.tag_name)/$($a.name)"
            size      = [int64]$a.size
            sha256    = $sha
        }
    }
}
if ($byVer.Count -eq 0) { throw 'Releases 里没有任何 Meow-unsigned-<版本>.ipa（发过 iOS 包之后再跑）' }

$entries = @($byVer.Values | Sort-Object -Property { [version]$_.version } -Descending)

# ---------------------------------------------------------------- 组装 JSON
$versions = @()
foreach ($e in $entries) {
    $d = $desc[$e.version]
    if (-not $d) { $d = "猫窝 $($e.version)" }
    $o = [ordered]@{
        version              = $e.version
        date                 = $e.date
        localizedDescription = $d
        downloadURL          = $e.url
        size                 = $e.size
        minOSVersion         = $MinOSVersion
    }
    if ($e.sha256) { $o.sha256 = $e.sha256 }
    $versions += , ([pscustomobject]$o)
}

$latest = $entries[0]
$latestDesc = $desc[$latest.version]
if (-not $latestDesc) { $latestDesc = "猫窝 $($latest.version)" }

# 顶层 app 同时写 versions[] 与旧式扁平字段：新版商店读 versions，
# 老客户端/解析器读扁平字段，两套都指向同一个最新版。
$app = [ordered]@{
    name                 = '猫窝'
    bundleIdentifier     = 'com.meow.player.ios'
    developerName        = 'meow'
    subtitle             = 'iPhone / iPad 客户端（未签名 IPA）'
    localizedDescription = '猫窝 iPhone / iPad 客户端。包内自带 Java 后端与弹幕聚合，装好导入源包即可使用，不需要另起 Docker 或 PC 后端。未签名 IPA，需 Apple ID 自签；免费账号签名 7 天有效，过期在侧载工具里重签。'
    iconURL              = 'https://upchr.github.io/meow/logo-192.png'
    tintColor            = '#3478F6'
    category             = 'utilities'
    screenshots          = @()
    versions             = $versions
    version              = $latest.version
    versionDate          = $latest.date
    versionDescription   = $latestDesc
    downloadURL          = $latest.url
    size                 = $latest.size
}

$src = [ordered]@{
    name        = '猫窝 Meow'
    identifier  = 'com.meow.player.source'
    sourceURL   = $SourceURL
    description = '猫窝 iOS 端（未签名 IPA）。列表按版本记录，每条带该版本 IPA 与更新说明；用 SideStore / LiveContainer 添加本源即可安装与升级。'
    apps        = @([pscustomobject]$app)
    news        = @()
}

$json = $src | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($OutFile, $json, [Text.UTF8Encoding]::new($false))
Write-Host ("  · 源清单：{0} 个版本（最新 {1}），{2} 字节" -f $entries.Count, $latest.version, $json.Length) -ForegroundColor DarkGray
