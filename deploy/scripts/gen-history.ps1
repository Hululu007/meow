# 从仓库根 CHANGELOG.md 生成 history.json —— 应用内「关于 → 版本历史」的数据源。
#
# 为什么要单独一个文件：packages.json 每个包只保留最新一条 desc（更新弹框用），
# 历史版本没人存。CHANGELOG.md 是发版门禁文件（verify.ps1 校验格式），拿它当唯一真源，
# 生成一份给客户端读的 JSON，比让客户端解析 Markdown 稳。
#
# 产出结构（客户端 api/changelog.ts 按这个解析）：
#   { "schema_version": 1, "generated_at": "...", "versions": [
#       { "version": "1.2.16", "lines": ["1. …", "2. …"] }, … ] }
#
# 用法：
#   pwsh deploy/scripts/gen-history.ps1                    # 默认写临时目录
#   pwsh deploy/scripts/gen-history.ps1 -OutFile out.json
# sync-packages.ps1 更新 updates 分支时会调用它，把 history.json 和 packages.json
# 放进同一个 orphan 提交。
param(
    [string]$RepoRoot,
    [string]$OutFile
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
if (-not $OutFile) { $OutFile = Join-Path ([IO.Path]::GetTempPath()) 'meow-history.json' }

$changelog = Join-Path $RepoRoot 'CHANGELOG.md'
if (-not (Test-Path -LiteralPath $changelog)) { throw "找不到 CHANGELOG.md: $changelog" }

$versions = New-Object System.Collections.ArrayList
$cur = $null

foreach ($line in Get-Content -LiteralPath $changelog -Encoding UTF8) {
    # 版本小节标题必须恰好是 "## 1.2.16"（CHANGELOG 的写作约定）
    if ($line -match '^##\s+(\d+\.\d+\.\d+)\s*$') {
        if ($null -ne $cur) { [void]$versions.Add($cur) }
        $cur = [ordered]@{ version = $Matches[1]; lines = (New-Object System.Collections.ArrayList) }
        continue
    }
    # 其它 "## " 小节（如「怎么写」「与 git log 的关系」）= 文档说明，跳过其正文
    if ($line -match '^##\s') {
        if ($null -ne $cur) { [void]$versions.Add($cur) }
        $cur = $null
        continue
    }
    if ($null -eq $cur) { continue }
    $t = $line.Trim()
    if ($t.Length -gt 0) { [void]$cur.lines.Add($t) }
}
if ($null -ne $cur) { [void]$versions.Add($cur) }

if ($versions.Count -eq 0) { throw 'CHANGELOG.md 里一个版本小节都没解析到（标题要写成 ## 1.2.16）' }

# 版本日期：用发版 tag（release-v<版本>）的创建时间。CHANGELOG 本身不记日期，
# 而 tag 就是"这一版发出去"的那一刻。CI 里 sync-packages 之前已经 git fetch --tags。
# 拿不到（无 tag / 非 git 目录 / 老版本没打过 tag）就**不写这个字段**，客户端不显示日期。
$dates = @{}
$datePrio = @{}
if (Get-Command git -ErrorAction SilentlyContinue) {
    # 仓库里有多种 tag 前缀：release-v*（全量发版）、v*（版本标记）、fpk-v* / pc-v* 等单链。
    # 同一版本可能多个 tag：优先级 release-v(3) > v(2) > 其它单链(1)，取最高的那个日期。
    $tagLines = & git -C $RepoRoot for-each-ref --format='%(refname:short)|%(creatordate:short)' 'refs/tags/*' 2>$null
    foreach ($tl in $tagLines) {
        if ($tl -notmatch '^(.+)\|(\d{4}-\d{2}-\d{2})$') { continue }
        $tagName = $Matches[1]
        $tagDate = $Matches[2]
        $ver = ''
        $prio = 0
        if ($tagName -match '^release-v(\d+\.\d+\.\d+)$') { $ver = $Matches[1]; $prio = 3 }
        elseif ($tagName -match '^v(\d+\.\d+\.\d+)$') { $ver = $Matches[1]; $prio = 2 }
        elseif ($tagName -match '-v(\d+\.\d+\.\d+)$') { $ver = $Matches[1]; $prio = 1 }
        if (-not $ver) { continue }
        if (-not $datePrio.ContainsKey($ver) -or $datePrio[$ver] -lt $prio) {
            $dates[$ver] = $tagDate
            $datePrio[$ver] = $prio
        }
    }
}

# ArrayList → 数组，避免 ConvertTo-Json 把嵌套集合序列化成奇怪的东西
$out = [ordered]@{
    schema_version = 1
    generated_at   = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    versions       = @($versions | ForEach-Object {
        $e = [ordered]@{ version = $_.version }
        if ($dates.ContainsKey($_.version)) { $e['date'] = $dates[$_.version] }
        $e['lines'] = @($_.lines)
        $e
    })
}

$json = $out | ConvertTo-Json -Depth 6
# 必须 UTF-8 无 BOM：BOM 会让浏览器 JSON.parse 直接抛错
[IO.File]::WriteAllText($OutFile, $json, (New-Object Text.UTF8Encoding($false)))

Write-Host ("history.json: {0} 个版本 -> {1} ({2} bytes)" -f $versions.Count, $OutFile, (Get-Item -LiteralPath $OutFile).Length)
