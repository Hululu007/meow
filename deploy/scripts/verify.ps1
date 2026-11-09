# 部署/发版自检。改完脚本、加完插件、动过文档后跑一次。
#
# ## 为什么需要它
#
# 构建单元清单原本维护在三个地方（release.ps1 的数组、workflow 的步骤、
# README 的枚举），改一处忘两处就是"文档记录不及时"的真正原因。
# 现在真源是 deploy/units.json，但**没人保证它被更新**——
# 这个脚本把"该更新"变成机器可查的 FAIL。
#
# ## 十项检查
#
#   1. 构建单元        units.json 里每个 script 路径真实存在
#   2. 清单覆盖        全库 *.ps1 都被 units.json / 白名单覆盖（新增脚本没登记就报）
#   3. 语法           所有打包脚本 Parser::ParseFile 通过
#   4. 版本一致        bump-version.ps1 -Check
#   5. compose 有效    两个 compose 文件 docker compose config 解析成功
#   6. 文档引用        README + AGENTS + docs/*.md 里的脚本与文档路径都存在
#   7. 文档路径        文档里提到的 docker/Dockerfile/deploy 文件真实存在
#   8. 文档层级        活跃文档不超 15 份、全部在 00-目录索引 登记、H1 编号自洽
#   9. 归档引用        活跃文档不引用已移走的文档（会 404）
#  10. 构建目录         build/ 下不该堆一次性脚本（只警告，不 FAIL）
#
# 为什么第 6、7 项要扫 docs/*.md 而不只扫 README：
# 2026-10-26 实测发现 docs/36 里 `docker compose -f docker-compose.build.yml`
# 在仓库根目录跑会报 file not found——文件已迁到 deploy/docker/，但没人改文档。
# 只检查 README 的旧版自检当时报 7/7 通过，等于没检查。
#
# 用法：
#   ./deploy/scripts/verify.ps1              # 全检（约 10 秒，含 docker config）
#   ./deploy/scripts/verify.ps1 -Fast        # 跳过 docker（无 Docker 环境时）
#
# 退出码 0 = 全通过；非 0 = 有 FAIL（明细已打印）。

param(
    [switch]$Fast
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

$results = @()
function Check([string]$Name, [scriptblock]$Body) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $detail = ''
    $ok = $true
    try {
        $detail = & $Body
        if ($null -eq $detail) { $detail = '' }
    } catch {
        $ok = $false
        $detail = $_.Exception.Message
    }
    $sw.Stop()
    $script:results += [pscustomobject]@{ Name = $Name; Ok = $ok; Detail = "$detail"; Ms = [int]$sw.ElapsedMilliseconds }
    $color = if ($ok) { 'Green' } else { 'Red' }
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("{0} {1,-22} {2,5}ms  {3}" -f $mark, $Name, $sw.ElapsedMilliseconds, $(if ($ok) { $detail } else { "`n       " + $detail })) -ForegroundColor $color
}

Write-Host "`n===== 部署自检 =====" -ForegroundColor Cyan
Write-Host "仓库根：$root`n"

# ---------------------------------------------------------------- 0. units.json 可读
$unitsPath = Join-Path $root 'deploy/units.json'
$units = $null
Check 'units.json 可读' {
    if (-not (Test-Path $unitsPath)) { throw "文件不存在：deploy/units.json" }
    $script:units = [IO.File]::ReadAllText($unitsPath) | ConvertFrom-Json
    $n = $script:units.plugins.Count
    $c = @($script:units.chains.PSObject.Properties).Count
    "插件 $n 个，链路 $c 条"
}

if (-not $units) {
    Write-Host "`nunits.json 读不到，后续检查无法进行。" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- 1. 清单路径存在
Check '构建单元路径存在' {
    $missing = @()
    foreach ($u in $units.plugins) {
        if (-not (Test-Path (Join-Path $root $u.script))) { $missing += $u.script }
    }
    foreach ($k in @('pc', 'tv', 'docker')) {
        $c = $units.chains.$k
        if ($c -and -not (Test-Path (Join-Path $root $c.script))) { $missing += $c.script }
    }
    foreach ($x in @($units.index, $units.version)) {
        if ($x -and -not (Test-Path (Join-Path $root $x.script))) { $missing += $x.script }
    }
    if ($missing.Count) { throw ("缺失：`n       " + ($missing -join "`n       ")) }
    '全部存在'
}

# ---------------------------------------------------------------- 2. 清单覆盖（新增脚本没登记）
Check '全库脚本已被清单覆盖' {
    $declared = @()
    foreach ($u in $units.plugins) { $declared += ($u.script -replace '/', '\') }
    foreach ($k in @('pc', 'tv', 'docker')) {
        $c = $units.chains.$k
        if ($c) { $declared += ($c.script -replace '/', '\') }
    }
    foreach ($x in @($units.index, $units.version)) {
        if ($x) { $declared += ($x.script -replace '/', '\') }
    }

    # 白名单：开发辅助脚本（不产出发版产物，无需登记）
    $devHelpers = @(
        'client\run-desktop-debug.bat', 'client\start-desktop.bat', 'client\start-web.bat',
        'client\apps\desktop\build-gnu.bat',
        'server\host\build.bat', 'server\host\run.bat', 'server\host\start-api.bat',
        'server\serve-release.ps1',
        'server\serve-update-test.ps1',   # 本地测「应用在线更新」：造一份假版本清单，不发版
        'deploy\scripts\verify.ps1',       # 本脚本
        'deploy\scripts\build-plugins.ps1', # 插件单链路入口
        'deploy\scripts\release.ps1',       # 总编排入口（自身不被 units 引用）
        'deploy\scripts\sync-packages.ps1'  # CI 专用：把各插件 fnpack.json 汇总成 packages.json
    )

    # 只扫「可能放脚本的目录」，不递归全库：-Recurse + Include 实测 10 秒，
    # 因为在 node_modules / research / tv 上白跑。
    $scanDirs = @('deploy', 'server', 'client') | ForEach-Object { Join-Path $root $_ }
    $found = foreach ($d in $scanDirs) {
        if (-not (Test-Path $d)) { continue }
        Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object {
                ($_.Extension -in '.ps1', '.bat') -and
                $_.FullName -notmatch '[\\/](node_modules|research|build|tmp|release|tv|\\.git|target|dist)[\\/]'
            } |
            ForEach-Object { $_.FullName.Substring($root.Length + 1) }
    }

    $unlisted = @()
    foreach ($f in $found) {
        if ($declared -contains $f) { continue }
        if ($devHelpers -contains $f) { continue }
        $unlisted += $f
    }
    if ($unlisted.Count) {
        throw ("以下脚本未在 units.json 登记、也不在开发辅助白名单：`n       " +
               ($unlisted -join "`n       ") + "`n       => 请加进 units.json，或加进本脚本的 `$devHelpers")
    }
    "扫描 $($found.Count) 个脚本，全部有归属"
}

# ---------------------------------------------------------------- 3. 语法
Check '打包脚本语法' {
    $targets = @()
    foreach ($u in $units.plugins) { $targets += $u.script }
    foreach ($k in @('pc', 'tv', 'docker')) { $c = $units.chains.$k; if ($c) { $targets += $c.script } }
    foreach ($x in @($units.index, $units.version)) { if ($x) { $targets += $x.script } }
    $targets += 'deploy/scripts/build-plugins.ps1'

    $bad = @()
    foreach ($t in ($targets | Select-Object -Unique)) {
        $full = Join-Path $root $t
        if (-not (Test-Path $full)) { continue }
        $errs = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$null, [ref]$errs)
        if ($errs -and $errs.Count) { $bad += "$t : $($errs[0].Message)" }
    }
    if ($bad.Count) { throw ($bad -join "`n       ") }
    "$($targets.Count) 个脚本全通过"
}

# ---------------------------------------------------------------- 4. 脚本可跨平台
#
# ★ 为什么需要这一条（2026-10-30）：
#   `deploy/scripts/sync-packages.ps1` 里原来 8 处写死 `& curl.exe`。
#   Windows 上跑得好好的，但 CI 是 ubuntu runner，那里只有 `curl`：
#
#       The term 'curl.exe' is not recognized as a name of a cmdlet...
#
#   `release-v1.0.0` 的 Release 已成功建出来、三条构建链全绿，卡在最后
#   生成清单这一步 —— 客户端因此收不到更新，而本地怎么跑都是通的。
#
#   判据：**会进 CI 的脚本**里不许出现 OS 专属的可执行名。
#   用 `$CurlBin` 这类变量按 $IsWindows 分派即可，注释里提到不算。
Check '脚本不写死 OS 专属可执行名' {
    # 只查**在 ubuntu runner 上执行**的脚本。
    #   · sync-packages.ps1  —— 在 publish/sync-packages job（ubuntu）里跑
    #   · chains 里 runner=ubuntu 的（docker / tv）
    # Windows runner 上的（pc / 几个插件构建脚本）不受限：那里 curl.exe、
    # node.exe 都真实存在，写死是对的。
    $ciScripts = @('deploy/scripts/sync-packages.ps1')
    foreach ($k in @('pc', 'tv', 'docker')) {
        $c = $units.chains.$k
        if ($c -and $c.runner -eq 'ubuntu' -and $c.script) { $ciScripts += $c.script }
    }

    # 只在 Windows 存在的可执行名；Linux/macOS 上对应名字没有 .exe
    $osOnly = @('curl', 'pwsh', 'java', 'node', 'git')
    $bad = @()
    foreach ($t in ($ciScripts | Select-Object -Unique)) {
        $full = Join-Path $root $t
        if (-not (Test-Path $full)) { continue }
        $lines = [IO.File]::ReadAllLines($full, [Text.UTF8Encoding]::new($false))
        $inBlock = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            $trim = $line.Trim()
            # 跟踪 <# ... #> 块注释，整块跳过
            if ($inBlock) { if ($trim -match '#>') { $inBlock = $false }; continue }
            if ($trim -match '^<#') { if ($trim -notmatch '#>') { $inBlock = $true }; continue }
            if ($trim.StartsWith('#')) { continue }
            $code = $line
            $h = $code.IndexOf('#')
            if ($h -ge 0) { $code = $code.Substring(0, $h) }
            if (-not $code.Trim()) { continue }
            # 变量分派那一行本身合法（$CurlBin = ... 'curl.exe'）
            if ($code -match '\$\w+Bin\s*=') { continue }
            foreach ($b in $osOnly) {
                if ($code -match ($b + '\.exe')) {
                    $bad += ($t + ':' + ($i + 1) + '  ' + $trim)
                }
            }
        }
    }
    if ($bad.Count) {
        $msg = 'OS-only executable name in a script that runs on ubuntu (CI will fail): '
        throw ($msg + ($bad -join ' | '))
    }
    "已检查 " + $ciScripts.Count + " 个 ubuntu 脚本"
}

# ---------------------------------------------------------------- 5. 版本一致
Check '版本号一致（13 处）' {
    $bump = Join-Path $root $units.version.script
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $bump -Check 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($out -join "`n       ") }
    ($out | Select-Object -Last 1)
}

# ---------------------------------------------------------------- 5. compose 有效
Check 'compose 配置有效' {
    if ($Fast) { return '跳过（-Fast）' }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return '跳过（无 docker）' }
    $dd = Join-Path $root 'deploy/docker'
    foreach ($f in @('docker-compose.yml', 'docker-compose.build.yml')) {
        Push-Location $dd
        try {
            & docker compose -f $f config --quiet 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "$f 解析失败" }
        } finally { Pop-Location }
    }
    '两个文件均通过'
}

# ---------------------------------------------------------------- 6. 文档引用
# 判定分级（避免误报）：
#   · 显式路径（deploy/scripts/x.ps1）→ 该相对仓库根必须存在
#   · 相对写法（./build.bat、build-apk.ps1）→ 只要求同名脚本在仓库里存在
#     文档普遍写「cd server/host 再 ./build.bat」，逐条解析 cd 上下文太脆，
#     同名脚本存在就说明它没被删/改名——这才是想抓的回归
Check '文档里的脚本路径' {
    # 扫描范围：所有"活"文档（归档的不查——它们本就记录历史路径）
    $docs = @()
    foreach ($f in @('AGENTS.md', 'README.md', 'deploy/README.md')) {
        $p = Join-Path $root $f
        if (Test-Path $p) { $docs += $p }
    }
    $docs += Get-ChildItem (Join-Path $root 'docs') -Filter '*.md' -File |
        Where-Object { $_.DirectoryName -notmatch 'archive' } | ForEach-Object { $_.FullName }
    $docs += Get-ChildItem (Join-Path $root '.github/workflows') -Filter '*.yml' -File |
        ForEach-Object { $_.FullName }

    # 仓库里所有脚本的 basename（用于相对写法的校验）
    # ★ 用 git ls-files + 工作区实际存在两条来源：
    #   只查 git 会漏掉"已写好但还没提交"的新脚本，报成"仓库内无同名脚本"，
    #   而那种误报会让人去改文档/CI，方向完全错（实测踩过）。
    $known = @{}
    foreach ($s in (git -C $root ls-files | Where-Object { $_ -match '\.(ps1|bat)$' })) {
        $known[(Split-Path -Leaf $s)] = $true
    }
    foreach ($s in (Get-ChildItem -Path (Join-Path $root 'deploy'), (Join-Path $root 'server'), (Join-Path $root 'client') `
                -Filter '*.*' -Recurse -File -Include '*.ps1', '*.bat' -ErrorAction SilentlyContinue)) {
        $known[$s.Name] = $true
    }

    $bad = @()
    $checked = 0
    foreach ($d in $docs) {
        $text = [IO.File]::ReadAllText($d)
        $rel = $d.Substring($root.Length).TrimStart('\', '/')
        # 只查带目录分隔符的脚本引用；裸文件名跳过（文档本就省略前缀）
        $refs = [regex]::Matches($text, '[A-Za-z0-9_.\-/]*[\/][A-Za-z0-9_.\-/*]*\.(ps1|bat)') |
            ForEach-Object { $_.Value } | Select-Object -Unique
        foreach ($r in $refs) {
            if ($r -match '<') { continue }
            # 通配写法（.exe/.bat）与讲解用占位符不是真实引用
            if ($r -match '[\.\*]\w*\.(ps1|bat)$' -or $r -match '\.exe/') { continue }
            if ($r -match '(^|[\/])(x{2,}|xxx|foo|bar|[xy])\.(ps1|bat)$') { continue }
            # 非仓库路径（如 /c/Android/...）不归本检查管
            if ($r -match '^[\/]' -or $r -match '^[A-Za-z]:') { continue }
            $checked++
            if ($r -match '^\./') {
                # 相对写法：同名脚本存在即可
                $leaf = Split-Path -Leaf $r
                if (-not $known.ContainsKey($leaf)) { $bad += "$rel  →  $r（仓库内无同名脚本）" }
                continue
            }
            # 显式路径：相对仓库根或相对该文档目录
            $p1 = Join-Path $root $r
            $p2 = Join-Path (Split-Path -Parent $d) $r
            if (-not (Test-Path $p1) -and -not (Test-Path $p2)) { $bad += "$rel  →  $r" }
        }
    }
    if ($bad.Count) {
        throw ("以下脚本引用不存在：`n       " + ($bad -join "`n       ") +
               "`n       => 文档过时了，改成 units.json 里的实际路径")
    }
    "$($docs.Count) 份文档、$checked 处引用全部有效"
}

# ---------------------------------------------------------------- 7. 文档里的部署文件路径
# 只检查 **代码块里的命令**：说明文字和表格里列文件名是正常的。
# 判定：命令里出现 docker-compose.yml / Dockerfile.* / nginx.conf.template /
# .env.example，且在同一个代码块内它之前没有 `cd deploy/docker`（也没写全路径），
# 就说明按文档敲这条命令会 file not found。
Check '文档里的部署文件路径' {
    $docs = @()
    foreach ($f in @('AGENTS.md', 'README.md', 'deploy/README.md')) {
        $p = Join-Path $root $f
        if (Test-Path $p) { $docs += $p }
    }
    $docs += Get-ChildItem (Join-Path $root 'docs') -Filter '*.md' -File |
        Where-Object { $_.DirectoryName -notmatch 'archive' } | ForEach-Object { $_.FullName }

    $moved = 'docker-compose\.build\.yml|docker-compose\.yml|Dockerfile\.(web|apiserver|drpy)|nginx\.conf\.template|(?<![\w.])\.env\.example'
    $bad = @()
    foreach ($d in $docs) {
        $lines = [IO.File]::ReadAllText($d) -split "`r?`n"
        $rel = $d.Substring($root.Length).TrimStart('\', '/')
        $inFence = $false
        $sawChdir = $false          # 本代码块内是否已 cd deploy/docker
        for ($i = 0; $i -lt $lines.Count; $i++) {
            # 引用块里的代码块写成 `> ```bash`，围栏前有 '>'。不剥掉就整块漏检
            # （实测：docs/31 的 drpy buildx 命令就藏在引用块里，一直没被查到）
            $ln = $lines[$i] -replace '^\s*(>\s*)+', ''
            if ($ln -match '^\s*```') {
                if ($inFence) { $inFence = $false; $sawChdir = $false } else { $inFence = $true; $sawChdir = $false }
                continue
            }
            if (-not $inFence) { continue }
            # 注释行不算命令
            if ($ln -match '^\s*#') { continue }
            # 目录树里的文件名是示意，不是命令（│ ├ └ ─ 出现在行内）
            if ($ln -match '[│├└─]') { continue }
            if ($ln -match 'cd\s+deploy/docker') { $sawChdir = $true; continue }
            if ($sawChdir) { continue }
            if ($ln -match 'deploy/docker/') { continue }
            # 只查"像命令"的行：含 docker/cp/grep/cat/-f 等操作词。
            # 纯列举（如「.env / .env.example  MEOW_VERSION」）不算命令，跳过。
            if ($ln -notmatch '(^|\s)(docker|cp|mv|cat|vi|vim|nano|source|sed|grep|bash|sh)\s|(^|\s)-f\s|--file') { continue }
            if ($ln -match $moved) {
                $bad += "$rel`:$($i + 1)  →  $($ln.Trim())"
            }
        }
    }
    if ($bad.Count) {
        throw ("以下命令块在仓库根目录执行已迁移的文件（会 file not found）：`n       " +
               (($bad | Select-Object -Unique) -join "`n       ") +
               "`n       => 块内先加 cd deploy/docker，或写全路径 deploy/docker/<文件名>")
    }
    '代码块内的部署命令目录正确'
}

# ---------------------------------------------------------------- 8. 文档层级完整性
# 2026-10-27 文档从 35 份收缩到 15 份。三项检查防它再膨胀回去：
#   · 活跃份数不得超上限（超了必须先归档一份，不是删一个警告）
#   · 活跃目录里每份都必须在 00-目录索引.md 登记（防"偷偷加一份没人知道"）
#   · 文件名编号必须与 H1 标题编号一致（历史上 48-feature 的标题写 "# 44"，
#     制造了一条指向另一份文档的错误交叉引用）
Check '文档层级与登记' {
    $docsDir = Join-Path $root 'docs'
    $active = Get-ChildItem $docsDir -Filter '*.md' -File |
        Where-Object { $_.Name -ne '00-目录索引.md' }
    $limit = 15  # 正文（不含索引本身）
    $bad = @()

    if ($active.Count -gt $limit) {
        $bad += "活跃文档 $($active.Count) 份，超过上限 $limit 份" +
                " => 先把一份移入 archive/ 并登记原因，再新增"
    }

    $index = [IO.File]::ReadAllText((Join-Path $docsDir '00-目录索引.md'))
    foreach ($d in $active) {
        if ($index -notmatch [regex]::Escape($d.Name)) {
            $bad += "$($d.Name) 未在 00-目录索引.md 登记"
        }
        # 拿文件名前两位当编号，与 H1 里的编号比对
        if ($d.Name -match '^(\d{2})-') {
            $num = $Matches[1]
            $h1 = (Get-Content $d.FullName -TotalCount 1 -Encoding UTF8)
            if ($h1 -match '^#\s+(\d{2})\b' -and $Matches[1] -ne $num) {
                $bad += "$($d.Name) 的 H1 写的是 # $($Matches[1])，与文件名编号 $num 不一致"
            }
        }
    }

    if ($bad.Count) { throw ($bad -join "`n       ") }
    "活跃 $($active.Count)/$limit 份，全部已登记且编号自洽"
}

# ---------------------------------------------------------------- 9. 归档文档不被活跃文档引用
# 归档后仍有正文引用指向 docs/NN-xxx.md（已移走）就会 404。
# 只查活跃文档与仓库级 README/AGENTS，归档文档之间互相引用是正常的历史线索。
Check '活跃文档无失效引用' {
    $docs = @()
    foreach ($f in @('AGENTS.md', 'README.md', 'deploy/README.md', 'server/README.md', 'client/README.md')) {
        $p = Join-Path $root $f
        if (Test-Path $p) { $docs += $p }
    }
    $docs += Get-ChildItem (Join-Path $root 'docs') -Filter '*.md' -File |
        ForEach-Object { $_.FullName }

    $bad = @()
    foreach ($d in $docs) {
        $text = [IO.File]::ReadAllText($d)
        $rel = $d.Substring($root.Length).TrimStart('\', '/')
        # 只查 docs/NN-xxx.md 形式（含 ../docs/ 与 archive/ 前缀的排除在下面做）
        $refs = [regex]::Matches($text, '(?:\.\./)?docs/([0-9]{2}-[a-z0-9\-]+\.md)') |
            ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
        foreach ($r in $refs) {
            $p1 = Join-Path $root "docs/$r"
            $p2 = Join-Path $root "docs/archive/$r"
            if (-not (Test-Path $p1) -and -not (Test-Path $p2)) {
                $bad += "$rel  →  docs/$r"
            }
        }
    }
    if ($bad.Count) {
        throw ("以下引用指向不存在的文档：`n       " + (($bad | Select-Object -Unique) -join "`n       ") +
               "`n       => 已归档的改成 docs/archive/<名>.md，已删除的改指替代文档")
    }
    '无失效文档引用'
}

# ---------------------------------------------------------------- 10. 构建目录不堆一次性脚本
# `build/` 是可重建产物目录（gitignore），不是存放工具脚本的地方。
# 实测 2026-10-27 有 23 个 .py/.mjs 躺在 build/.tmp/ 里——它们该在 tmp/<日期>-<主题>/。
# 这条只 CONSOLE 警告不 FAIL：历史遗留不追溯，但要拦住新增。
Check '构建目录无一次性脚本' {
    $buildDir = Join-Path $root 'build'
    if (-not (Test-Path $buildDir)) { return '无 build/ 目录' }
    $found = Get-ChildItem $buildDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in '.py', '.ps1', '.mjs', '.sh' }
    if ($found.Count -eq 0) { return '干净' }
    # 只警告不抛错：这批是历史遗留，规则从今天起对新文件生效
    Write-Host ("       ⚠ build/ 下有 $($found.Count) 个脚本，按 AGENTS §0.1 该放 tmp/<日期>-<主题>/：") -ForegroundColor Yellow
    $found | Select-Object -First 3 | ForEach-Object {
        Write-Host ("         " + $_.FullName.Substring($root.Length + 1)) -ForegroundColor Yellow
    }
    if ($found.Count -gt 3) {
        Write-Host ("         ...还有 $($found.Count - 3) 个") -ForegroundColor Yellow
    }
    "历史遗留 $($found.Count) 个（不 FAIL，新增请放 tmp/）"
}

# ---------------------------------------------------------------- 更新说明格式
# 用户明确要求（2026-11-04）：每版必须「1. 2. 3.」编号 + 每条一句话。
# 生成端（sync-packages.ps1 / release.yml）会补编号，但**长句补不了**——
# 所以在这里挡住"写了编号但一条两百字"的情况。
Check 'CHANGELOG 更新说明格式' {
    $f = Join-Path $root 'CHANGELOG.md'
    if (-not (Test-Path $f)) { throw 'CHANGELOG.md 不存在' }
    $lines = [IO.File]::ReadAllLines($f, [Text.UTF8Encoding]::new($false))
    $ver = $null
    $body = @()
    foreach ($ln in $lines) {
        if ($ln -match '^##\s+(.+?)\s*$') {
            if ($ver) { break }
            # 先用变量接住标题：下面的 -match 会覆盖 $Matches，
            # 而带捕获组的写法会让 $ver 变成 "-fix7"（踩过）
            $title = $Matches[1]
            if ($title -match '^[0-9]+\.[0-9]+\.[0-9]+(?:-fix[0-9]+)?$') { $ver = $title }
            continue
        }
        if ($ver) { $body += $ln }
    }
    if (-not $ver) { throw '找不到版本小节（## x.y.z）' }
    $items = @($body | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($items.Count -lt 1) { throw "$ver 小节是空的" }
    if ($items.Count -gt 6) { throw "$ver 有 $($items.Count) 条，超过 6 条上限（弹框只显示 4 条）" }
    $i = 0
    foreach ($t in $items) {
        $i++
        if ($t -notmatch '^\d+\.\s+\S') { throw "$ver 第 $i 行没按「1. 」编号：$t" }
        $text = $t -replace '^\d+\.\s+', ''
        if ($text.Length -gt 60) { throw "$ver 第 $i 条 $($text.Length) 字，超过 60 字（要一句话简述）" }
    }
    "$ver · $($items.Count) 条，编号与长度均合规"
}

# ---------------------------------------------------------------- 汇总
$failed = @($results | Where-Object { -not $_.Ok })
Write-Host "`n===== $($results.Count - $failed.Count)/$($results.Count) 通过 =====" -ForegroundColor $(if ($failed.Count) { 'Red' } else { 'Green' })
if ($failed.Count) {
    Write-Host "失败项：" -ForegroundColor Red
    $failed | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Red }
    exit 1
}
Write-Host "全部通过。" -ForegroundColor Green
exit 0
