# TV APK 构建入口。
#
# ## 为什么需要这个脚本
#
# 0.9.1–0.9.11 的 TV 包都是手动敲 gradle 命令 + 手动复制改名的。
# 踩过的坑全在"前置不满足"上：
#   - web dist 是旧的（gradle 只在改了原生代码时才重打包，assets 同步任务
#     会被 up-to-date 判定跳过）→ APK 里是旧前端
#   - keystore.properties 不在 → 静默退回 debug 签名，用户没法覆盖安装
#   - 版本号没对齐（versionName 与 web/package.json 不一致）
# 本脚本把这三件事都变成硬校验，过了才碰 gradle。
#
# ## 用法
#
#   .\build-apk.ps1                          # 构建 release 签名包，落到 release/v<版本>\
#   .\build-apk.ps1 -Variant debug           # 调试包
#   .\build-apk.ps1 -FreshDist               # 强制重跑前端构建
#   .\build-apk.ps1 -NoCopy                  # 只构建，不复制到 release 目录
#
# gradle 不依赖 wrapper：按 PATH → ANDROID_HOME → C:\Android 顺序探测。

param(
    [string]$OutDir = '',
    [ValidateSet('release', 'debug')]
    [string]$Variant = 'release',
    [string]$Gradle = '',
    [switch]$FreshDist,
    [switch]$NoCopy
)

$ErrorActionPreference = 'Stop'
$tvDir = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $tvDir))
$sw = [Diagnostics.Stopwatch]::StartNew()

function Step([string]$Name) { Write-Host "`n[$Name]" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 版本号
Step '版本号校验'
$webVer = ([IO.File]::ReadAllText((Join-Path $root 'client\apps\web\package.json')) | ConvertFrom-Json).version
$gradleText = [IO.File]::ReadAllText((Join-Path $tvDir 'app\build.gradle'))
if ($gradleText -notmatch "versionName '([^']+)'") { throw "build.gradle 里找不到 versionName" }
$tvVer = $Matches[1]
if ($tvVer -ne $webVer) {
    throw "版本不一致：web=$webVer，TV=$tvVer。先跑根目录 bump-version.ps1 -Version <目标> 再来。"
}
$p = $tvVer.Split('.')
$expectCode = [int]$p[0] * 1000 + [int]$p[1] * 100 + [int]$p[2]
if ($gradleText -notmatch "versionCode $expectCode\b") {
    throw "versionCode 不是 $expectCode（与 $tvVer 不匹配）。bump-version.ps1 会一并改它。"
}
Write-Host "web=$webVer  tv=$tvVer  versionCode=$expectCode"

# ---------------------------------------------------------------- 构建目标
Step '前端构建目标'
# 电视/投影仪盒子的 WebView 普遍停在 Chrome 80–100，而 Vite 默认
# baseline-widely-available 是 107+。产物里的可选 catch 绑定（ES2019）
# 会让老内核直接语法报错，整页白屏且打不出 JS 错误（踩过：ARM 投影仪黑屏）。
# 这里硬校验 target，避免有人为了代码好看把它调回默认。
$viteCfg = [IO.File]::ReadAllText((Join-Path $root 'client\apps\web\vite.config.ts'))
if ($viteCfg -notmatch "target:\s*'es20(1[5-9]|[0-1][0-9])'") {
    throw "client\apps\web\vite.config.ts 的 build.target 必须是 es2015–es2019 之间的值（当前 TV 要求 es2017），否则老 WebView 会白屏。"
}
if ($viteCfg -notmatch "target:\s*'es2017'") {
    Write-Host "⚠ build.target 不是 es2017：老内核上可选 catch 绑定不会被降级" -ForegroundColor Yellow
}
Write-Host "build.target 校验通过" -ForegroundColor Green

# ---------------------------------------------------------------- 签名
Step '签名检查'
$ks = Join-Path $tvDir 'keystore.properties'
if ($Variant -eq 'release') {
    if (Test-Path $ks) {
        Write-Host "keystore.properties 存在，将出 release 签名包" -ForegroundColor Green
    } else {
        Write-Host "✗ 找不到 keystore.properties：gradle 会静默退回 debug 签名，" -ForegroundColor Red
        Write-Host "  用户将无法覆盖安装正式版。确认后用 -Variant debug 明确表达意图。" -ForegroundColor Red
        throw "release 构建缺少签名配置"
    }
}

# ---------------------------------------------------------------- 前端 dist
Step '前端 dist'
$webDir = Join-Path $root 'client\apps\web'
$distDir = Join-Path $webDir 'dist'
$needBuild = $FreshDist -or -not (Test-Path (Join-Path $distDir 'index.html'))
if (-not $needBuild) {
    # src 或构建配置比 dist 新 → dist 过期。gradle 的 up-to-date 判定不会替你发现这个。
    # index.html 也在依赖里：首帧主题脚本改它却不改 src 时 dist 同样过期。
    # （Tailwind v4 没有 JS 配置文件，样式在 CSS 里，别把 tailwind.config 加进来）
    # ★ 必须用「逐个 +=」而不是 @((Get-ChildItem ...), (Get-Item ...))：
    #   后者把 Get-ChildItem 返回的 FileInfo[] 当成**一个元素**嵌套进数组，
    #   于是 Measure-Object -Maximum 只在 4 个对象上比较、类型还混着，
    #   结果恒为旧值 —— 表现是"改了前端，脚本一直报 dist 已是最新"（实测踩过）。
    $inputs = @()
    $inputs += Get-ChildItem (Join-Path $webDir 'src') -Recurse -File
    $inputs += Get-Item (Join-Path $webDir 'package.json')
    $inputs += Get-Item (Join-Path $webDir 'vite.config.ts')
    $inputs += Get-Item (Join-Path $webDir 'index.html')
    $newest = ($inputs | ForEach-Object { $_.LastWriteTimeUtc } |
        Sort-Object -Descending | Select-Object -First 1)
    # 取 dist **内部最新的文件**，不能用目录的 LastWriteTime：文件被原地覆盖时
    # 目录 mtime 不变，会误判成"已是最新"，把旧前端打进 APK（实测踩过：
    # 改了 CachePanel.vue 后脚本报"dist 已是最新，跳过"）。
    $distTime = (Get-ChildItem $distDir -Recurse -File |
        Measure-Object LastWriteTimeUtc -Maximum).Maximum
    if ($newest -gt $distTime) {
        Write-Host "dist 过期（src 最新改动 $newest > dist $distTime），重跑构建"
        $needBuild = $true
    }
}
if ($needBuild) {
    Push-Location (Join-Path $root 'client')
    try { pnpm --filter '@meow/web' build; if ($LASTEXITCODE -ne 0) { throw '前端构建失败' } }
    finally { Pop-Location }
} else {
    Write-Host 'dist 已是最新，跳过'
}

# ---------------------------------------------------------------- gradle
Step 'gradle'
$gradleCmd = $Gradle
if (-not $gradleCmd) {
    $c = Get-Command gradle -ErrorAction SilentlyContinue
    if ($c) { $gradleCmd = $c.Source }
}
if (-not $gradleCmd) {
    $roots = @()
    if ($env:ANDROID_HOME) { $roots += $env:ANDROID_HOME }
    $roots += 'C:\Android'
    foreach ($r in $roots) {
        $hit = Get-ChildItem "$r\gradle-*\bin\gradle.bat" -ErrorAction SilentlyContinue |
            Sort-Object { [version]$_.Directory.Parent.Name -replace '^gradle-', '' } -ErrorAction SilentlyContinue |
            Select-Object -Last 1
        if ($hit) { $gradleCmd = $hit.FullName; break }
    }
}
if (-not $gradleCmd -or -not (Test-Path $gradleCmd)) {
    throw "找不到 gradle。装一个或用 -Gradle 指定 gradle.bat 的绝对路径（本机历史用 C:\Android\gradle-8.9）。"
}
Write-Host "gradle: $gradleCmd"
$javaOk = $false
try { $javaOk = ([version](& java -version 2>&1 | Select-Object -First 1) -ge [version]'17') } catch { }
if (-not $javaOk) { Write-Host '⚠ java 不在 PATH 或低于 17，gradle 可能用 JAVA_HOME 里另一个 JDK' -ForegroundColor Yellow }

# ---------------------------------------------------------------- 内置 jar
Step '内置 dex jar'
# TV 的「本机执行」是端内网关，用 DexClassLoader 加载 APK 里的 spider.jar。
# ★ 2026-11-05 查出：这个文件是构建产物、又被 assets/.gitignore 忽略过，
#   CI 出的 1.0.0 / 1.0.5 / 1.0.7 全都没带它 —— 发布版"本机执行"直接全废
#   （所有 jar 站点 ClassNotFoundException），而且构建成功、没有任何报警。
#   现在入库（.gitignore 放行）+ 本地与 CI 两边都加断言。
$spiderJar = Join-Path $tvDir 'app\src\main\assets\spider.jar'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$hasBundledJar = Test-Path $spiderJar
if ($hasBundledJar) {
    $jarZip = [IO.Compression.ZipFile]::OpenRead($spiderJar)
    try {
        $hasDex = @($jarZip.Entries | Where-Object { $_.FullName -eq 'classes.dex' }).Count -gt 0
    } finally { $jarZip.Dispose() }
    if (-not $hasDex) {
        throw "assets\spider.jar 不是 dex 形态（没有 classes.dex）：Android 的 DexClassLoader 只认 classes.dex，class 版装上去会一律报「jar 里没有类」"
    }
    Write-Host "spider.jar: $([math]::Round((Get-Item $spiderJar).Length / 1MB, 1)) MB，含 classes.dex"
} else {
    # 公开壳：源码库不带 jar。纯壳 APK 合法，用户在设置页导入源包后恢复。
    Write-Host '纯壳构建：未找到 assets\spider.jar（用户需在设置页导入源包）' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 打包
Step 'gradle assemble'
Push-Location $tvDir
try {
    & $gradleCmd "assemble$($Variant.Substring(0,1).ToUpper() + $Variant.Substring(1))" --console=plain
    if ($LASTEXITCODE -ne 0) { throw "gradle 退出码 $LASTEXITCODE" }
} finally { Pop-Location }

$apk = Join-Path $tvDir "app\build\outputs\apk\$Variant\app-$Variant.apk"
if (-not (Test-Path $apk)) { throw "产物不存在：$apk" }
# ---------------------------------------------------------------- APK 自检
# 只校验源文件不够：gradle 的 assets 合并、后续清理任务都可能把它漏掉。
# CI 那三个版本正是"构建成功、包里没有"，所以这里直接拆包断言。
$apkZip = [IO.Compression.ZipFile]::OpenRead($apk)
try {
    $inApk = @($apkZip.Entries | Where-Object { $_.FullName -eq 'assets/spider.jar' }).Count -gt 0
} finally { $apkZip.Dispose() }
if ($hasBundledJar -and -not $inApk) {
    throw "APK 自检失败：源目录有 assets/spider.jar，但包内没有（gradle 合并丢了）"
}
if ($hasBundledJar) {
    Write-Host 'APK 自检：assets/spider.jar 在包内'
} else {
    Write-Host 'APK 自检：纯壳（无内置 jar）' -ForegroundColor Yellow
}
$sw.Stop()
$sizeMb = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Write-Host "构建完成：$apk（$sizeMb MB，耗时 $([int]$sw.Elapsed.TotalSeconds)s）"

# ---------------------------------------------------------------- 落位
if ($NoCopy) { return }
if (-not $OutDir) { $OutDir = Join-Path $root "release\v$tvVer" }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$dest = if ($Variant -eq 'release') { Join-Path $OutDir "猫窝-TV-$tvVer.apk" } else { Join-Path $OutDir "猫窝-TV-$tvVer-debug.apk" }
Copy-Item $apk $dest -Force
$hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
Write-Host "`n已落位：$dest"
Write-Host "sha256: $hash"
