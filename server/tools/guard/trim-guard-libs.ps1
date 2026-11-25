# 按目标平台裁剪 guard-libs 里的原生库（只删别的平台的 .so/.dll/.dylib，不动 class）。
#
# 与 trim-guard-libs.sh 同一套规则（两份必须同步改；改完各跑一次 -- 见 README）。
# 为什么可以裁：guard-helper.jar 里改过的 org.scijava.nativelib.NativeLoader 只按
# os.name / os.arch 选**一个** natives/<平台>/ 目录；keystone / capstone / jna /
# demumble 各自也只按 JNA 平台名取自己那份。
#
# 用法：.\trim-guard-libs.ps1 -Target win-x64 -Dir <guard-libs 目录>
#
# 约束：只处理下面 6 类 jar；keep 前缀命中数必须 >= 1（缺就 throw，防上游改目录名后
# 静默发出残缺包）；class 数量前后必须一致；重复执行不会再变。
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('win-x64', 'linux-x64', 'linux-arm64')]
    [string]$Target,
    [Parameter(Mandatory = $true)]
    [string]$Dir
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Dir)) { throw "目录不存在: $Dir" }
$dirFull = (Resolve-Path $Dir).Path

# 规则顺序有意义：unidbg-unicorn2-* 必须先于 unicorn-[0-9]* 匹配
$rules = @{
    'win-x64' = @(
        @{ Glob = 'unidbg-unicorn2-*.jar'; Keeps = @() },
        @{ Glob = 'unicorn-[0-9]*.jar';    Keeps = @('natives/windows_64/') },
        @{ Glob = 'keystone-*.jar';        Keeps = @('win32-x86-64/') },
        @{ Glob = 'capstone-*.jar';        Keeps = @('win32-x86-64/') },
        @{ Glob = 'demumble-*.jar';        Keeps = @() },
        @{ Glob = 'jna-[0-9]*.jar';        Keeps = @('com/sun/jna/win32-x86-64/') }
    )
    'linux-x64' = @(
        @{ Glob = 'unidbg-unicorn2-*.jar'; Keeps = @('natives/linux_64/') },
        @{ Glob = 'unicorn-[0-9]*.jar';    Keeps = @() },
        @{ Glob = 'keystone-*.jar';        Keeps = @('linux-x86-64/') },
        @{ Glob = 'capstone-*.jar';        Keeps = @('linux-x86-64/', 'natives/linux_64/') },
        @{ Glob = 'demumble-*.jar';        Keeps = @('natives/linux_64/') },
        @{ Glob = 'jna-[0-9]*.jar';        Keeps = @('com/sun/jna/linux-x86-64/') }
    )
    'linux-arm64' = @(
        @{ Glob = 'unidbg-unicorn2-*.jar'; Keeps = @('natives/linux_arm64/') },
        @{ Glob = 'unicorn-[0-9]*.jar';    Keeps = @() },
        @{ Glob = 'keystone-*.jar';        Keeps = @('linux-aarch64/') },
        @{ Glob = 'capstone-*.jar';        Keeps = @('linux-aarch64/') },
        @{ Glob = 'demumble-*.jar';        Keeps = @('natives/linux_arm64/') },
        @{ Glob = 'jna-[0-9]*.jar';        Keeps = @('com/sun/jna/linux-aarch64/') }
    )
}[$Target]

$nativeExt = @('.so', '.dll', '.dylib', '.jnilib', '.a')

function Get-JarList([string]$Jar) {
    # Windows 上 jar.exe 输出 CRLF，PowerShell 会按行剥掉；这里显式 Trim 兜底
    & jar --list --file $Jar | ForEach-Object { $_.Trim() }
}

# keep 前缀必须各命中至少一个原生库文件；返回命中总数，缺项直接 throw。
# 只数 .so/.dll/.dylib/.jnilib/.a —— keystone 等 jar 里还有 .gitkeep，不能拿它充数。
function Get-KeepCount([string]$Jar, [string[]]$Keeps) {
    $got = 0
    foreach ($p in $Keeps) {
        $n = @(Get-JarList $Jar | Where-Object {
            $_.StartsWith($p) -and -not $_.EndsWith('/') -and ($nativeExt -contains [IO.Path]::GetExtension($_))
        }).Count
        if ($n -lt 1) { throw "$(Split-Path $Jar -Leaf) 缺少本平台原生库: $p（上游可能改了目录名）" }
        $got += $n
    }
    return $got
}

function Trim-One([string]$Jar, [string[]]$Keeps) {
    $base = Split-Path $Jar -Leaf
    $before = (Get-Item $Jar).Length
    $clsBefore = @(Get-JarList $Jar | Where-Object { $_ -match '\.class$' }).Count

    # 幂等短路：先看有没有要删的原生库。没有就只做断言、不重打 ——
    # 重打包要重压缩整 jar，臂架构（QEMU）实测 ~50s；同一目录被重复 trim 很常见。
    $need = $false
    foreach ($e in @(Get-JarList $Jar | Where-Object {
                -not $_.EndsWith('/') -and ($nativeExt -contains [IO.Path]::GetExtension($_)) })) {
        $keep = $false
        foreach ($p in $Keeps) { if ($e.StartsWith($p)) { $keep = $true; break } }
        if (-not $keep) { $need = $true; break }
    }
    if (-not $need) {
        $gotSkip = Get-KeepCount $Jar $Keeps
        Write-Host ("  {0}: 已是目标平台的裁剪结果，跳过重打（原生库 {1} 个）" -f $base, $gotSkip) -ForegroundColor DarkGray
        return
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('guard-trim-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $out = "$work.jar"
    try {
        Push-Location $work
        try {
            & jar --extract --file $Jar | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "解包失败: $base" }
        } finally { Pop-Location }

        Get-ChildItem $work -Recurse -File | Where-Object { $nativeExt -contains $_.Extension } | ForEach-Object {
            $rel = $_.FullName.Substring($work.Length + 1).Replace('\', '/')
            $keep = $false
            foreach ($p in $Keeps) { if ($rel.StartsWith($p)) { $keep = $true; break } }
            if (-not $keep) { Remove-Item $_.FullName -Force }
        }

        # 清掉删空的平台目录（按路径长度从深到浅，一次就能清干净）
        Get-ChildItem $work -Recurse -Directory |
            Sort-Object { $_.FullName.Length } -Descending |
            Where-Object { -not (Get-ChildItem $_.FullName -Force) } |
            ForEach-Object { Remove-Item $_.FullName -Force }

        Push-Location $work
        try {
            & jar --create --file $out . | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "重打包失败: $base" }
        } finally { Pop-Location }

        $clsAfter = @(Get-JarList $out | Where-Object { $_ -match '\.class$' }).Count
        if ($clsBefore -ne $clsAfter) { throw "$base class 数量变了: $clsBefore -> $clsAfter" }

        $got = Get-KeepCount $out $Keeps

        Move-Item -Force $out $Jar
        $after = (Get-Item $Jar).Length
        Write-Host ("  {0}: {1:N1}MB -> {2:N1}MB  (保留原生库 {3} 个)" -f $base, ($before / 1MB), ($after / 1MB), $got) -ForegroundColor DarkGray
    } finally {
        if (Test-Path $work) { Remove-Item $work -Recurse -Force }
        if (Test-Path $out) { Remove-Item $out -Force }
    }
}

Write-Host "[trim] target=$Target dir=$dirFull" -ForegroundColor Yellow
$handled = 0
foreach ($jar in (Get-ChildItem $dirFull -File -Filter '*.jar')) {
    $rule = $rules | Where-Object { $jar.Name -like $_.Glob } | Select-Object -First 1
    if (-not $rule) { continue }
    Trim-One $jar.FullName $rule.Keeps
    $handled++
}
if ($handled -eq 0) { throw "没有匹配到任何可裁剪的 jar（目录不对？）" }
$mb = [math]::Round(((Get-ChildItem $dirFull -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host "[trim] 完成，guard-libs 合计 ${mb}MB" -ForegroundColor Green
