# 构建 apiserver 插件（fat jar + jlink 精简 JRE）
#
# 产物：
#   plugins/apiserver/
#   ├── manifest.json
#   ├── apiserver.jar      ← fat jar（含 6 个依赖，可直接 java -jar）
#   ├── jre/               ← jlink 裁剪运行时（~45MB）
#   ├── dist/              ← spider jar 等运行时资源（可热更新，不打进镜像）
#   └── data/              ← 首次运行自动创建
#
# 为什么要 jlink 而不是 GraalVM native-image：
#   宿主靠 Class.forName 动态加载 883 个 spider 类，native-image 无法在构建期
#   穷举这些反射入口，强行 AOT 会在运行时报 ClassNotFoundException。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File build-plugin.ps1
#   powershell -ExecutionPolicy Bypass -File build-plugin.ps1 -SkipJre   # 只做 jar

param(
    [switch]$SkipJre,
    [switch]$SkipDex2Jar
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$out  = Join-Path $root 'build\plugins\apiserver'
$tmp  = Join-Path $root 'build\.tmp\plugin-build'
$jdk  = (Get-Command javac).Source | Split-Path
$javaHome = Split-Path $jdk -Parent

Write-Host "JDK: $javaHome" -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. 编译
Write-Host "`n[1/5] 编译源码..." -ForegroundColor Yellow
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path "$tmp\classes" -Force | Out-Null
New-Item -ItemType Directory -Path "$tmp\stage"   -Force | Out-Null

$sources = Get-ChildItem -Path "$root\host\src" -Recurse -Filter *.java | ForEach-Object { $_.FullName }
# javac 的 @argfile 不认 UTF-8 BOM（PS 5.1 的 -Encoding UTF8 会写 BOM），必须用 ASCII
[System.IO.File]::WriteAllLines("$tmp\sources.txt", $sources, [System.Text.Encoding]::ASCII)
Write-Host "  源文件: $($sources.Count) 个"

# javac 的"注: 使用未经检查的操作"是 stderr 警告，不是错误。
# 用 cmd 重定向避免 PowerShell 把 stderr 当成 NativeCommandError 抛异常。
$javacLog = cmd /c "javac -encoding UTF-8 -cp ""$root\host\libs\*"" -d ""$tmp\classes"" @""$tmp\sources.txt"" 2>&1"
$javacCode = $LASTEXITCODE
$javacLog | Where-Object { $_ -match '错误|error:' } | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
if ($javacCode -ne 0) { throw "javac 失败" }
Write-Host "  编译成功" -ForegroundColor Green

# ---------------------------------------------------------------- 2. 打 fat jar
Write-Host "`n[2/5] 打包 fat jar..." -ForegroundColor Yellow
Push-Location "$tmp\classes"
try {
    # 把依赖 jar 解开合并（只取 class 与资源，丢弃 META-INF 签名避免校验失败）
    #
    # ★ 必须排除 spider.jar。
    #
    # 踩过（2026-10-29，PC 插件丢源的真正原因）：
    # spider.jar 里有只差大小写的同名类路径 ——
    #   com/github/catvod/spider/merge/N/F.class
    #   com/github/catvod/spider/merge/N/f.class
    #   com/github/catvod/spider/merge/n/f.class
    # 这在 Linux/macOS 打包的 zip 里合法（区分大小写），但 **Windows 解压时
    # 后两个会覆盖前者**：实测 883 个 class 解出来只剩 571 个，
    # fat jar 里 merge/n/f 直接消失。运行时表现是
    #   NoClassDefFoundError: com/github/catvod/spider/merge/N/F
    #   (wrong name: com/github/catvod/spider/merge/n/f)
    # 于是 Bili / SP360 / Duopan / SaoHuo 等依赖这些混淆类的源全部失败
    # （PC 插件只出 7 个源、MuMu 出 10 个 —— 差异就来自这里）。
    #
    # spider.jar 本来就不该进 fat jar：manifest 用
    #   -cp "apiserver.jar;dist/spider.jar"
    # 单独挂它，就是为了"换 spider 版本不用重打 fat jar"（见本脚本 dist/ 的注释）。
    # 合并进来既违背设计，又必然踩大小写冲突。
    Get-ChildItem "$root\host\libs\*.jar" |
        Where-Object { $_.Name -ne 'spider.jar' } |
        ForEach-Object {
        $depTmp = Join-Path $tmp "dep-$($_.BaseName)"
        New-Item -ItemType Directory -Path $depTmp -Force | Out-Null
        Push-Location $depTmp
        & "$javaHome\bin\jar" xf $_.FullName
        # 关键：必须在这里删，而不是合并完再删。
        # bcprov.jar 是签名 jar，它解出来的 META-INF/*.SF 会跟着 Copy-Item 一起
        # 进入合并目录；如果只在最后删一次，某些依赖的签名已覆盖同名条目，
        # 运行时仍会抛 SecurityException: Invalid signature file digest。
        if (Test-Path 'META-INF') {
            Get-ChildItem 'META-INF' -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Extension -in '.SF', '.RSA', '.DSA' } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        }
        Pop-Location
        Copy-Item -Path "$depTmp\*" -Destination . -Recurse -Force -ErrorAction SilentlyContinue
    }
    # 再兜一次底（合并后可能又有同名签名文件被带进来）
    if (Test-Path 'META-INF') {
        Get-ChildItem 'META-INF' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in '.SF', '.RSA', '.DSA' } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Path "$out" -Force | Out-Null
    & "$javaHome\bin\jar" --create --file "$out\apiserver.jar" --main-class ApiServer .
    if ($LASTEXITCODE -ne 0) { throw "jar 打包失败" }
} finally {
    Pop-Location
}
$jarSize = [math]::Round((Get-Item "$out\apiserver.jar").Length / 1MB, 1)
Write-Host "  apiserver.jar: ${jarSize}MB" -ForegroundColor Green

# ---------------------------------------------------------------- 3. jdeps 分析
#
# 【为什么最终不用 jdeps 的结果】实测踩过两次：
#   1) jdeps 给出 java.base,java.naming,java.net.http,java.sql,jdk.httpserver，
#      缺 jdk.crypto.ec → 所有 HTTPS 请求抛 SSLException（爱奇艺弹幕 0 条、
#      聚合搜索 groups=0）。该模块是被 TLS 层动态加载的，静态分析看不见。
#   2) spider 的 883 个类靠 Class.forName 加载（含 merge.c.i 这类混淆名），
#      jdeps 完全无法推断，裁完必现 ClassNotFoundException。
# 所以这里只把 jdeps 结果**打印出来做参考**，实际用显式白名单。
if (-not $SkipJre) {
    Write-Host "`n[3/5] jdeps 分析（仅参考，实际用白名单）..." -ForegroundColor Yellow
    $jdepsArgs = @('--multi-release','17','--ignore-missing-deps','--print-module-deps',
                   '--class-path',"$root\host\libs\*","$out\apiserver.jar")
    $jdepsOut = & "$javaHome\bin\jdeps" @jdepsArgs 2>&1
    $jdepsLine = ($jdepsOut | Select-Object -Last 1)
    if ($jdepsLine) { Write-Host "  jdeps 认为: $($jdepsLine.Trim())" -ForegroundColor DarkGray }

    # 显式白名单（不用 jdeps 结果，原因见上）
    $modules = @(
        'java.base',        # 核心
        'java.naming',      # DNS / JNDI
        'java.net.http',    # HttpClient（WebDAV 用，PROPFIND 必须）
        'java.sql',         # spider 里的 sqlite 引用
        'jdk.httpserver',   # com.sun.net.httpserver（HTTP 服务本体）
        'jdk.crypto.ec',    # ★ TLS 椭圆曲线；漏了所有 HTTPS 都会 SSLException
        'jdk.unsupported',  # sun.misc.Unsafe（okhttp / BouncyCastle 依赖）
        'java.management',  # JMX（部分库探测用）
        'java.security.jgss',
        'java.security.sasl',
        'java.xml',         # XML 解析（弹幕/配置）
        'java.logging',
        'jdk.zipfs'         # zip 文件系统（读取 jar 内资源）
    ) -join ','
    Write-Host "  使用模块: $modules"

    Write-Host "`n[4/5] jlink 裁剪运行时（首次约需 1-2 分钟）..." -ForegroundColor Yellow
    $jreOut = "$out\jre"
    if (Test-Path $jreOut) { Remove-Item $jreOut -Recurse -Force }
    $jlinkArgs = @('--add-modules',$modules,'--strip-debug','--no-header-files',
                   '--no-man-pages','--compress=2','--output',$jreOut)
    & "$javaHome\bin\jlink" @jlinkArgs 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "jlink 失败" }
    $jreSize = [math]::Round(((Get-ChildItem $jreOut -Recurse | Measure-Object -Property Length -Sum).Sum) / 1MB, 1)
    Write-Host "  jre: ${jreSize}MB" -ForegroundColor Green
} else {
    Write-Host "`n[3-4/5] 跳过 jlink（-SkipJre）" -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- 5. 资源 + manifest
Write-Host "`n[5/5] 复制资源与 manifest..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path "$out\dist" -Force | Out-Null
# dist/ 下有很多历史产物（spider-complete-latest 等），插件只需要一个可用的 spider.jar。
# 注意：spider.jar 不在 fat jar 里，而是由 manifest 的 -cp "apiserver.jar;dist/spider.jar"
# 挂到 classpath —— 这样用户换 spider 版本时不用重新打包。
# build/dist 是 gitignore 的本地产物目录（CI/新克隆里不存在），必须先判存在。
# 首跑实测：CI 上直接 Get-ChildItem 报 Cannot find path，exit 1 中断整条链。
$distSrc = Join-Path $root 'build/dist'
if (Test-Path $distSrc) {
    Get-ChildItem $distSrc -File -Filter '*.json' | Copy-Item -Destination "$out\dist" -Force -ErrorAction SilentlyContinue
} else {
    Write-Host '  (build/dist 不存在：跳过其中的 *.json)' -ForegroundColor DarkGray
}
if (Test-Path (Join-Path $distSrc "spider.jar")) {
    Copy-Item (Join-Path $distSrc "spider.jar") "$out\dist\spider.jar" -Force
} elseif (Test-Path "$root\host\libs\spider.jar") {
    Copy-Item "$root\host\libs\spider.jar" "$out\dist\spider.jar" -Force
} else {
    # 公开壳：源码库不带 spider.jar。插件仍可运行（豆瓣/CMS/直连源），
    # jar 站点由用户在应用内导入源包后由 Jars.reload() 挂载。
    Write-Host '  (纯壳插件：不含 spider.jar，用户需导入源包)' -ForegroundColor Yellow
}
Copy-Item "$root\plugin-manifests\apiserver.manifest.json" "$out\manifest.json" -Force

# dex2jar：JVM 导入 dex 源时在插件内完成转换，不依赖宿主安装 Java/工具。
# 运行期 Dex2Jvm 会按 cwd 找 tools/dex2jar，不需要写 manifest env。
if (-not $SkipDex2Jar) {
    $repoRoot = Split-Path $root -Parent
    $fetch = Join-Path $repoRoot 'deploy\scripts\fetch-dex2jar.ps1'
    $dexSrc = Join-Path $root 'tools\dex2jar'
    if (-not (Test-Path (Join-Path $dexSrc 'lib'))) {
        if (-not (Test-Path $fetch)) { throw "找不到 dex2jar 获取脚本：$fetch" }
        & $fetch -Dest $dexSrc
    }
    New-Item -ItemType Directory -Path "$out\tools" -Force | Out-Null
    if (Test-Path "$out\tools\dex2jar") { Remove-Item "$out\tools\dex2jar" -Recurse -Force }
    Copy-Item $dexSrc "$out\tools\dex2jar" -Recurse -Force
    $dexMb = [math]::Round(((Get-ChildItem "$out\tools\dex2jar" -Recurse | Measure-Object Length -Sum).Sum) / 1MB, 1)
    Write-Host "  tools/dex2jar: ${dexMb}MB" -ForegroundColor Green
} else {
    Write-Host '  (跳过 dex2jar：插件不支持 dex 源转换)' -ForegroundColor Yellow
}

# 校验：有 jar 就报大小；没有也不阻断（纯壳插件是合法产物）。
$spiderJar = Join-Path $out 'dist\spider.jar'
if (Test-Path $spiderJar) {
    $spiderMb = [math]::Round((Get-Item $spiderJar).Length / 1MB, 1)
    Write-Host "  dist/spider.jar: ${spiderMb}MB" -ForegroundColor Green
} else {
    Write-Host '  dist/spider.jar: 未包含（纯壳插件）' -ForegroundColor Yellow
}

Write-Host "`n完成: $out" -ForegroundColor Cyan
Get-ChildItem $out | ForEach-Object {
    $sz = '<dir>'
    if (-not $_.PSIsContainer) { $sz = [string]([math]::Round($_.Length / 1KB, 1)) + 'KB' }
    Write-Host ('  ' + $_.Name.PadRight(20) + ' ' + $sz)
}
