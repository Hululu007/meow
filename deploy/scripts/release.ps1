# 发版总编排：一次跑完「前端 dist → PC 包 → TV 包 → 插件 → Docker → 汇总落位」。
#
# ## 为什么需要这个脚本
#
# 0.9.1–0.9.11 每次发版都是照 docs/31 的发版记录手动串十来条命令，
# 踩过的坑（按时间序）：PC 嵌入资源因 cargo 缓存不更新、PC 构建被运行中的
# exe 锁文件、版本号 13 处漏改、TV 包打进旧前端。本脚本把前置校验和步骤
# 顺序固化下来，每步计时，产物统一落 release/v<版本>/。
#
# ## 用法
#
#   .\release.ps1                       # 全量（版本号读 client/package.json）
#   .\release.ps1 -SkipDocker           # 产物只落本地，不推镜像
#   .\release.ps1 -DockerDryRun         # 镜像只构建不推送
#   .\release.ps1 -SkipPc -SkipTv       # 只出插件 + Docker
#   .\release.ps1 -Plan                 # 只打印将执行的步骤
#   .\release.ps1 -Publish              # 构建完直接传 GitHub Release（本地闭环，零额度）
#
# ## -Publish 做了什么（补的是「本地发版客户端收不到更新」这个缺口）
#
#   建 tag（无前缀 v<版本>）→ 推送 → 建 **draft** Release → 传 exe/apk/zip
#   → 调 sync-packages.ps1 生成并上传 packages.json
#
#   ★ tag 必须无前缀：带前缀会触发 CI 全量（约 45 分钟额度），与
#     「本地发版不烧额度」的初衷相反。脚本里做了硬校验。
#   ★ Release 建成 draft，**需要人工去网页点 Publish** 才对客户端可见。
#     这一步刻意不代做 —— 发布是对外动作。
#   ★ 之后仍要 git commit 源码：-Publish 只建 tag 指向当前 HEAD，
#     工作区若有未提交改动，产物与 tag 对应的源码会不一致。
#
# ## 刻意不做的事
#
#   不 git commit（提交节奏由人控制）；-Publish 只建 tag 并推送该 tag
#   不改版本号（先跑 deploy/scripts/bump-version.ps1，这里只校验一致性）
#   不写发布说明正文（生成草稿，人工定稿）
#
# 单条链路想单独跑：PC=client\apps\desktop\build-gnu.ps1，
# TV=client\apps\tv\build-apk.ps1，插件=server\build-plugin*.ps1，
# Docker=deploy/scripts/build-push-docker.ps1。详见 deploy/README.md。

param(
    [string]$Version,
    [string]$DockerUser = 'chrplus',
    [string[]]$DockerPlatforms,
    [switch]$SkipPc,
    [switch]$SkipTv,
    [switch]$SkipPlugins,
    [switch]$SkipDocker,
    [switch]$DockerDryRun,
    [switch]$DockerNoLatest,
    [switch]$DockerWebFromDist,
    [switch]$NoNotes,
    [switch]$Force,
    [switch]$Plan,
    # 构建完直接把产物传到 GitHub Release（★ 用**无前缀** tag，不触发 CI）
    [switch]$Publish,
    # -Publish 用的 tag 名。空 = v<版本>（无前缀 = 零额度）
    [string]$PublishTag,
    # 仓库（owner/repo），与 sync-packages 一致
    [string]$Repo = 'upchr/meow'
)

$ErrorActionPreference = 'Stop'
# 仓库根：脚本在 deploy/scripts/，退两层才是根（client/ server/ docs/ 所在处）
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# 构建单元清单：唯一真源 deploy/units.json
# （加/删构建单元只改这里，不必再改脚本数组、workflow 步骤、文档枚举）
$unitsPath = Join-Path $root 'deploy/units.json'
if (-not (Test-Path $unitsPath)) { throw "找不到构建单元清单：$unitsPath" }
$units = [IO.File]::ReadAllText($unitsPath) | ConvertFrom-Json
$total = [Diagnostics.Stopwatch]::StartNew()

# ---------------------------------------------------------------- 版本与前置
$pkg = Join-Path $root 'client\package.json'
if (-not $Version) { $Version = ([IO.File]::ReadAllText($pkg) | ConvertFrom-Json).version }
if (-not $Version) { throw '读不到版本号，请用 -Version 指定' }

# -Publish 的前缀校验必须在这里做，不能等 Run-Step 里 ——
# 那时已经构建完 30 分钟，才发现 tag 会触发 CI 全量，代价太大。
if ($Publish) {
    $earlyTag = if ($PublishTag) { $PublishTag } else { "v$Version" }
    if ($earlyTag -match '^(release|docker|tv|pc|plugins|pcplugins)-') {
        throw "-PublishTag 不能用带前缀的 tag（$earlyTag）：会触发 CI 全量构建（约 45 分钟额度）。用无前缀的 v<版本>。"
    }
    $earlyTok = $env:GITHUB_TOKEN
    if (-not $earlyTok) { try { $earlyTok = (& gh auth token 2>$null).Trim() } catch { } }
    if (-not $earlyTok) { throw "-Publish 需要 GitHub 令牌（gh auth login 或设 GITHUB_TOKEN）" }
}
$OutDir = Join-Path $root "release\v$Version"

Write-Host "发版版本：$Version" -ForegroundColor Cyan

# 一致性是发版的地基：13 处必须同一版本，否则各产物互相认不出。
# 用子进程跑：bump-version 用 exit 表达结果，同进程 & 调用拿不到退出码。
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root $units.version.script) -Check
if ($LASTEXITCODE -ne 0) { throw '版本号不一致，先跑 bump-version.ps1 -Version <目标>' }

$gitDirty = @(git status --porcelain)
if ($gitDirty.Count) {
    Write-Host "⚠ 工作区有 $($gitDirty.Count) 个未提交文件——产物将包含未提交内容，建议先提交或确认这是有意的：" -ForegroundColor Yellow
    $gitDirty | Select-Object -First 6 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
}

$steps = @()
# 步骤文案从 units.json 生成，避免「清单改了、提示没改」
if (-not $SkipPc)      { $steps += "PC 安装包 + 裸 exe（$($units.chains.pc.script)）" }
if (-not $SkipTv)      { $steps += "TV APK（$($units.chains.tv.script)）" }
if (-not $SkipPlugins) {
    $ids = ($units.plugins | ForEach-Object { $_.id }) -join '+'
    $steps += "插件 [$ids] + 清单（$($units.index.script)）"
}
if (-not $SkipDocker)  { $steps += "Docker 三镜像（build-push-docker.ps1 → $DockerUser）" }
$steps += "汇总落位 release\v$Version + SHA256SUMS"

if ($Plan) {
    Write-Host "`n将执行：" -ForegroundColor Cyan
    $steps | ForEach-Object { Write-Host "  · $_" }
    if ($Publish) {
        $tagName = if ($PublishTag) { $PublishTag } else { "v$Version" }
        Write-Host "  · 发布到 GitHub Release（tag=$tagName，draft，需人工 Publish）" -ForegroundColor Yellow
        Write-Host "    → sync-packages.ps1 生成并上传 packages.json" -ForegroundColor Yellow
    }
    return
}

if (Test-Path $OutDir) {
    if (-not $Force) { throw "$OutDir 已存在。确认要重建就加 -Force（会清空重放）。" }
    Remove-Item $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function Run-Step([string]$Name, [scriptblock]$Body) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n===== $Name =====" -ForegroundColor Cyan
    & $Body
    $sw.Stop()
    Write-Host ("（耗时 {0:mm\:ss}）" -f $sw.Elapsed) -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 前端 dist
# PC 的 tauri beforeBuildCommand 会自己再跑一遍，但 web 镜像（-WebFromDist）
# 与 TV 的 assets 都直接消费这个目录——这里先做一次，保证三方拿到同一份。
Run-Step '前端 dist（pnpm build）' {
    Push-Location (Join-Path $root 'client')
    try {
        pnpm --filter '@meow/web' build
        if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- PC
if (-not $SkipPc) {
    Run-Step 'PC 安装包 + 裸 exe' {
        & (Join-Path $root $units.chains.pc.script) @($units.chains.pc.args)
        if ($LASTEXITCODE -ne 0) { throw 'PC 构建失败' }
        $rel = Join-Path $root 'client\apps\desktop\src-tauri\target\x86_64-pc-windows-gnu\release'
        # 按"文件名含当前版本"找安装包：目录里有旧版本的包不算数（0.9.0 踩过，
        # 当成新包发出去才发现 VersionInfo 还是旧的）
        $installer = Get-ChildItem (Join-Path $rel 'bundle\nsis') -Filter "*$Version*x64-setup.exe" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $installer) { throw "找不到版本含 $Version 的安装包（bundle\nsis）——build 是否真的出了新包？" }
        Copy-Item $installer.FullName (Join-Path $OutDir $installer.Name)
        $bare = Join-Path $rel 'meow-player.exe'
        if (-not (Test-Path $bare)) { throw "找不到裸 exe：$bare" }
        Copy-Item $bare (Join-Path $OutDir "猫窝-裸exe-$Version.exe")
        Write-Host "  → $($installer.Name) + 猫窝-裸exe-$Version.exe"
    }
}

# ---------------------------------------------------------------- TV
if (-not $SkipTv) {
    Run-Step 'TV APK' {
        & (Join-Path $root $units.chains.tv.script) -OutDir $OutDir
    }
}

# ---------------------------------------------------------------- 插件
if (-not $SkipPlugins) {
    Run-Step '插件 x4' {
        foreach ($u in $units.plugins) {
            $full = Join-Path $root $u.script
            if (-not (Test-Path $full)) {
                if ($u.required) { throw "缺少必需插件脚本：$($u.script)" }
                Write-Host "  跳过 $($u.id)（脚本不存在）" -ForegroundColor DarkYellow
                continue
            }
            # 可选插件的前置（如 danmu 需要不入库的上游源码）
            if ($u.needs -and -not (Test-Path (Join-Path $root $u.needs))) {
                if ($u.required) { throw "$($u.id) 缺少前置：$($u.needs)" }
                Write-Host "  跳过 $($u.id)（缺 $($u.needs)）" -ForegroundColor DarkYellow
                continue
            }
            Write-Host "  · $($u.id) → $($u.script)"
            & $full
            if ($LASTEXITCODE -ne 0) {
                # 可选插件失败只警告，不阻断其余产物（CI 里 ffmpeg 下载常失败）
                if ($u.required) { throw "$($u.id) 构建失败" }
                Write-Host "  ! $($u.id) 构建失败，继续（非必需）" -ForegroundColor Yellow
            }
        }
    }
    Run-Step '插件源清单（packages index）' {
        & (Join-Path $root $units.index.script) -OutDir (Join-Path $OutDir 'plugins')
    }
}

# ---------------------------------------------------------------- Docker
if (-not $SkipDocker) {
    Run-Step 'Docker 三镜像' {
        # ★ 必须用 hashtable 而不是数组 splatting。
        #
        # 数组形式 `@('-User', $DockerUser, '-Version', $Version)` 在
        # PowerShell 5.1 里会**按位置绑定**参数：多带一个 `-WebFromDist`
        # 时它被当成 `-Version` 的值传下去，于是 build-push-docker 收到
        # `-Version -WebFromDist`，docker buildx 报
        # `"-Version": unknown operating system or architecture`（实测踩过）。
        # hashtable 是按名字绑定，switch 参数写 `$true` 即可。
        $pushArgs = @{
            User    = $DockerUser
            Version = $Version
        }
        if ($DockerPlatforms) { $pushArgs['Platforms'] = ($DockerPlatforms -join ',') }
        if ($DockerDryRun) { $pushArgs['DryRun'] = $true }
        if ($DockerNoLatest) { $pushArgs['NoLatest'] = $true }
        if ($DockerWebFromDist) { $pushArgs['WebFromDist'] = $true }
        & (Join-Path $root 'deploy/scripts/build-push-docker.ps1') @pushArgs
        if ($LASTEXITCODE -ne 0) { throw 'Docker 推送失败' }
    }
}

# ---------------------------------------------------------------- SHA256SUMS
Run-Step 'SHA256SUMS' {
    # 不能用 Set-Content -Encoding utf8：PS5.1 会带 BOM，sha256sum -c 解析不了首行
    $enc = New-Object System.Text.UTF8Encoding($false)
    $sums = Join-Path $OutDir 'SHA256SUMS.txt'
    $files = Get-ChildItem $OutDir -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | Sort-Object FullName
    $lines = foreach ($f in $files) {
        $rel = $f.FullName.Substring($OutDir.Length + 1).Replace('\', '/')
        "$((Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower())  $rel"
    }
    [IO.File]::WriteAllLines($sums, $lines, $enc)
    Write-Host "  → SHA256SUMS.txt（$($files.Count) 个文件）"
    Write-Host "  校验：sha256sum -c SHA256SUMS.txt（在本目录里跑）"
}

# ---------------------------------------------------------------- 发布说明草稿
if (-not $NoNotes) {
    Run-Step 'RELEASE-NOTES 草稿' {
        # 不用 git describe：它对 stderr 的处理在 PS5.1 Stop 偏好下会假失败
        $prev = git tag --sort=-v:refname | Select-Object -First 1
        $range = if ($prev) { "$prev..HEAD" } else { 'HEAD' }
        $log = @(git log --no-merges --pretty='format:%s' $range)
        $enc = New-Object System.Text.UTF8Encoding($false)
        $notes = New-Object System.Collections.Generic.List[string]
        $notes.Add("# $Version 发布说明")
        $notes.Add('')
        $notes.Add('> 草稿：由 release.ps1 从 git log（' + $range + '）生成，发布前必须人工定稿——')
        $notes.Add('> 提交语言 ≠ 用户语言：删掉内部行号与测试细节，按用户可感知的变化重写。')
        $notes.Add('')
        $notes.Add('## 变更清单（原始提交信息）')
        $notes.Add('')
        foreach ($l in $log) { $notes.Add('- ' + $l) }
        $notes.Add('')
        $notes.Add('## 升级与安装')
        $notes.Add('')
        $notes.Add('- 产物见本目录与 SHA256SUMS.txt；插件源清单 plugins/index.json')
        $notes.Add('- 镜像：docker pull chrplus/meow-web:' + $Version)
        [IO.File]::WriteAllLines((Join-Path $OutDir 'RELEASE-NOTES.md'), $notes, $enc)
        Write-Host "  → RELEASE-NOTES.md（草稿，来自 $range）"
    }
}


<#
.SYNOPSIS 带重试的 curl（GitHub API 专用）
.DESCRIPTION
    本机到 api.github.com 的 TLS 握手抖动频繁（实测 3 次里 2 次失败：
    `curl: (35) schannel: failed to receive handshake`），不重试会让
    -Publish 随机失败。CI 那边靠 actions 内置重试，本地得自己加。

    重试只对"传输层失败"有用：HTTP 4xx/5xx 是业务错误，立刻返回不重试。
#>
# 跨平台 curl：Windows 用 curl.exe，Linux/macOS 只有 curl。
# 写死 curl.exe 会让脚本只能在本机跑（2026-10-30 sync-packages 在 CI 上就因此全挂）。
$CurlBin = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'curl.exe' } else { 'curl' }

function Invoke-CurlRetry {
    param(
        [Parameter(Mandatory)][string[]]$CurlArgs,
        [int]$Tries = 5,
        # 允许 HTTP 4xx（用于"资源不存在"这种正常分支，如查 Release 是否存在）
        [switch]$AllowHttpError
    )
    $last = ""
    for ($i = 1; $i -le $Tries; $i++) {
        # 不用 2>&1：curl 的进度/警告走 stderr，并进来会被 PowerShell 当成
        # 错误记录（NativeCommandError），即使退出码 0 也刷一片红。
        #
        # 不加 --fail 时 HTTP 404 的退出码仍是 0 —— "Release 不存在"会被
        # 当成成功，解析出一份 {"message":"Not Found"} 再往下才炸，错误信息误导。
        # 加 --fail 后 4xx/5xx 变成退出码 22。
        #
        # 不能写 `@failArg` 再让 if 返回空数组：PowerShell 空数组展开会把后面
        # 的参数吃掉，报 `curl: option -: is unknown`。用两份显式调用。
        if ($AllowHttpError) {
            $out = & $CurlBin @CurlArgs 2>$null
        } else {
            $out = & $CurlBin @CurlArgs '--fail' 2>$null
        }
        $code = $LASTEXITCODE
        if ($code -eq 0) { return ($out -join "`n") }

        $last = ($out -join "`n")
        if (-not $last) { $last = "curl exit=$code" }

        # ★ 区分两类失败，只重试传输层的：
        #   22 = HTTP 4xx/5xx（业务错误，重试没意义，立即抛）
        #   28 = 超时、35 = TLS 握手失败、56 = 连接被重置…（这些才值得重试）
        #   不区分的话，一个 404 会白等 1+2+3+4=10 秒还重试 5 次。
        $isHttpError = ($code -eq 22)
        if ($isHttpError -or $i -ge $Tries) {
            throw "curl 失败（exit=$code）：$last"
        }
        Write-Host ("    传输失败（curl exit=$code），第 $i/$Tries 次，重试…") -ForegroundColor DarkYellow
        Start-Sleep -Seconds $i
    }
}

# ---------------------------------------------------------------- 发布到 GitHub Release
#
# 为什么需要这一段：本地 release.ps1 出完产物就结束，**GitHub 上什么都没有**，
# 客户端读不到清单 → 永远显示"已是最新版本"。而走 CI 要烧约 45 分钟额度
# 且要盯十几分钟。这一段把「建 Release + 上传 + 生成清单」补上，本地闭环。
#
# ★ tag 用**无前缀** v<版本>：带前缀（release-v*）会触发 CI 全量构建，
#   正是要避免的（AGENTS.md §5.0 红线）。脚本里做了硬校验。
# ★ Release 建成 **draft**：与 CI 一致。draft 的资产对 API 不可见，
#   所以必须人工点 Publish —— 这一步刻意不代做（发布是对外动作）。
if ($Publish -and -not $Plan) {
    Run-Step '发布到 GitHub Release' {
        if (-not $PublishTag) { $PublishTag = "v$Version" }

        # 前缀校验：唯一会把"省额度"变成"烧 45 分钟"的地方
        if ($PublishTag -match '^(release|docker|tv|pc|plugins|pcplugins)-') {
            throw "-PublishTag 不能用带前缀的 tag（$PublishTag）：那会触发 CI 全量构建。用无前缀的 v<版本>。"
        }

        $dirty = git status --porcelain
        if ($dirty) {
            Write-Host "  ! 工作区有未提交改动：产物来自工作区，而 tag 指向已提交的 HEAD，" -ForegroundColor Yellow
            Write-Host "    两者可能不一致。建议先 commit 再 -Publish。" -ForegroundColor Yellow
        }

        $token = $env:GITHUB_TOKEN
        if (-not $token) { try { $token = (& gh auth token 2>$null).Trim() } catch { } }
        if (-not $token) { throw "没有 GitHub 令牌（gh auth login，或设 GITHUB_TOKEN）" }

        # ① tag：不存在就建在 HEAD（幂等，方便重跑）
        $existing = git tag --list $PublishTag
        if (-not $existing) {
            git tag -a $PublishTag -m "release $Version" 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "建 tag 失败：$PublishTag" }
            Write-Host "  tag 已建：$PublishTag"
        } else {
            Write-Host "  tag 已存在，复用：$PublishTag"
        }
        git push origin $PublishTag 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ! tag 推送失败（可能远端已有同名不同内容的 tag），继续尝试建 Release" -ForegroundColor Yellow
        }

        # ② 只上传安装包与插件 zip，不带中间产物
        $up = @(Get-ChildItem $OutDir -File -Recurse | Where-Object { $_.Extension -in @('.exe', '.apk', '.zip') })
        if ($up.Count -eq 0) { throw "release/v$Version 里没有可上传的产物（.exe/.apk/.zip）" }
        Write-Host ("  待上传 " + $up.Count + " 个文件")

        $apiBase = "https://api.github.com/repos/$Repo"

        # ③ 建 draft Release（已存在则复用）
        $rel = $null
        try {
            $relJson = Invoke-CurlRetry -CurlArgs @(
                "-sS", "--max-time", "30",
                "-H", "Authorization: Bearer $token",
                "-H", "Accept: application/vnd.github+json",
                "$apiBase/releases/tags/$PublishTag"
            ) -AllowHttpError
            $rel = $relJson | ConvertFrom-Json
        } catch { $rel = $null }

        if (-not $rel -or -not $rel.id) {
            $bodyObj = @{
                tag_name = $PublishTag
                name     = $PublishTag
                draft    = $true
                body     = "本地发版自动化生成。确认产物后在网页点 Publish 才会对客户端可见。"
            }
            $bodyFile = Join-Path $env:TEMP 'meow-rel-body.json'
            [IO.File]::WriteAllText($bodyFile, ($bodyObj | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
            try {
                $relJson = Invoke-CurlRetry -CurlArgs @(
                    "-sS", "--max-time", "30",
                    "-X", "POST",
                    "-H", "Authorization: Bearer $token",
                    "-H", "Accept: application/vnd.github+json",
                    "--data-binary", "@$bodyFile",
                    "$apiBase/releases"
                )
                $rel = $relJson | ConvertFrom-Json
            } finally {
                Remove-Item $bodyFile -ErrorAction SilentlyContinue
            }
            if (-not $rel.id) { throw "建 Release 失败：$($rel.message)" }
            Write-Host ("  draft Release 已建：id=" + $rel.id)
        } else {
            Write-Host ("  Release 已存在：id=" + $rel.id)
        }

        # ④ 逐个上传（同名先删，等价 --clobber）
        $uploadBase = ($rel.upload_url -replace '\{.*$', '')
        foreach ($f in $up) {
            foreach ($o in @($rel.assets | Where-Object { $_.name -eq $f.Name })) {
                Invoke-CurlRetry -CurlArgs @(
                    "-sS", "--max-time", "30",
                    "-X", "DELETE",
                    "-H", "Authorization: Bearer $token",
                    "$apiBase/releases/assets/$($o.id)"
                ) | Out-Null
            }
            $respJson = Invoke-CurlRetry -CurlArgs @(
                "-sS", "--max-time", "300",
                "-X", "POST",
                "-H", "Authorization: Bearer $token",
                "-H", "Content-Type: application/octet-stream",
                "--data-binary", "@$($f.FullName)",
                "$uploadBase`?name=$([uri]::EscapeDataString($f.Name))"
            )
            $resp = $respJson | ConvertFrom-Json
            if (-not $resp.id) { throw "上传 $($f.Name) 失败：$($resp.message)" }
            Write-Host ("  上传 " + $f.Name + "  (" + [math]::Round($f.Length / 1MB, 2) + " MB)")
        }

        # ⑤ 生成并上传清单（复用 CI 那套脚本，保证两条路径产出一致）
        Write-Host "  生成清单（sync-packages.ps1）…"
        & (Join-Path $PSScriptRoot 'sync-packages.ps1') -Tag $PublishTag -Repo $Repo
        if ($LASTEXITCODE -ne 0) { throw "生成/上传清单失败" }

        Write-Host ''
        Write-Host '  ★ 还差一步：去 GitHub 把这个 draft Release 点 Publish' -ForegroundColor Yellow
        Write-Host "    https://github.com/$Repo/releases" -ForegroundColor Yellow
        Write-Host '    不点的话客户端看不到更新（draft 的资产对 API 不可见）' -ForegroundColor Yellow
    }
}


# ---------------------------------------------------------------- 汇总
$total.Stop()
$files = Get-ChildItem $OutDir -Recurse -File
$mb = [math]::Round(($files | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "`n===== 完成 =====" -ForegroundColor Green
Write-Host "产物目录：$OutDir（$($files.Count) 个文件，$mb MB，总耗时 $([int]$total.Elapsed.TotalMinutes) 分钟）"
Get-ChildItem $OutDir | ForEach-Object {
    Write-Host ("  {0,9} KB  {1}" -f [math]::Round($_.Length / 1KB, 0), $_.Name)
}
Write-Host ''
Write-Host '接下来是人工动作（脚本刻意不代做）：' -ForegroundColor Cyan
Write-Host '  1. 定稿 RELEASE-NOTES.md'
Write-Host '  2. sha256sum -c SHA256SUMS.txt 复核'
Write-Host '  3. git commit + tag（版本号已由 bump-version.ps1 对齐）'
Write-Host '  4. 冒烟验收（docs/38 §一）：起一个容器/装一次包，导入外部配置看站点数'
